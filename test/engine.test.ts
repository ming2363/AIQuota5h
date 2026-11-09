import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Engine } from "../src/engine.js";
import { Store } from "../src/store.js";
import type { PoolFact, ProviderSnapshot, SendResult, WindowFact } from "../src/types.js";

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aiquota5h-engine-"));
  const store = new Store(path.join(dir, "state.sqlite"));
  const sends: string[] = [];
  const dirs: string[] = [];
  let now = 10_000_000;
  let current: ProviderSnapshot | null = null;
  const engine = new Engine({
    store,
    now: () => now,
    workDir: path.join(dir, "work"),
    log: () => undefined,
    read: async () => current ?? { provider: "codex", category: "unavailable", message: "无快照", retryAfterMs: 30_000 },
    send: async (pool, workDir): Promise<SendResult> => {
      assert.equal(fs.existsSync(workDir), true);
      dirs.push(workDir);
      sends.push(pool.poolId);
      return { outcome: "accepted", sessionId: "sess-1", detail: "ok", started: true };
    },
  });
  return {
    store,
    engine,
    sends,
    dirs,
    dir,
    setNow: (value: number) => { now = value; },
    setSnapshot: (value: ProviderSnapshot) => { current = value; },
  };
}

function idleWindow(oldEndedAt: number): WindowFact {
  return {
    key: "5h",
    kind: "session",
    activationMode: "usage_started",
    state: "idle",
    oldEndedAt,
    resetAt: null,
    allowance: "allowed",
    sharesRequest: true,
    evidence: ["server_past_boundary"],
    windowId: `5h:ended:${oldEndedAt}`,
  };
}

function snapshot(windows: WindowFact[], now: number): ProviderSnapshot {
  const pool: PoolFact = {
    provider: "codex",
    accountId: "acct",
    accountLabel: "a***@example.com",
    poolId: "codex",
    models: ["gpt-5.6-luna"],
    selectedModel: "gpt-5.6-luna",
    billingSafety: "subscription_only",
    billingEvidence: ["chatgpt"],
    windows,
    observedAt: now,
  };
  return {
    provider: "codex",
    accountId: "acct",
    accountLabel: "a***@example.com",
    authMode: "chatgpt",
    appCliConsistent: true,
    consistencyEvidence: "test",
    pools: [pool],
    observedAt: now,
    rawSummary: "{}",
  };
}

test("重复调度只领取一次", async () => {
  const ctx = setup();
  const snap = snapshot([idleWindow(ctx.store ? 9_000_000 : 0)], 10_000_000);
  ctx.setSnapshot(snap);
  ctx.engine.observe(snap);
  ctx.engine.observe(snap);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(ctx.sends.length, 1);
  ctx.store.close();
});

test("发送成功但验证仍为 idle 时不重发", async () => {
  const ctx = setup();
  const first = snapshot([idleWindow(9_000_000)], 10_000_000);
  ctx.setSnapshot(first);
  ctx.engine.observe(first);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const second = snapshot([idleWindow(9_000_000)], 10_050_000);
  ctx.setSnapshot(second);
  ctx.engine.observe(second);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(ctx.sends.length, 1);
  const task = ctx.store.recentTasks()[0];
  assert.equal(task?.status, "verifying");
  ctx.store.close();
});

test("验证读到 active 后确认", async () => {
  const ctx = setup();
  const first = snapshot([idleWindow(9_000_000)], 10_000_000);
  ctx.setSnapshot(first);
  ctx.engine.observe(first);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const active = snapshot([{
    ...idleWindow(9_000_000),
    state: "active",
    oldEndedAt: null,
    resetAt: 10_000_000 + 5 * 60 * 60_000,
  }], 10_050_000);
  ctx.setSnapshot(active);
  ctx.engine.observe(active);
  assert.equal(ctx.store.recentTasks()[0]?.status, "confirmed");
  ctx.store.close();
});

