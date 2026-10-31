import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { updateControl, requestRefresh } from "../src/controls.js";
import { dashboard, readHistory, taskHistory } from "../src/dashboard.js";
import { Engine } from "../src/engine.js";
import { claudeProxyConfigured, mapClaudeUsage, readClaude } from "../src/providers/claude.js";
import { Store } from "../src/store.js";
import type { ProviderSnapshot } from "../src/types.js";

const NOW = 50_000_000;
function fixture(t: { after: (fn: () => void) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aiquota5h-dashboard-"));
  const db = path.join(dir, "state.sqlite");
  const store = new Store(db);
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const snapshot: ProviderSnapshot = {
    provider: "codex", accountId: "account-current", accountLabel: "private@example.com", authMode: "chatgpt", appCliConsistent: true,
    consistencyEvidence: "test", observedAt: NOW, rawSummary: "must-not-be-exposed-sk-secret-12345678901234567890",
    pools: [{ provider: "codex", accountId: "account-current", accountLabel: "private@example.com", poolId: "codex", models: ["test-model"], selectedModel: "test-model", billingSafety: "subscription_only", billingEvidence: [], observedAt: NOW,
      windows: [{ key: "5h", kind: "session", state: "idle", activationMode: "usage_started", oldEndedAt: NOW - 200_000, resetAt: null, allowance: "allowed", remainingFraction: 0.42, sharesRequest: true, evidence: ["server_past_boundary"], windowId: "5h:old" }] }],
  };
  store.savePool(snapshot.pools[0], snapshot.rawSummary);
  return { dir, db, store, snapshot };
}

test("开关跨进程持久化，校验渠道、额度池，Claude 可单独开关", (t) => {
  const { store, db } = fixture(t);
  updateControl(store, ["monitor", "codex", "off"]);
  updateControl(store, ["activate", "codex", "off", "codex"]);
  const second = new Store(db);
  try {
    assert.equal(second.monitoring("codex"), false);
    assert.equal(second.activating("codex", "codex"), false);
    updateControl(second, ["monitor", "codex", "on"]);
    assert.equal(store.monitoring("codex"), true);
    assert.equal(store.activating("codex", "codex"), false);
    assert.throws(() => updateControl(store, ["monitor", "bogus", "on"]));
    assert.throws(() => updateControl(store, ["monitor", "codex", "true"]));
    assert.throws(() => updateControl(store, ["activate", "codex", "on", "unknown-pool"]));
    const claude = mapClaudeUsage({ five_hour: { utilization: 10, resets_at: new Date(NOW + 10_000).toISOString() } }, "claude-account", "c", NOW);
    store.savePool(claude.pools[0], "");
    updateControl(store, ["activate", "claude", "on", "claude-subscription"]);
    assert.equal(second.activating("claude", "claude-subscription"), true);
    assert.equal(dashboard(store, true, NOW).pools.find((p) => p.provider === "claude")?.activationSupported, true);
    updateControl(store, ["activate", "claude", "off", "claude-subscription"]);
    assert.equal(second.activating("claude", "claude-subscription"), false);
  } finally { second.close(); }
});

test("关闭激活仍读取额度，关闭渠道后不再开始读取或领取", async (t) => {
  const { store, snapshot, dir } = fixture(t);
  let reads = 0, sends = 0;
  const engine = new Engine({ store, now: () => NOW, workDir: dir, log: () => {}, read: async () => { reads++; return snapshot; }, send: async () => { sends++; return { outcome: "accepted", sessionId: null, detail: "", started: true }; } });
  updateControl(store, ["activate", "codex", "off", "codex"]);
  await engine.enqueue("codex", "manual");
  await engine.drain();
  assert.equal(reads, 1); assert.equal(sends, 0);
  updateControl(store, ["monitor", "codex", "off"]);
  await engine.enqueue("codex", "manual");
  assert.equal(reads, 1);
  assert.deepEqual(store.claim(snapshot.pools[0], snapshot.pools[0].windows, NOW), []);
  assert.equal(engine.shouldProbeDue(), false);
  engine.stop();
});

test("账号核对期间关闭激活会阻止已领取但未发送的请求", async (t) => {
  const { store, snapshot, dir } = fixture(t);
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let sends = 0;
  const engine = new Engine({ store, now: () => NOW, workDir: dir, log: () => {}, read: async () => snapshot,
    confirmAccount: async () => { entered(); await gate; return true; },
    send: async () => { sends++; return { outcome: "accepted", sessionId: null, detail: "", started: true }; } });
  engine.observe(snapshot);
  await started;
  updateControl(store, ["activate", "codex", "off", "codex"]);
  release(); await engine.drain();
  assert.equal(sends, 0);
  assert.equal(store.recentTasks()[0].message_result, "not_sent");
  engine.stop();
});

test("额度读取进行中关闭渠道，不会根据晚到快照开始激活", async (t) => {
  const { store, snapshot, dir } = fixture(t);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let sends = 0;
  const engine = new Engine({ store, now: () => NOW, workDir: dir, log: () => {}, read: async () => { await gate; return snapshot; }, send: async () => { sends++; return { outcome: "accepted", sessionId: null, detail: "", started: true }; } });
  const job = engine.enqueue("codex", "refresh");
  updateControl(store, ["monitor", "codex", "off"]);
  release(); await job; await engine.drain();
  assert.equal(sends, 0); assert.equal(readHistory(store).total, 1);
  engine.stop();
});

test("页面保存真实百分比、隐藏原始响应与旧账号，刷新请求可见", (t) => {
  const { store, snapshot } = fixture(t);
  store.savePool({ ...snapshot.pools[0], accountId: "old-account", accountLabel: "old@example.com" }, "private");
  store.setMeta("account:codex", snapshot.accountId);
  const data = dashboard(store, true, NOW);
  assert.equal(data.pools.length, 1);
  assert.equal(data.pools[0].windows[0].remainingFraction, 0.42);
  const text = JSON.stringify(data);
  assert.equal(text.includes("private@example.com"), false);
  assert.equal(text.includes("must-not-be-exposed"), false);
  assert.equal(data.pools[0].stale, false);
  assert.equal(dashboard(store, true, NOW + 181_000).pools[0].stale, true);
  requestRefresh(store);
  assert.equal(dashboard(store, true, NOW).refreshPending, true);
  store.setMeta("refreshAcknowledged", store.getMeta("refreshRequested")!);
  assert.equal(dashboard(store, true, NOW).refreshPending, false);
});

test("页面区分官方自动重置与需要激活的窗口，限流重试时间可见", (t) => {
  const { store, snapshot } = fixture(t);
  store.setMeta("readRetryAt:codex", String(NOW + 600_000));
  store.savePool({ ...snapshot.pools[0], provider: "grok", poolId: "supergrok-weekly", windows: [{ ...snapshot.pools[0].windows[0], key: "weekly", activationMode: "auto_reset", sharesRequest: false }] }, "");
  const data = dashboard(store, true, NOW);
  assert.equal(data.pools.find((p) => p.provider === "grok")?.activationSupported, false);
  assert.equal(data.pools.find((p) => p.provider === "codex")?.activationSupported, true);
  assert.equal(data.pools.find((p) => p.provider === "codex")?.nextRetryAt, NOW + 600_000);
  assert.equal(data.providers.find((p) => p.id === "claude")?.refreshIntervalMs, 120_000);
});

test("历史分页无截断；读请求去重、超时和重启中断有真实结果", async (t) => {
  const { store, snapshot, dir } = fixture(t);
  for (let i = 0; i < 65; i++) {
    const id = store.startRead("codex", "manual", NOW + i);
    store.finishRead(id, "ok", "test", NOW + i + 1);
  }
  assert.equal(readHistory(store).total, 65);
  assert.equal(readHistory(store, 60).items.length, 5);
  assert.notEqual(readHistory(store, 0).items[0].id, readHistory(store, 30).items[0].id);
  store.setMeta("activate:codex:codex", "0");
  let reads = 0;
  const engine = new Engine({ store, now: () => NOW, workDir: dir, readTimeoutMs: 15, log: () => {}, read: async () => { reads++; return new Promise(() => {}); }, send: async () => { throw Error("must not send"); } });
  await Promise.all([engine.enqueue("codex", "manual"), engine.enqueue("codex", "manual")]);
  assert.equal(reads, 1);
  const latest = readHistory(store).items[0];
  assert.equal(latest.status, "unavailable"); assert.match(String(latest.detail), /超时/);
  store.startRead("grok", "refresh", NOW);
  engine.recover();
  assert.equal(readHistory(store).items[0].status, "interrupted");
  engine.stop();
  assert.equal(taskHistory(store).total, 0);
});

test("Claude 官方额度映射正确，缺失和异常值不冒充余额", () => {
  const result = mapClaudeUsage({ five_hour: { utilization: 25, resets_at: new Date(NOW + 10_000).toISOString() }, seven_day: { utilization: 100, resets_at: null }, seven_day_sonnet: { utilization: "50" } }, "account", "c", NOW);
  assert.deepEqual(result.pools[0].windows.map((window) => window.remainingFraction), [0.75, 0, null]);
  assert.equal(result.pools[0].billingSafety, "billing_safety_unknown");
  assert.throws(() => mapClaudeUsage({}, "account", "c", NOW));
});

test("Claude 代理配置只报告不可读取，不访问钥匙串或额度接口", async (t) => {
  const { dir } = fixture(t);
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://example.invalid" } }));
  assert.equal(claudeProxyConfigured(dir, {}), true);
  const result = await readClaude({ configDir: dir });
  assert.ok("category" in result); assert.match(result.message, /代理/);
  fs.writeFileSync(path.join(dir, "settings.json"), "{}");
  assert.equal(claudeProxyConfigured(dir, {}), false);
});

test("原生界面桥接命令输出可解析 JSON，无效指令拒绝", (t) => {
  const { dir } = fixture(t);
  const script = path.resolve("dist/src/index.js");
  const env = { ...process.env, AIQUOTA5H_HOME: dir, NODE_NO_WARNINGS: "1" };
  const invoke = (...args: string[]) => JSON.parse(execFileSync(process.execPath, [script, ...args], { env, encoding: "utf8" }));
  assert.equal(invoke("dashboard").version, 1);
  assert.equal(invoke("reads").total, 0);
  assert.equal(invoke("history").total, 0);
  assert.equal(invoke("control", "monitor", "codex", "off").ok, true);
  assert.equal(invoke("dashboard").providers.find((p: { id: string }) => p.id === "codex").monitoring, false);
  const invalid = spawnSync(process.execPath, [script, "history", "-1"], { env, encoding: "utf8" });
  assert.equal(invalid.status, 1);
});
