import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Store } from "../src/store.js";
import type { PoolFact, WindowFact } from "../src/types.js";

function tempDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aiquota5h-"));
  return path.join(dir, "state.sqlite");
}

function pool(): PoolFact {
  const window: WindowFact = {
    key: "5h",
    kind: "session",
    activationMode: "usage_started",
    state: "idle",
    oldEndedAt: 1_000,
    resetAt: null,
    allowance: "allowed",
    sharesRequest: true,
    evidence: ["test"],
    windowId: "5h:ended:1000",
  };
  return {
    provider: "codex",
    accountId: "acct-1",
    accountLabel: "a***@example.com",
    poolId: "codex",
    models: ["gpt-5.6-luna"],
    selectedModel: "gpt-5.6-luna",
    billingSafety: "subscription_only",
    billingEvidence: ["test"],
    windows: [window],
    observedAt: 2_000,
  };
}

test("暂停跨存储实例有效", () => {
  const file = tempDb();
  const first = new Store(file);
  first.setPaused(true);
  first.close();
  const second = new Store(file);
  assert.equal(second.paused(), true);
  second.close();
});

test("并发领取同一任务只成功一次", () => {
  const file = tempDb();
  const left = new Store(file);
  const right = new Store(file);
  const fact = pool();
  const a = left.claim(fact, fact.windows, 5_000);
  const b = right.claim(fact, fact.windows, 5_000);
  assert.equal(a.length, 1);
  assert.equal(b.length, 0);
  left.close();
  right.close();
});

test("领取后未启动外部进程可以有限重试，已启动则只冻结本池", () => {
  const file = tempDb();
  const store = new Store(file);
  const fact = pool();
  const claimed = store.claim(fact, fact.windows, 5_000);
  assert.equal(claimed[0]?.phase, "claimed");
  store.close();
  const restarted = new Store(file);
  restarted.recoverInFlight(6_000);
  assert.equal(restarted.recentTasks()[0]?.status, "pending");
  const again = restarted.claim(fact, fact.windows, 7_000);
  restarted.setPhase(again.map((row) => row.id), "spawning", 7_100);
  restarted.close();
  const third = new Store(file);
  third.recoverInFlight(8_000);
  assert.equal(third.recentTasks()[0]?.status, "verifying");
  const other = { ...fact, poolId: "other-pool", windows: fact.windows.map((window) => ({ ...window, windowId: "other:ended:1000" })) };
  assert.equal(third.claim(other, other.windows, 9_000).length, 1);
  assert.equal(third.claim(fact, fact.windows, 9_000).length, 0);
  third.close();
});

test("换账号使旧任务失效，令牌刷新不改变账号标识", () => {
  const file = tempDb();
  const store = new Store(file);
  const fact = pool();
  store.claim(fact, fact.windows, 5_000);
  store.invalidateAccount("codex", "acct-1", 7_000);
  const tasks = store.recentTasks();
  assert.equal(tasks[0]?.status, "skipped");
  assert.equal(tasks[0]?.error_category, "account_changed");
  store.close();
});