test("最终检查账号不一致时不向旧账号发送", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aiquota5h-engine-"));
  const store = new Store(path.join(dir, "state.sqlite"));
  const sends: string[] = [];
  const engine = new Engine({
    store,
    now: () => 10_000_000,
    workDir: dir,
    log: () => undefined,
    read: async () => { throw new Error("no"); },
    confirmAccount: async () => false,
    send: async () => {
      sends.push("sent");
      return { outcome: "accepted", sessionId: null, detail: "no", started: true };
    },
  });
  engine.observe(snapshot([idleWindow(9_000_000)], 10_000_000));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(sends.length, 0);
  assert.equal(store.recentTasks()[0]?.status, "blocked");
  assert.equal(store.recentTasks()[0]?.error_category, "account_mismatch");
  store.close();
});

test("暂停后不发送", async () => {
  const ctx = setup();
  ctx.store.setPaused(true);
  await ctx.engine.review("startup");
  assert.equal(ctx.sends.length, 0);
  ctx.store.close();
});

test("合盖跨多个周期只处理当前快照", async () => {
  const ctx = setup();
  ctx.setNow(20_000_000);
  const snap = snapshot([idleWindow(9_000_000)], 20_000_000);
  ctx.setSnapshot(snap);
  ctx.engine.observe(snap);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(ctx.store.recentTasks().length, 1);
  ctx.store.close();
});

test("未开始计时且查不到旧边界时，以首次观察时间为保守边界，宽限期后激活", async () => {
  const ctx = setup();
  // 服务端证明窗口未开始计时（重置时间随查询滑动），但没有旧窗口结束时间
  const unstarted = (): WindowFact => ({
    key: "5h",
    kind: "session",
    activationMode: "usage_started",
    state: "idle",
    oldEndedAt: null,
    resetAt: null,
    allowance: "allowed",
    sharesRequest: true,
    evidence: ["clock=sliding", "sliding_reset_matches_unstarted_window", "old_boundary_not_on_server"],
    windowId: "5h:unbounded",
  });
  const t0 = 10_000_000;
  ctx.setNow(t0);
  const first = snapshot([unstarted()], t0);
  ctx.setSnapshot(first);
  ctx.engine.observe(first);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(ctx.sends.length, 0, "首轮边界未知，不发送");
  const saved = ctx.store.priorWindow("codex", "acct", "codex", "5h");
  assert.equal(saved?.preserved_boundary, t0, "首轮记下首次观察时间");

  ctx.setNow(t0 + 60_000);
  const second = snapshot([unstarted()], t0 + 60_000);
  ctx.setSnapshot(second);
  ctx.engine.observe(second);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(ctx.sends.length, 0, "宽限期内不发送");

  ctx.setNow(t0 + 66_000);
  const third = snapshot([unstarted()], t0 + 66_000);
  ctx.setSnapshot(third);
  ctx.engine.observe(third);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(ctx.sends.length, 1, "边界 + 宽限期后激活一次");
  ctx.store.close();
});

test("到期但账号一致性未确认时不发送，记录原因，且一分钟内不再触发到期复查", async () => {
  const ctx = setup();
  const t0 = 10_000_000;
  ctx.setNow(t0);
  const snap = { ...snapshot([idleWindow(t0 - 120_000)], t0), appCliConsistent: null };
  ctx.setSnapshot(snap);
  ctx.engine.observe(snap);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(ctx.sends.length, 0);
  assert.match(ctx.store.recentEvents(5).map((item) => item.message).join("\n"), /decide:idle_due，未发送：/);
  ctx.setNow(t0 + 15_000);
  assert.equal(ctx.engine.shouldProbeDue(t0 + 15_000), false, "不能派发时不应每隔十几秒复查");
  ctx.store.close();
});

