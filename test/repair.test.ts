import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { classifyWindow } from "../src/decision.js";
import { Engine } from "../src/engine.js";
import { InstanceLock } from "../src/lock.js";
import { assessAgyIsolation, buildAgyArgs, parseAgySendOutput, parseAgyUsageTable, selectAgyModels } from "../src/providers/antigravity.js";
import { assessCodexBilling, buildCodexArgs, parseCodexArgs } from "../src/providers/codex.js";
import { Store } from "../src/store.js";
import type { PoolFact, ProviderSnapshot, WindowFact } from "../src/types.js";

const NOW = 10_000_000;

function idleWindow(oldEndedAt: number, key = "5h"): WindowFact {
  return {
    key,
    kind: "session",
    activationMode: "usage_started",
    state: "idle",
    oldEndedAt,
    resetAt: null,
    allowance: "allowed",
    sharesRequest: true,
    evidence: ["server_past_boundary"],
    windowId: `${key}:ended:${oldEndedAt}`,
  };
}

function snapshot(windows: WindowFact[], poolId = "codex"): ProviderSnapshot {
  const pool: PoolFact = {
    provider: "codex",
    accountId: "acct",
    accountLabel: "a",
    poolId,
    models: ["gpt-5.6-luna"],
    selectedModel: "gpt-5.6-luna",
    billingSafety: "subscription_only",
    billingEvidence: [],
    windows,
    observedAt: NOW,
  };
  return {
    provider: "codex",
    accountId: "acct",
    accountLabel: "a",
    authMode: "chatgpt",
    appCliConsistent: true,
    consistencyEvidence: "test",
    pools: [pool],
    observedAt: NOW,
    rawSummary: "{}",
  };
}

test("Codex 批准参数必须在 exec 之前，离线解析拒绝错误位置", () => {
  const bad = ["exec", "-a", "never", "--ignore-user-config", "-s", "read-only", "-C", "/tmp", "hi"];
  assert.equal(parseCodexArgs(bad).ok, false);
  assert.match(parseCodexArgs(bad).error || "", /-a/);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "aiquota5h-argv-"));
  const args = buildCodexArgs({ model: "gpt-5.6-luna", workDir: work, prompt: "只回复 OK" });
  const parsed = parseCodexArgs(args);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.workDir, work);
  assert.equal(args.includes("--dangerously-bypass-approvals-and-sandbox"), false);
});

test("全新目录下 argv 的 cwd 与实际创建目录一致", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aiquota5h-fresh-"));
  const store = new Store(path.join(root, "state.sqlite"));
  let seen = "";
  const snap = snapshot([idleWindow(NOW - 180_000)]);
  const engine = new Engine({
    store,
    now: () => NOW,
    workDir: path.join(root, "work"),
    log: () => undefined,
    read: async () => snap,
    send: async (_pool, workDir) => {
      seen = workDir;
      assert.equal(fs.existsSync(workDir), true);
      assert.equal(workDir.includes(`${path.sep}work${path.sep}`), true);
      assert.equal(fs.existsSync(path.join(root, "work", "send")), false);
      return { outcome: "not_sent", sessionId: null, detail: "测试不外发", started: false };
    },
  });
  engine.observe(snap);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.notEqual(seen, "");
  store.close();
});

test("缺少 credits 字段不能当成余额 0", () => {
  const missing = assessCodexBilling({ authMode: "chatgpt", hasApiKey: false, plan: "plus", snapshot: { planType: "plus" } });
  assert.equal(missing.billingSafety, "billing_safety_unknown");
  const nan = assessCodexBilling({ authMode: "chatgpt", hasApiKey: false, plan: "plus", snapshot: { credits: { hasCredits: false, balance: "nope" } } });
  assert.equal(nan.billingSafety, "billing_safety_unknown");
  const zero = assessCodexBilling({ authMode: "chatgpt", hasApiKey: false, plan: "plus", snapshot: { credits: { hasCredits: false, balance: "0" } } });
  assert.equal(zero.billingSafety, "subscription_only");
  const api = assessCodexBilling({ authMode: "api", hasApiKey: true, plan: "plus", snapshot: { credits: { hasCredits: false, balance: "0" } } });
  assert.equal(api.billingSafety, "billing_safety_unknown");
});

