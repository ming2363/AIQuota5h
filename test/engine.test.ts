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