test("池子带有拦截原因时到期不发送，记录原因，且一分钟内不再触发到期复查", async () => {
  const ctx = setup();
  const t0 = 10_000_000;
  ctx.setNow(t0);
  const snap = snapshot([idleWindow(t0 - 120_000)], t0);
  snap.pools[0].blockReason = "agy 帮助缺少调用级隔离参数：plugins、mcp、hooks";
  ctx.setSnapshot(snap);
  ctx.engine.observe(snap);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(ctx.sends.length, 0);
  assert.match(ctx.store.recentEvents(5).map((item) => item.message).join("\n"), /未发送：agy 帮助缺少调用级隔离参数/);
  assert.equal(ctx.engine.shouldProbeDue(t0 + 15_000), false);
  ctx.store.close();
});

function weeklyAutoReset(resetAt: number): WindowFact {
  return {
    key: "weekly",
    kind: "weekly",
    activationMode: "auto_reset",
    state: "active",
    oldEndedAt: null,
    resetAt,
    allowance: "allowed",
    sharesRequest: true,
    evidence: ["clock=anchored", "auto_reset_no_grace"],
    windowId: `weekly:${resetAt}`,
  };
}

test("误按未开始发出的周任务：窗口在任务旧边界之前已按固定日程计时，核验时收尾且不再阻塞池子", async () => {
  const ctx = setup();
  const t0 = 10_000_000_000;
  const week = 7 * 24 * 60 * 60_000;
  const periodStart = t0 - 600_000;
  ctx.setNow(t0);
  const pool = snapshot([weeklyAutoReset(periodStart + week)], t0).pools[0];
  const [task] = ctx.store.claim(pool, [{ ...pool.windows[0], oldEndedAt: t0 - 60_000 }], t0 - 30_000);
  ctx.store.updateTasks([task.id], { status: "verifying", message_result: "accepted" }, t0 - 30_000);
  const snap = snapshot([weeklyAutoReset(periodStart + week)], t0);
  ctx.setSnapshot(snap);
  ctx.engine.observe(snap);
  const row = ctx.store.recentTasks().find((item) => item.id === task.id);
  assert.equal(row?.status, "skipped");
  assert.equal(row?.error_category, "not_needed");
  ctx.store.close();
});

test("正常到期接续任务：周期起点等于任务旧边界时不按“无需激活”收尾", async () => {
  const ctx = setup();
  const t0 = 10_000_000_000;
  const week = 7 * 24 * 60 * 60_000;
  const oldEnd = t0 - 120_000;
  ctx.setNow(t0);
  const pool = snapshot([weeklyAutoReset(oldEnd + week)], t0).pools[0];
  const [task] = ctx.store.claim(pool, [{ ...pool.windows[0], oldEndedAt: oldEnd }], t0 - 30_000);
  ctx.store.updateTasks([task.id], { status: "verifying", message_result: "accepted" }, t0 - 30_000);
  const snap = snapshot([weeklyAutoReset(oldEnd + week)], t0);
  ctx.setSnapshot(snap);
  ctx.engine.observe(snap);
  const row = ctx.store.recentTasks().find((item) => item.id === task.id);
  assert.notEqual(row?.error_category, "not_needed");
  ctx.store.close();
});