test("核对账号期间暂停或窗口已激活都不再发送", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aiquota5h-pause-"));
  const store = new Store(path.join(root, "state.sqlite"));
  let sends = 0;
  let current = snapshot([idleWindow(NOW - 180_000)]);
  const engine = new Engine({
    store,
    now: () => NOW,
    workDir: path.join(root, "work"),
    log: () => undefined,
    read: async () => current,
    confirmAccount: async () => {
      store.setPaused(true);
      current = snapshot([{ ...idleWindow(NOW - 180_000), state: "active", oldEndedAt: null }]);
      return true;
    },
    send: async () => {
      sends += 1;
      return { outcome: "accepted", sessionId: null, detail: "no", started: true };
    },
  });
  engine.observe(current);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(store.paused(), true);
  assert.equal(sends, 0);
  assert.equal(store.recentTasks()[0]?.message_result, "not_sent");
  store.close();
});

test("核对期间用户已激活则不再发送", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aiquota5h-active-"));
  const store = new Store(path.join(root, "state.sqlite"));
  let sends = 0;
  let current = snapshot([idleWindow(NOW - 180_000)]);
  const engine = new Engine({
    store,
    now: () => NOW,
    workDir: path.join(root, "work"),
    log: () => undefined,
    read: async () => current,
    confirmAccount: async () => {
      current = snapshot([{ ...idleWindow(NOW - 180_000), state: "active", oldEndedAt: null, resetAt: NOW + 60_000 }]);
      return true;
    },
    send: async () => {
      sends += 1;
      return { outcome: "accepted", sessionId: null, detail: "no", started: true };
    },
  });
  engine.observe(snapshot([idleWindow(NOW - 180_000)]));
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(sends, 0);
  assert.equal(store.recentTasks()[0]?.status, "skipped");
  store.close();
});

test("Retry-After 不会被 due 在 5 秒后绕过，慢读不叠加", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aiquota5h-backoff-"));
  const store = new Store(path.join(root, "state.sqlite"));
  let now = 1_000;
  let reads = 0;
  let release = (): void => { throw new Error("读取没有挂起"); };
  const engine = new Engine({
    store,
    now: () => now,
    workDir: root,
    log: () => undefined,
    read: () => {
      reads += 1;
      if (reads === 1) {
        return new Promise((resolve) => {
          release = () => resolve({ provider: "codex", category: "rate_limited", message: "429", retryAfterMs: 300_000 });
        });
      }
      return Promise.resolve({ provider: "codex", category: "rate_limited", message: "429", retryAfterMs: 300_000 });
    },
    send: async () => ({ outcome: "not_sent", sessionId: null, detail: "no", started: false }),
  });
  const first = engine.enqueue("codex", "startup");
  const second = engine.enqueue("codex", "due");
  assert.equal(reads, 1);
  release();
  await first;
  await second;
  assert.equal(reads, 1);
  now += 5_000;
  await engine.enqueue("codex", "due");
  assert.equal(reads, 1);
  now += 300_000;
  await engine.enqueue("codex", "due");
  assert.equal(reads, 2);
  store.close();
});

