import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Engine } from "../src/engine.js";
import { InstanceLock } from "../src/lock.js";
import { runCommand } from "../src/proc.js";
import { mapCodexPools } from "../src/providers/codex.js";
import { sendGrok } from "../src/providers/grok.js";
import { createProviderRead } from "../src/runtime.js";
import { Store } from "../src/store.js";
import type { PoolFact, ProviderSnapshot, WindowFact } from "../src/types.js";

const NOW = 20_000_000;

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

function snapshot(windows: WindowFact[]): ProviderSnapshot {
  const pool: PoolFact = {
    provider: "codex",
    accountId: "acct",
    accountLabel: "a",
    poolId: "codex",
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

function catalogFailure(): ProviderSnapshot {
  const partial = mapCodexPools({
    accountId: "acct",
    email: "a@example.com",
    plan: "plus",
    limits: {
      rateLimits: {
        planType: "plus",
        credits: { hasCredits: false, balance: "0" },
        primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: Math.floor((NOW - 180_000) / 1000) },
      },
    },
    models: [],
    selected: null,
    now: NOW,
    priors: [],
    authMode: "chatgpt",
    hasApiKey: false,
  });
  assert.equal(partial[0]?.selectedModel, null);
  assert.equal(partial[0]?.blockReason, "model_unknown");
  assert.equal(partial[0]?.billingSafety, "subscription_only");
  const failed = snapshot([idleWindow(NOW - 180_000)]);
  failed.pools[0].selectedModel = partial[0].selectedModel;
  failed.pools[0].blockReason = partial[0].blockReason;
  failed.pools[0].models = partial[0].models;
  return failed;
}

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("等待超时");
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

test("模型目录暂时失败后，同窗口恢复只发送一次", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aiquota5h-model-"));
  const store = new Store(path.join(root, "state.sqlite"));
  let now = NOW;
  let modelReady = false;
  let sends = 0;
  const idle = snapshot([idleWindow(NOW - 180_000)]);
  const failed = catalogFailure();
  const engine = new Engine({
    store,
    now: () => now,
    workDir: path.join(root, "work"),
    log: () => undefined,
    read: async () => modelReady ? idle : failed,
    confirmAccount: async () => true,
    send: async () => {
      sends += 1;
      return { outcome: "accepted", sessionId: "s", detail: "ok", started: true };
    },
  });
  engine.observe(idle);
  await waitFor(() => store.recentTasks()[0]?.status === "deferred");
  assert.equal(sends, 0);
  assert.equal(store.recentTasks()[0]?.error_category, "model_unknown");
  assert.equal(store.recentTasks()[0]?.message_result, "not_sent");
  assert.equal(store.recentTasks()[0]?.attempt_count, 1);
  now += 60_000;
  modelReady = true;
  engine.observe(idle);
  await waitFor(() => sends === 1);
  engine.observe(idle);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(sends, 1);
  assert.equal(store.recentTasks()[0]?.status, "verifying");
  store.close();
});

test("费用未知或窗口已激活的最终复核不会补发", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aiquota5h-keep-"));
  const store = new Store(path.join(root, "state.sqlite"));
  let now = NOW;
  let sends = 0;
  const idle = snapshot([idleWindow(NOW - 180_000)]);
  const billing = snapshot([idleWindow(NOW - 180_000)]);
  billing.pools[0].billingSafety = "billing_safety_unknown";
  const active = snapshot([{ ...idleWindow(NOW - 180_000), state: "active", oldEndedAt: null }]);
  let current = billing;
  const engine = new Engine({
    store,
    now: () => now,
    workDir: path.join(root, "work"),
    log: () => undefined,
    read: async () => current,
    confirmAccount: async () => true,
    send: async () => {
      sends += 1;
      return { outcome: "accepted", sessionId: "s", detail: "ok", started: true };
    },
  });
  engine.observe(idle);
  await waitFor(() => store.recentTasks()[0]?.status === "skipped");
  assert.equal(store.recentTasks()[0]?.error_category, "billing_safety_unknown");
  now += 120_000;
  current = idle;
  engine.observe(idle);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(sends, 0);

  const activeStore = new Store(path.join(root, "active.sqlite"));
  const activeEngine = new Engine({
    store: activeStore,
    now: () => now,
    workDir: path.join(root, "work-active"),
    log: () => undefined,
    read: async () => active,
    confirmAccount: async () => true,
    send: async () => {
      sends += 1;
      return { outcome: "accepted", sessionId: "s", detail: "ok", started: true };
    },
  });
  activeEngine.observe(idle);
  await waitFor(() => activeStore.recentTasks()[0]?.status === "skipped");
  now += 120_000;
  activeEngine.observe(idle);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(sends, 0);
  store.close();
  activeStore.close();
});

