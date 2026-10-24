import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { printStatus } from "../src/cli.js";
import { Engine } from "../src/engine.js";
import { sendCodex } from "../src/providers/codex.js";
import { Store } from "../src/store.js";
import type { PoolFact, ProviderSnapshot, WindowFact } from "../src/types.js";
import { CONFIRM_SLACK_MS, VERIFY_STALL_MS, laterPeriodProven } from "../src/verify.js";

function idle(oldEndedAt: number, windowId = `5h:ended:${oldEndedAt}`, resetAt: number | null = null): WindowFact {
  return {
    key: "5h",
    kind: "session",
    activationMode: "usage_started",
    state: "idle",
    oldEndedAt,
    resetAt,
    allowance: "allowed",
    sharesRequest: true,
    evidence: ["server_past_boundary"],
    windowId,
  };
}

function snap(windows: WindowFact[], now: number, accountId = "acct"): ProviderSnapshot {
  const pool: PoolFact = {
    provider: "codex",
    accountId,
    accountLabel: "a",
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
    accountId,
    accountLabel: "a",
    authMode: "chatgpt",
    appCliConsistent: true,
    consistencyEvidence: "test",
    pools: [pool],
    observedAt: now,
    rawSummary: "{}",
  };
}

function open(nowRef: { now: number }, outcome: "accepted" | "unknown" = "accepted") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aiquota5h-stall-"));
  const store = new Store(path.join(root, "state.sqlite"));
  let sends = 0;
  const engine = new Engine({
    store,
    now: () => nowRef.now,
    workDir: root,
    log: () => undefined,
    read: async () => snap([idle(nowRef.now - 180_000)], nowRef.now),
    confirmAccount: async () => true,
    send: async () => {
      sends += 1;
      return { outcome, sessionId: "s", detail: outcome === "accepted" ? "模型回合已完成" : "连接中断", started: true };
    },
  });
  return {
    root,
    store,
    engine,
    sends: () => sends,
    cleanup: () => {
      engine.stop();
      store.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test("Codex 发送事件区分线程启动、回合完成和失败", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aiquota5h-codex-events-"));
  const script = path.join(root, "fake-codex");
  const mode = path.join(root, "mode");
  fs.writeFileSync(mode, "thread");
  fs.writeFileSync(script, `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv.includes("--help")) process.exit(0);
const mode = fs.readFileSync(${JSON.stringify(mode)}, "utf8");
if (mode === "thread") {
  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "thread-1" }) + "\\n");
  process.exit(0);
}
if (mode === "turn") {
  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "thread-2" }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 3, output_tokens: 1 } }) + "\\n");
  process.exit(0);
}
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "thread-3" }) + "\\n");
process.stderr.write("connection reset\\n");
process.exit(1);
`);
  fs.chmodSync(script, 0o755);
  const request = { provider: "codex" as const, accountId: "acct", poolId: "codex", model: "gpt-5.6-luna", prompt: "只回复 OK", workDir: root };
  const threadOnly = await sendCodex(request, script);
  assert.equal(threadOnly.outcome, "unknown");
  assert.equal(threadOnly.acceptance, "thread_only");
  assert.equal(threadOnly.started, true);
  assert.doesNotMatch(threadOnly.detail, /只回复 OK/);
  fs.writeFileSync(mode, "turn");
  const completed = await sendCodex(request, script);
  assert.equal(completed.outcome, "accepted");
  assert.equal(completed.acceptance, "turn_completed");
  assert.equal(completed.usageTokens, 4);
  assert.match(completed.detail, /窗口是否启动仍待额度观测/);
  fs.writeFileSync(mode, "fail");
  const failed = await sendCodex(request, script);
  assert.equal(failed.outcome, "unknown");
  assert.equal(failed.started, true);
  assert.notEqual(failed.acceptance, "turn_completed");
  fs.rmSync(root, { recursive: true, force: true });
});

test("接受后长期未确认会标明卡住且不重发，之后的手动 active 不算旧任务成功", async () => {
  const clock = { now: 20_000_000 };
  const ctx = open(clock);
  try {
    const first = snap([idle(clock.now - 180_000)], clock.now);
    ctx.engine.observe(first);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(ctx.sends(), 1);
    assert.equal(ctx.store.recentTasks()[0]?.status, "verifying");
    clock.now += VERIFY_STALL_MS + 1_000;
    ctx.engine.observe(snap([idle(20_000_000 - 180_000)], clock.now));
    assert.equal(ctx.store.recentTasks()[0]?.status, "stalled");
    assert.equal(ctx.store.recentTasks()[0]?.error_category, "verify_unresolved");
    assert.match(ctx.store.recentEvents().map((item) => item.message).join("\n"), /未领取/);
    assert.equal(ctx.sends(), 1);
    const sentAt = 20_000_000;
    clock.now = sentAt + 2 * 60 * 60_000;
    ctx.engine.observe(snap([{
      ...idle(20_000_000 - 180_000),
      state: "active",
      oldEndedAt: null,
      resetAt: sentAt + 2 * 60 * 60_000 + 5 * 60 * 60_000,
    }], clock.now));
    assert.notEqual(ctx.store.recentTasks()[0]?.status, "confirmed");
    assert.equal(ctx.store.recentTasks()[0]?.status, "skipped");
    assert.equal(ctx.store.recentTasks()[0]?.window_result, "unconfirmed");
    assert.match(ctx.store.recentTasks()[0]?.detail || "", /后续活跃窗口/);
    assert.equal(ctx.sends(), 1);
  } finally {
    ctx.cleanup();
  }
});

test("同周期边界校正数秒或改 windowId 不重发，重启也不重发", async () => {
  const clock = { now: 40_000_000 };
  const ctx = open(clock, "unknown");
  try {
    const boundary = clock.now - 180_000;
    ctx.engine.observe(snap([idle(boundary, `5h:ended:${boundary}`)], clock.now));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(ctx.sends(), 1);
    for (const delta of [1_000, 4_000]) {
      clock.now += 30_000;
      const corrected = boundary + delta;
      ctx.engine.observe(snap([idle(corrected, `5h:ended:${corrected}`)], clock.now));
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(ctx.sends(), 1, `${delta}ms 校正不能当成新周期`);
      assert.notEqual(ctx.store.recentTasks()[0]?.error_category, "period_unconfirmed");
    }
    const restarted = new Engine({
      store: ctx.store,
      now: () => clock.now,
      workDir: ctx.root,
      log: () => undefined,
      read: async () => snap([idle(boundary + 4_000, "renamed")], clock.now),
      send: async () => {
        throw new Error("同周期重启不应再发");
      },
    });
    restarted.recover();
    restarted.observe(snap([idle(boundary + 4_000, "renamed")], clock.now));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(ctx.sends(), 1);
    restarted.stop();
  } finally {
    ctx.cleanup();
  }
});

test("请求发出前已启动的窗口不能确认为本次成功", async () => {
  const clock = { now: 50_000_000 };
  const ctx = open(clock);
  try {
    ctx.engine.observe(snap([idle(clock.now - 180_000)], clock.now));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(ctx.sends(), 1);
    const sentAt = clock.now;
    ctx.engine.observe(snap([{
      ...idle(clock.now - 180_000),
      state: "active",
      oldEndedAt: null,
      resetAt: sentAt - 5 * 60_000 + 5 * 60 * 60_000,
    }], clock.now));
    assert.notEqual(ctx.store.recentTasks()[0]?.status, "confirmed");
    clock.now += 1_000;
    ctx.engine.observe(snap([{
      ...idle(sentAt - 180_000),
      state: "active",
      oldEndedAt: null,
      resetAt: sentAt + 5 * 60 * 60_000,
    }], clock.now));
    assert.equal(ctx.store.recentTasks()[0]?.status, "confirmed");
    assert.match(ctx.store.recentTasks()[0]?.detail || "", /started=/);
  } finally {
    ctx.cleanup();
  }
});

test("旧周期被证明结束后，新周期可以处理一次，同一未知请求不重复", async () => {
  const clock = { now: 30_000_000 };
  const ctx = open(clock, "unknown");
  try {
    ctx.engine.observe(snap([idle(clock.now - 180_000, "period-a")], clock.now));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(ctx.sends(), 1);
    assert.equal(ctx.store.recentTasks()[0]?.status, "unknown_result");
    ctx.engine.observe(snap([idle(clock.now - 180_000, "period-a")], clock.now));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(ctx.sends(), 1);
    const ended = clock.now + 5 * 60 * 60_000;
    clock.now = ended + 180_000;
    ctx.engine.observe(snap([idle(ended, "period-b")], clock.now));
    await new Promise((resolve) => setTimeout(resolve, 30));
    const tasks = ctx.store.recentTasks();
    assert.equal(tasks.filter((item) => item.expired_window_id === "period-a")[0]?.status, "skipped");
    assert.equal(tasks.filter((item) => item.expired_window_id === "period-a")[0]?.error_category, "period_unconfirmed");
    assert.notEqual(tasks.filter((item) => item.expired_window_id === "period-a")[0]?.status, "confirmed");
    assert.equal(ctx.sends(), 2);
    const restarted = new Engine({
      store: ctx.store,
      now: () => clock.now,
      workDir: ctx.root,
      log: () => undefined,
      read: async () => snap([idle(ended, "period-b")], clock.now),
      send: async () => {
        throw new Error("重启后不应再发");
      },
    });
    restarted.recover();
    restarted.observe(snap([idle(ended, "period-b")], clock.now));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(ctx.store.tasksByStatus(["in_flight"]).length, 0);
    restarted.stop();
  } finally {
    ctx.cleanup();
  }
});

test("后续活跃窗口必须已真实启动，未知状态、未来起点和短暂校正不能收尾", () => {
  const sentAt = 60_000_000;
  const task = { window_key: "5h", old_ended_at: sentAt - 180_000, claimed_at: sentAt };
  const now = sentAt + 2 * 60 * 60_000;
  const active = { ...idle(task.old_ended_at), state: "active" as const, oldEndedAt: null, resetAt: now + 5 * 60 * 60_000 };
  assert.equal(laterPeriodProven(task, active, now), true);
  assert.equal(laterPeriodProven(task, { ...active, state: "unknown" }, now), false);
  assert.equal(laterPeriodProven(task, { ...active, resetAt: now + 5 * 60 * 60_000 + 1_000 }, now), false);
  assert.equal(laterPeriodProven(task, { ...active, resetAt: sentAt + CONFIRM_SLACK_MS + 5 * 60 * 60_000 }, now), false);
  assert.equal(laterPeriodProven(task, { ...active, key: "weekly" }, now), false);
  assert.equal(laterPeriodProven(task, { ...active, activationMode: "unknown" }, now), false);
});

for (const outcome of ["accepted", "unknown"] as const) {
  test(`${outcome} 旧任务遇到后续活跃窗口自动收尾，重启及旧快照不重发，新周期只发一次`, async () => {
    const clock = { now: 80_000_000 };
    const ctx = open(clock, outcome);
    let restarted: Engine | undefined;
    try {
      const boundary = clock.now - 180_000;
      ctx.engine.observe(snap([idle(boundary, "original")], clock.now));
      await ctx.engine.drain();
      assert.equal(ctx.sends(), 1);
      clock.now += 2 * 60 * 60_000;
      const end = clock.now + 5 * 60 * 60_000;
      const active = { ...idle(boundary), state: "active" as const, oldEndedAt: null, resetAt: end };
      ctx.engine.observe(snap([active], clock.now));
      const old = ctx.store.recentTasks()[0]!;
      assert.equal(old.status, "skipped");
      assert.equal(old.window_result, "unconfirmed");
      assert.equal(old.message_result, outcome);
      assert.equal(old.attempt_count, 1);
      // A renamed or slightly corrected old snapshot cannot reopen a retired request.
      const stale = snap([idle(boundary + 4_000, "renamed-old")], clock.now);
      assert.equal(ctx.store.claim(stale.pools[0], stale.pools[0].windows, clock.now).length, 0);
      restarted = new Engine({
        store: ctx.store, now: () => clock.now, workDir: ctx.root, log: () => undefined,
        read: async () => stale,
        send: async () => { throw new Error("旧周期不可重发"); },
      });
      restarted.recover();
      restarted.observe(stale);
      assert.equal(restarted.shouldProbeDue(clock.now + 60_000), false);
      await restarted.drain();
      assert.equal(ctx.store.recentTasks()[0]?.attempt_count, 1);
      restarted.stop();
      clock.now = end + 180_000;
      ctx.engine.observe(snap([idle(end, "next-period")], clock.now));
      await ctx.engine.drain();
      assert.equal(ctx.sends(), 2);
      ctx.engine.observe(snap([idle(end, "next-period")], clock.now));
      await ctx.engine.drain();
      assert.equal(ctx.sends(), 2);
    } finally {
      restarted?.stop();
      ctx.cleanup();
    }
  });
}

test("状态区分后续活跃窗口与历史未确认，不误报正在阻塞", async () => {
  const clock = { now: Date.now() - 2 * 60 * 60_000 };
  const ctx = open(clock);
  const originalLog = console.log;
  const output: string[] = [];
  try {
    const boundary = clock.now - 180_000;
    ctx.engine.observe(snap([idle(boundary)], clock.now));
    await ctx.engine.drain();
    clock.now = Date.now() - 1_000;
    ctx.engine.observe(snap([{ ...idle(boundary), state: "active", oldEndedAt: null, resetAt: clock.now + 5 * 60 * 60_000 }], clock.now));
    console.log = (line) => { output.push(String(line)); };
    printStatus(ctx.store, ["进程: 运行中"]);
    const text = output.join("\n");
    assert.match(text, /窗口 5h: active/);
    assert.match(text, /历史未确认（已收尾）/);
    assert.doesNotMatch(text, /正在阻塞|防重发保护（历史请求待核验/);
  } finally {
    console.log = originalLog;
    ctx.cleanup();
  }
});

test("状态检查全部待核验任务，不遗漏最近十条之外的旧任务", async () => {
  const clock = { now: Date.now() };
  const ctx = open(clock);
  const originalLog = console.log;
  const output: string[] = [];
  try {
    ctx.engine.observe(snap([idle(clock.now - 180_000)], clock.now));
    await ctx.engine.drain();
    const insert = ctx.store.db.prepare("INSERT INTO tasks(provider,account_id,pool_id,expired_window_id,window_key,old_ended_at,due_at,status,updated_at) VALUES('codex','acct','other',?,'5h',0,0,'confirmed',?)");
    for (let n = 1; n <= 12; n++) insert.run(`history-${n}`, clock.now + n);
    console.log = (line) => { output.push(String(line)); };
    printStatus(ctx.store, ["进程: 运行中"]);
    assert.match(output.join("\n"), /防重发保护（历史请求待核验/);
    assert.match(output.join("\n"), /#1 verifying/);
  } finally {
    console.log = originalLog;
    ctx.cleanup();
  }
});