test("agy 用量文本和隔离判断可离线验证", () => {
  const groups = parseAgyUsageTable("Gemini Models\tFive Hour Limit Remaining\t100%\t2026-10-16T19:21:10Z\nClaude and GPT models\tWeekly Limit Remaining\t24%\t2026-10-19T10:51:24Z\n");
  assert.equal(groups[0]?.buckets?.[0]?.remainingFraction, 1);
  assert.equal(groups[1]?.buckets?.[0]?.remainingFraction, 0.24);
  assert.equal(parseAgyUsageTable("Gemini Models\tWeekly Limit Remaining\t76%\t2026-10-23T00:00:00Z\n")[0]?.buckets?.[0]?.remainingFraction, 0.76);
  assert.equal(parseAgyUsageTable("Gemini Models\tWeekly Limit Remaining\t0%\t2026-10-23T00:00:00Z\n")[0]?.buckets?.[0]?.remainingFraction, 0);
  assert.equal(parseAgyUsageTable("Gemini Models\tWeekly Limit Remaining\tabc\t2026-10-23T00:00:00Z\n")[0]?.buckets?.[0]?.remainingFraction, undefined);
  assert.equal(assessAgyIsolation("Usage of agy:\n  --sandbox\n").ok, false);
  assert.equal(assessAgyIsolation("  --disable-mcp\n").ok, false);
  assert.equal(assessAgyIsolation("  --no-plugin\n  --disable-mcp\n  --disable-hooks\n").ok, false);
  assert.equal(assessAgyIsolation("  --no-plugins\n  --disable-mcp\n  --disable-hooks\n").ok, true);
  assert.equal(assessAgyIsolation("  --no-plugins\n  --disable-mcp\n  --disable-hooks\n").extraArgs.includes("--no-plugin"), false);
  assert.equal(assessAgyIsolation("  --disable-plugins\n  --disable-mcp\n  --disable-hooks\n").ok, true);
  assert.deepEqual(assessAgyIsolation("  --disable-plugins\n  --disable-mcp\n  --disable-hooks\n").extraArgs, ["--disable-plugins", "--disable-mcp", "--disable-hooks"]);
  assert.equal(assessAgyIsolation("").ok, false);
  assert.equal(selectAgyModels("claude-sonnet-5-5-low\tClaude\nclaude-opus-5-5-high\tOpus\n")["claude-gpt"], "claude-sonnet-5-5-low");
  const args = buildAgyArgs({ provider: "antigravity", accountId: "a@b.c", poolId: "claude-gpt", model: "claude-sonnet-5-5-low", prompt: "OK", workDir: "/tmp/empty" }, ["--disable-plugins"]);
  assert.equal(args.includes("--disable-plugins"), true);
  assert.equal(args.includes("--dangerously-skip-permissions"), false);
  assert.equal(parseAgySendOutput('{"status":"SUCCESS","conversation_id":"c1"}').accepted, true);
});

test("双进程锁恰好一个获得，失效锁可恢复且旧释放不删新锁", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aiquota5h-lock-"));
  const lockPath = path.join(dir, "daemon.lock");
  const worker = path.resolve("dist/src/lock-worker.js");
  const run = (mode: string, hold = "700") => new Promise<string>((resolve) => {
    const child = spawn(process.execPath, [worker, lockPath, mode, hold], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk.toString(); });
    child.on("close", () => resolve(out.trim()));
  });
  const [first, second] = await Promise.all([run("hold", "600"), run("hold", "600")]);
  assert.deepEqual([first, second].sort(), ["acquired", "busy"]);
  await run("exit-without-release");
  const recovered = await run("release-now");
  assert.equal(recovered, "acquired");
  assert.equal(fs.existsSync(lockPath), true);
});

test("过期正使用率分类保持 unknown", () => {
  const classified = classifyWindow({
    key: "5h",
    kind: "session",
    resetAt: NOW - 1_000,
    durationMs: 300_000,
    usedPercent: 12,
    remainingFraction: 0.88,
    usageText: "",
    clock: "anchored",
    activationHint: "usage_started",
    sharesRequest: true,
  }, null, NOW);
  assert.equal(classified.state, "unknown");
});

test("发送前断网或暂停后，未发出的任务可以恢复；未知结果不能重发", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aiquota5h-recover-"));
  const store = new Store(path.join(root, "state.sqlite"));
  let sends = 0;
  let failRead = true;
  const snap = snapshot([idleWindow(NOW - 180_000)]);
  const engine = new Engine({
    store,
    now: () => NOW,
    workDir: path.join(root, "work"),
    log: () => undefined,
    read: async () => failRead
      ? { provider: "codex", category: "network", message: "断网", retryAfterMs: 0 }
      : snap,
    send: async () => {
      sends += 1;
      return { outcome: "accepted", sessionId: "s", detail: "ok", started: true };
    },
  });
  engine.observe(snap);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(sends, 0);
  assert.equal(store.recentTasks()[0]?.status, "deferred");
  assert.equal(store.recentTasks()[0]?.error_category, "refresh_failed");
  failRead = false;
  engine.observe(snap);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(sends, 1);
  store.close();

  const pausedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aiquota5h-resume-"));
  const pausedStore = new Store(path.join(pausedRoot, "state.sqlite"));
  let pausedSends = 0;
  const pausedEngine = new Engine({
    store: pausedStore,
    now: () => NOW,
    workDir: path.join(pausedRoot, "work"),
    log: () => undefined,
    read: async () => snap,
    confirmAccount: async () => {
      pausedStore.setPaused(true);
      return true;
    },
    send: async () => {
      pausedSends += 1;
      return { outcome: "accepted", sessionId: null, detail: "no", started: true };
    },
  });
  pausedEngine.observe(snap);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(pausedSends, 0);
  assert.equal(pausedStore.recentTasks()[0]?.error_category, "paused");
  pausedStore.setPaused(false);
  const resumed = new Engine({
    store: pausedStore,
    now: () => NOW,
    workDir: path.join(pausedRoot, "work"),
    log: () => undefined,
    read: async () => snap,
    send: async () => {
      pausedSends += 1;
      return { outcome: "unknown", sessionId: "u", detail: "不确定", started: true };
    },
  });
  resumed.observe(snap);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(pausedSends, 1);
  assert.equal(pausedStore.recentTasks()[0]?.status, "unknown_result");
  resumed.observe(snap);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(pausedSends, 1);
  pausedStore.close();
});