function writeStubborn(dir: string): { parent: string; grandchild: string; pidFile: string } {
  const grandchild = path.join(dir, "grandchild.mjs");
  const parent = path.join(dir, "parent.mjs");
  const pidFile = path.join(dir, "grandchild.pid");
  fs.writeFileSync(grandchild, "process.on('SIGTERM', () => {});\nsetInterval(() => {}, 60_000);\n");
  fs.writeFileSync(parent, `
    import { spawn } from "node:child_process";
    import fs from "node:fs";
    const child = spawn(process.execPath, [process.argv[2]], { stdio: "inherit" });
    fs.writeFileSync(process.argv[3], String(child.pid));
    child.unref();
    process.exit(0);
  `);
  return { parent, grandchild, pidFile };
}

async function assertDead(pid: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 800) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`进程 ${pid} 仍在`);
}

test("超时和取消都会清掉忽略 SIGTERM 的子孙进程", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aiquota5h-kill-"));
  const fixture = writeStubborn(root);
  const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  unrelated.unref();
  try {
    const started = Date.now();
    await runCommand({
      command: process.execPath,
      args: [fixture.parent, fixture.grandchild, fixture.pidFile],
      timeoutMs: 300,
    });
    assert.ok(Date.now() - started < 1_500);
    const pid = Number(fs.readFileSync(fixture.pidFile, "utf8"));
    await assertDead(pid);
    assert.equal(process.kill(unrelated.pid!, 0), true);

    const abortRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aiquota5h-abort-"));
    const abortFixture = writeStubborn(abortRoot);
    const controller = new AbortController();
    const abortStarted = Date.now();
    const pending = runCommand({
      command: process.execPath,
      args: [abortFixture.parent, abortFixture.grandchild, abortFixture.pidFile],
      timeoutMs: 30_000,
      signal: controller.signal,
    });
    await waitFor(() => fs.existsSync(abortFixture.pidFile));
    controller.abort();
    await pending;
    assert.ok(Date.now() - abortStarted < 1_500);
    await assertDead(Number(fs.readFileSync(abortFixture.pidFile, "utf8")));
    assert.equal(process.kill(unrelated.pid!, 0), true);
  } finally {
    try { process.kill(unrelated.pid!, "SIGKILL"); } catch { /* 已退出 */ }
  }
});

test("顽固子孙被取消后，生产读取工厂可以再次读取", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aiquota5h-slot4-"));
  const fixture = writeStubborn(root);
  const store = new Store(path.join(root, "state.sqlite"));
  let now = 1_000_000;
  let reads = 0;
  const read = createProviderRead({
    now: () => now,
    loadConfig: () => ({ cli: { codex: process.execPath, agy: "" } }),
    readCodex: (options) => {
      reads += 1;
      return runCommand({
        command: process.execPath,
        args: [fixture.parent, fixture.grandchild, fixture.pidFile],
        timeoutMs: 30_000,
        signal: options.signal,
      }).then(() => ({ provider: "codex" as const, category: "unavailable" as const, message: "cancelled", retryAfterMs: 1_000 }));
    },
  });
  const engine = new Engine({
    store,
    now: () => now,
    workDir: root,
    log: () => undefined,
    read,
    readTimeoutMs: 80,
    send: async () => ({ outcome: "not_sent", sessionId: null, detail: "no", started: false }),
  });
  const first = engine.enqueue("codex", "startup");
  const settled = await Promise.race([
    first.then(() => "settled"),
    new Promise((resolve) => setTimeout(() => resolve("hung"), 1_500)),
  ]);
  assert.equal(settled, "settled");
  assert.equal(reads, 1);
  await assertDead(Number(fs.readFileSync(fixture.pidFile, "utf8")));
  now += 20_000;
  const second = engine.enqueue("codex", "wake");
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(reads, 2);
  await second;
  store.close();
});

test("崩溃后的并发恢复至多一个持锁，释放不删除后继者", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aiquota5h-lock4-"));
  const lockPath = path.join(dir, "daemon.lock");
  const worker = path.resolve("dist/src/lock-worker.js");
  const run = (mode: string, hold = "200") => new Promise<string>((resolve) => {
    const child = spawn(process.execPath, [worker, lockPath, mode, hold], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk.toString(); });
    child.on("close", () => resolve(out.trim()));
  });
  assert.equal(await run("exit-without-release"), "acquired");
  const pair = await Promise.all([run("hold", "400"), run("hold", "400")]);
  assert.deepEqual(pair.sort(), ["acquired", "busy"]);
  assert.equal(fs.existsSync(lockPath), true);

  const ready = path.join(dir, "held");
  const holder = spawn(process.execPath, [worker, lockPath, "hold-file", ready], { stdio: ["ignore", "pipe", "pipe"] });
  await waitFor(() => fs.existsSync(ready));
  assert.equal(await run("hold", "100"), "busy");
  fs.writeFileSync(`${ready}.release`, "1");
  await new Promise((resolve) => holder.once("close", resolve));
  assert.equal(fs.existsSync(lockPath), true);
  assert.equal(await run("release-now"), "acquired");
  assert.equal(fs.existsSync(lockPath), true);

  const broken = new InstanceLock(lockPath, {
    afterHeld: () => { throw new Error("回收中断"); },
  });
  await assert.rejects(broken.acquire());
  const recovered = new InstanceLock(lockPath);
  assert.equal(await recovered.acquire(), "acquired");
  assert.equal(await new InstanceLock(lockPath).acquire(), "busy");
  await recovered.release();
});