test("已接受但无法确认的任务：超过窗口时长加确认余量后收尾，下一周期可以激活", async () => {
  const ctx = setup();
  const sentAt = 10_000_000_000;
  const oldEnd = sentAt - 70_000;
  ctx.setNow(sentAt);
  const first = snapshot([idleWindow(oldEnd)], sentAt);
  const [task] = ctx.store.claim(first.pools[0], first.pools[0].windows, sentAt);
  ctx.store.updateTasks([task.id], { status: "stalled", message_result: "accepted" }, sentAt + 31 * 60_000);
  // 窗口结束后服务端仍只给出旧边界（请求启动的那个窗口从未被证明），历史上会永远阻塞
  const stillBlocked = snapshot([idleWindow(oldEnd)], sentAt + 60 * 60_000);
  ctx.setNow(sentAt + 60 * 60_000);
  ctx.setSnapshot(stillBlocked);
  ctx.engine.observe(stillBlocked);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(ctx.sends.length, 0, "窗口时长内保留防重发保护");
  const later = sentAt + 5 * 60 * 60_000 + 31 * 60_000;
  ctx.setNow(later);
  const next = snapshot([idleWindow(oldEnd)], later);
  ctx.setSnapshot(next);
  ctx.engine.observe(next);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const row = ctx.store.recentTasks().find((item) => item.id === task.id);
  assert.equal(row?.error_category, "period_elapsed");
  assert.equal(ctx.sends.length, 0, "收尾当轮仍沿用旧边界，被去重，不会重发");
  // 下一轮：以“发送时刻 + 窗口时长 + 确认余量”为新边界，进入新周期激活
  ctx.setNow(later + 60_000);
  const after = snapshot([idleWindow(oldEnd)], later + 60_000);
  ctx.setSnapshot(after);
  ctx.engine.observe(after);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(ctx.sends.length, 1, "旧任务收尾后进入新周期激活");
  ctx.store.close();
});

test("已确认的旧任务不会被按时长改写", async () => {
  const ctx = setup();
  const sentAt = 10_000_000_000;
  ctx.setNow(sentAt);
  const first = snapshot([idleWindow(sentAt - 70_000)], sentAt);
  const [task] = ctx.store.claim(first.pools[0], first.pools[0].windows, sentAt);
  ctx.store.updateTasks([task.id], { status: "confirmed", message_result: "accepted", window_result: "active" }, sentAt);
  const later = sentAt + 6 * 60 * 60_000;
  ctx.setNow(later);
  const snap = snapshot([idleWindow(sentAt - 70_000)], later);
  ctx.setSnapshot(snap);
  ctx.engine.observe(snap);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(ctx.store.recentTasks().find((item) => item.id === task.id)?.status, "confirmed");
  ctx.store.close();
});

test("连续两个未开始计时的周期都能激活：窗口编号随边界更新，不被第一次的任务去重", async () => {
  const ctx = setup();
  const unstarted = (): WindowFact => ({
    key: "5h",
    kind: "session",
    activationMode: "usage_started",
    state: "idle",
    oldEndedAt: null,
    resetAt: null,
    allowance: "allowed",
    sharesRequest: true,
    evidence: ["clock=sliding", "sliding_reset_matches_unstarted_window", "old_boundary_not_on_server"],
    windowId: "5h:unbounded",
  });
  const active = (resetAt: number): WindowFact => ({ ...unstarted(), state: "active", resetAt, evidence: ["usage_recorded_and_anchored_reset"], windowId: `5h:${resetAt}` });
  const step = async (at: number, windows: WindowFact[]) => {
    ctx.setNow(at);
    const snap = snapshot(windows, at);
    ctx.setSnapshot(snap);
    ctx.engine.observe(snap);
    await new Promise((resolve) => setTimeout(resolve, 30));
  };
  const t0 = 10_000_000_000;
  await step(t0, [unstarted()]);
  await step(t0 + 66_000, [unstarted()]);
  assert.equal(ctx.sends.length, 1, "第一个周期激活");
  // 第一个周期启动、5 小时后结束，再次进入未开始状态
  const reset = t0 + 70_000 + 5 * 60 * 60_000;
  await step(t0 + 120_000, [active(reset)]);
  const t1 = reset + 60_000;
  await step(t1, [unstarted()]);
  await step(t1 + 66_000, [unstarted()]);
  assert.equal(ctx.sends.length, 2, "第二个周期也激活");
  const ids = ctx.store.recentTasks().map((row) => row.expired_window_id);
  assert.ok(!ids.includes("5h:unbounded"), "任务不再使用占位窗口编号");
  ctx.store.close();
});