test("第二次账号检查期间窗口变 active 后不发送旧授权", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aiquota5h-stale-"));
  const store = new Store(path.join(root, "state.sqlite"));
  let checks = 0;
  let release: () => void = () => undefined;
  let sends = 0;
  const idle = snapshot([idleWindow(NOW - 180_000)]);
  const active = snapshot([{ ...idleWindow(NOW - 180_000), state: "active", oldEndedAt: null, resetAt: NOW + 60_000 }]);
  const engine = new Engine({
    store,
    now: () => NOW,
    workDir: path.join(root, "work"),
    log: () => undefined,
    read: async () => idle,
    confirmAccount: () => {
      checks += 1;
      if (checks === 2) return new Promise((resolve) => { release = () => resolve(true); });
      return Promise.resolve(true);
    },
    send: async () => {
      sends += 1;
      return { outcome: "accepted", sessionId: null, detail: "no", started: true };
    },
  });
  engine.observe(idle);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(checks, 2);
  engine.observe(active);
  release();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(sends, 0);
  store.close();
});

test("最终复核与 refresh 共享读取，429 进入统一退避", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aiquota5h-share-"));
  const store = new Store(path.join(root, "state.sqlite"));
  let now = NOW;
  let reads = 0;
  let concurrent = 0;
  let maxConcurrent = 0;
  let release: () => void = () => undefined;
  const snap = snapshot([idleWindow(NOW - 180_000)]);
  const engine = new Engine({
    store,
    now: () => now,
    workDir: path.join(root, "work"),
    log: () => undefined,
    read: () => {
      reads += 1;
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      return new Promise((resolve) => {
        release = () => {
          concurrent -= 1;
          resolve({ provider: "codex", category: "rate_limited", message: "429", retryAfterMs: 300_000 });
        };
      });
    },
    send: async () => ({ outcome: "not_sent", sessionId: null, detail: "no", started: false }),
  });
  engine.observe(snap);
  await new Promise((resolve) => setTimeout(resolve, 15));
  const joined = engine.enqueue("codex", "refresh");
  assert.equal(reads, 1);
  release();
  await joined;
  assert.equal(maxConcurrent, 1);
  now += 5_000;
  await engine.enqueue("codex", "due");
  assert.equal(reads, 1);
  store.close();
});

test("内核锁持有期间另一个实例不能获得", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aiquota5h-reclaim-"));
  const lockPath = path.join(dir, "daemon.lock");
  let releaseSlow: () => void = () => undefined;
  let entered: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const slow = new InstanceLock(lockPath, {
    afterHeld: () => {
      entered();
      return new Promise((done) => { releaseSlow = () => done(undefined); });
    },
  });
  const pending = slow.acquire();
  await ready;
  assert.equal(await new InstanceLock(lockPath).acquire(), "busy");
  releaseSlow();
  assert.equal(await pending, "acquired");
  assert.equal(await new InstanceLock(lockPath).acquire(), "busy");
  await slow.release();
  const next = new InstanceLock(lockPath);
  assert.equal(await next.acquire(), "acquired");
  await next.release();
});