test("Grok 当前周期不补发，周期切换满 120 秒只发一条", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aiquota5h-grok-due-"));
  const store = new Store(path.join(root, "state.sqlite"));
  let sends = 0;
  const week = 7 * 24 * 60 * 60_000;
  const snap = (windowId: string, resetAt: number, billing: ProviderSnapshot["pools"][0]["billingSafety"] = "subscription_only"): ProviderSnapshot => ({
    provider: "grok",
    accountId: "user",
    accountLabel: "g",
    authMode: "oidc",
    appCliConsistent: true,
    consistencyEvidence: "test",
    observedAt: NOW,
    rawSummary: "{}",
    pools: [{
      provider: "grok",
      accountId: "user",
      accountLabel: "g",
      poolId: "supergrok-weekly",
      models: ["grok-4.7"],
      selectedModel: "grok-4.7",
      billingSafety: billing,
      billingEvidence: [],
      observedAt: NOW,
      windows: [{
        key: "weekly",
        kind: "weekly",
        activationMode: "auto_reset",
        state: "active",
        oldEndedAt: null,
        resetAt,
        allowance: "allowed",
        sharesRequest: false,
        evidence: ["fixed weekly schedule"],
        windowId,
      }],
    }],
  });
  const engine = new Engine({
    store,
    now: () => NOW,
    workDir: path.join(root, "work"),
    log: () => undefined,
    read: async () => snap("weekly:next", NOW + week),
    confirmAccount: async () => true,
    send: async () => {
      sends += 1;
      return { outcome: "accepted", sessionId: "g", detail: "ok", started: true };
    },
  });
  engine.observe(snap("weekly:current", NOW - 180_000));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(sends, 0);
  engine.observe(snap("weekly:next", NOW + week));
  await waitFor(() => sends === 1);
  engine.observe(snap("weekly:next", NOW + week));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(sends, 1);
  store.close();
});

test("Grok 周期切换在费用未知或 blocked 时不发送", async () => {
  for (const billing of ["billing_safety_unknown", "blocked"] as const) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "aiquota5h-grok-bill-"));
    const store = new Store(path.join(root, "state.sqlite"));
    let sends = 0;
    const week = 7 * 24 * 60 * 60_000;
    const snap = (windowId: string, resetAt: number): ProviderSnapshot => ({
      provider: "grok",
      accountId: "user",
      accountLabel: "g",
      authMode: "oidc",
      appCliConsistent: true,
      consistencyEvidence: "test",
      observedAt: NOW,
      rawSummary: "{}",
      pools: [{
        provider: "grok",
        accountId: "user",
        accountLabel: "g",
        poolId: "supergrok-weekly",
        models: ["grok-4.7"],
        selectedModel: "grok-4.7",
        billingSafety: billing,
        billingEvidence: [],
        observedAt: NOW,
        windows: [{
          key: "weekly",
          kind: "weekly",
          activationMode: "auto_reset",
          state: "active",
          oldEndedAt: null,
          resetAt,
          allowance: "allowed",
          sharesRequest: false,
          evidence: ["fixed weekly schedule"],
          windowId,
        }],
      }],
    });
    const engine = new Engine({
      store,
      now: () => NOW,
      workDir: path.join(root, "work"),
      log: () => undefined,
      read: async () => snap("weekly:next", NOW + week),
      confirmAccount: async () => true,
      send: async () => {
        sends += 1;
        return { outcome: "accepted", sessionId: "g", detail: "ok", started: true };
      },
    });
    engine.observe(snap("weekly:current", NOW - 180_000));
    engine.observe(snap("weekly:next", NOW + week));
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(sends, 0);
    assert.notEqual(store.recentTasks()[0]?.status, "verifying");
    store.close();
  }
});

test("Grok 已启动但无法确认接受时不重发", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aiquota5h-grok-cli-"));
  const script = path.join(root, "fake-grok");
  fs.writeFileSync(script, `#!/usr/bin/env node
if (process.argv.includes("-h") || process.argv.includes("--help")) {
  process.stdout.write("  -p, --single\\n  --max-turns\\n  --disable-web-search\\n  --no-subagents\\n  --no-plan\\n  --permission-mode\\n  --cwd\\n");
  process.exit(0);
}
process.stderr.write("connection failed\\n");
process.exit(1);
`);
  fs.chmodSync(script, 0o755);
  const result = await sendGrok({
    provider: "grok",
    accountId: "user",
    poolId: "supergrok-weekly",
    model: "grok-4.7",
    prompt: "只回复 OK",
    workDir: root,
  }, script);
  assert.equal(result.outcome, "unknown");
  assert.equal(result.started, true);
});
