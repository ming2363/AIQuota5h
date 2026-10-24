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

test("升级到 65 秒同步旧计划，已发请求和历史去重记录保持不变", () => {
  const file = tempDb();
  const first = new Store(file);
  const fact = pool();
  first.savePool(fact, "{}");
  const pending = first.claim(fact, fact.windows, 100_000)[0];
  first.updateTasks([pending.id], { status: "deferred", message_result: "not_sent" }, 100_000);
  const sentFact = { ...fact, poolId: "sent", windows: fact.windows.map((w) => ({ ...w, windowId: "sent:old" })) };
  const sent = first.claim(sentFact, sentFact.windows, 100_000)[0];
  first.updateTasks([sent.id], { status: "verifying", message_result: "accepted" }, 100_000);
  first.setPhase([sent.id], "spawned", 100_000);
  first.db.prepare("UPDATE windows SET due_at = old_ended_at + 120000").run();
  first.db.prepare("UPDATE tasks SET due_at = old_ended_at + 120000").run();
  first.setMeta("gracePolicyMs", "120000");
  const prior = first.recentTasks(10).map(({ id, attempt_count, message_result }) => ({ id, attempt_count, message_result }));
  first.close();

  const second = new Store(file);
  assert.equal(second.allWindows()[0].due_at, 66_000);
  assert.equal(second.recentTasks().find((row) => row.id === pending.id)?.due_at, 66_000);
  assert.equal(second.recentTasks().find((row) => row.id === sent.id)?.due_at, 121_000);
  assert.deepEqual(second.recentTasks(10).map(({ id, attempt_count, message_result }) => ({ id, attempt_count, message_result })), prior);
  assert.equal(second.getMeta("gracePolicyMs"), "65000");
  assert.equal(second.claim(sentFact, sentFact.windows, 200_000).length, 0);
  second.close();
});

test("新快照、保留旧边界与领取任务的计划时间统一使用 65 秒", () => {
  const store = new Store(tempDb());
  const fact = pool();
  store.savePool(fact, "{}");
  assert.equal(store.allWindows()[0].due_at, 66_000);
  store.savePool({ ...fact, windows: fact.windows.map((w) => ({ ...w, state: "unknown", oldEndedAt: null })) }, "{}");
  assert.equal(store.allWindows()[0].due_at, 66_000);
  assert.equal(store.claim(fact, fact.windows, 66_000)[0].due_at, 66_000);
  store.close();
});
