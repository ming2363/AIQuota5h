import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Engine } from "../src/engine.js";
import { InstanceLock } from "../src/lock.js";
import { runCommand } from "../src/proc.js";
import { sendAntigravity } from "../src/providers/antigravity.js";
import { callLs } from "../src/providers/antigravity.js";
import { sendCodex } from "../src/providers/codex.js";
import { fetchBilling } from "../src/providers/grok.js";
import { openRpc } from "../src/providers/rpc.js";
import { createProviderRead } from "../src/runtime.js";
import { Store } from "../src/store.js";
import type { PoolFact, ProviderSnapshot, SendRequest, WindowFact } from "../src/types.js";

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

function request(workDir: string): SendRequest {
  return {
    provider: "codex",
    accountId: "acct",
    poolId: "codex",
    model: "gpt-5.6-luna",
    prompt: "只回复 OK",
    workDir,
  };
}

function writeScript(file: string, body: string): void {
  fs.writeFileSync(file, `#!/usr/bin/env node\n${body}`);
  fs.chmodSync(file, 0o755);
}

test("已启动后的空输出和非零退出不能当成未发送", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aiquota5h-empty-"));
  const marker = path.join(root, "marker");
  const script = path.join(root, "fake-codex");
  writeScript(script, `
    const fs = require("node:fs");
    if (process.argv.includes("--help")) process.exit(0);
    fs.appendFileSync(${JSON.stringify(marker)}, "received\\n");
    process.stderr.write("connection failed\\n");
    process.exit(1);
  `);
  const result = await sendCodex(request(root), script);
  assert.equal(result.outcome, "unknown");
  assert.equal(result.started, true);
  assert.equal(fs.readFileSync(marker, "utf8").trim(), "received");
});

test("假 CLI 贯穿引擎后空输出不会再次派发", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aiquota5h-replay-"));
  const marker = path.join(root, "marker");
  const script = path.join(root, "fake-codex");
  writeScript(script, `
    const fs = require("node:fs");
    if (process.argv.includes("--help")) process.exit(0);
    fs.appendFileSync(${JSON.stringify(marker)}, "received\\n");
    process.stderr.write("connection failed\\n");
    process.exit(1);
  `);
  const store = new Store(path.join(root, "state.sqlite"));
  const snap = snapshot([idleWindow(NOW - 180_000)]);
  const engine = new Engine({
    store,
    now: () => NOW,
    workDir: path.join(root, "work"),
    log: () => undefined,
    read: async () => snap,
    confirmAccount: async () => true,
    send: (pool, workDir) => sendCodex({
      provider: pool.provider,
      accountId: pool.accountId,
      poolId: pool.poolId,
      model: pool.selectedModel || "",
      prompt: "只回复 OK",
      workDir,
    }, script),
  });
  try {
    engine.observe(snap);
    const startedAt = Date.now();
    while (store.recentTasks()[0]?.status !== "unknown_result") {
      if (Date.now() - startedAt > 3_000) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    engine.observe(snap);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const lines = fs.readFileSync(marker, "utf8").trim().split("\n").filter(Boolean);
    assert.equal(lines.length, 1);
    const task = store.recentTasks()[0];
    assert.equal(task?.status, "unknown_result");
    assert.equal(task?.phase, "spawned");
    assert.equal(task?.message_result, "unknown");
    assert.equal(task?.attempt_count, 1);
  } finally {
    store.close();
  }
});

test("进程未启动或参数被拒绝时才是 not_sent", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aiquota5h-unsent-"));
  const missing = await sendCodex(request(root), path.join(root, "missing-codex"));
  assert.equal(missing.outcome, "not_sent");
  assert.equal(missing.started, false);
  const rejected = path.join(root, "reject-codex");
  writeScript(rejected, "process.exit(2);");
  const helpRejected = await sendCodex(request(root), rejected);
  assert.equal(helpRejected.outcome, "not_sent");
  assert.equal(helpRejected.started, false);
});

test("agy 进程已启动但没有会话号时不能重发", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aiquota5h-agy-"));
  const marker = path.join(root, "marker");
  const script = path.join(root, "fake-agy");
  writeScript(script, `
    const fs = require("node:fs");
    if (process.argv.includes("--help")) {
      process.stdout.write("  --disable-plugins\\n  --disable-mcp\\n  --disable-hooks\\n");
      process.exit(0);
    }
    if (process.argv[2] === "models") {
      process.stdout.write("gemini-3.8-flash-low\\n");
      process.exit(0);
    }
    fs.appendFileSync(${JSON.stringify(marker)}, "received\\n");
    process.stderr.write("connection failed\\n");
    process.exit(1);
  `);
  const result = await sendAntigravity({
    provider: "antigravity",
    accountId: "a@example.com",
    poolId: "gemini",
    model: "gemini-3.8-flash-low",
    prompt: "只回复 OK",
    workDir: root,
  }, script);
  assert.equal(result.outcome, "unknown");
  assert.equal(result.started, true);
  assert.equal(fs.readFileSync(marker, "utf8").trim(), "received");
});

test("相同快照与最终检查交错后仍只发送一次", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aiquota5h-same-"));
  const store = new Store(path.join(root, "state.sqlite"));
  let sends = 0;
  let calls = 0;
  let release = (): void => undefined;
  const hung = new Promise<void>((resolve) => {
    release = resolve;
  });
  let ready: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const snap = snapshot([idleWindow(NOW - 180_000)]);
  const engine = new Engine({
    store,
    now: () => NOW,
    workDir: path.join(root, "work"),
    log: () => undefined,
    read: async () => snap,
    confirmAccount: async () => {
      calls += 1;
      if (calls === 2) {
        ready();
        await hung;
      }
      return true;
    },
    send: async () => {
      sends += 1;
      return { outcome: "accepted", sessionId: "s", detail: "ok", started: true };
    },
  });
  engine.observe(snap);
  await started;
  engine.observe(snap);
  release();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(sends, 1);
  assert.equal(store.recentTasks()[0]?.status, "verifying");
  assert.notEqual(store.recentTasks()[0]?.error_category, "stale_authorization");
  store.close();
});

test("费用变化会作废旧授权，条件恢复后只补发一次", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aiquota5h-bill-"));
  const store = new Store(path.join(root, "state.sqlite"));
  let now = NOW;
  let sends = 0;
  let calls = 0;
  let release = (): void => undefined;
  const hung = new Promise<void>((resolve) => {
    release = resolve;
  });
  let ready: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const idle = snapshot([idleWindow(NOW - 180_000)]);
  const unknown = snapshot([idleWindow(NOW - 180_000)]);
  unknown.pools[0].billingSafety = "billing_safety_unknown";
  const engine = new Engine({
    store,
    now: () => now,
    workDir: path.join(root, "work"),
    log: () => undefined,
    read: async () => idle,
    confirmAccount: async () => {
      calls += 1;
      if (calls === 2) {
        ready();
        await hung;
      }
      return true;
    },
    send: async () => {
      sends += 1;
      return { outcome: "accepted", sessionId: "s", detail: "ok", started: true };
    },
  });
  engine.observe(idle);
  await started;
  engine.observe(unknown);
  release();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(sends, 0);
  assert.equal(store.recentTasks()[0]?.status, "deferred");
  assert.equal(store.recentTasks()[0]?.error_category, "stale_authorization");
  now += 2_000;
  engine.observe(idle);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(sends, 1);
  store.close();
});

test("确认期间账号切换不会发出旧请求", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aiquota5h-acct-"));
  const store = new Store(path.join(root, "state.sqlite"));
  let sends = 0;
  let calls = 0;
  let release = (): void => undefined;
  const hung = new Promise<void>((resolve) => {
    release = resolve;
  });
  let ready: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const idle = snapshot([idleWindow(NOW - 180_000)]);
  const other = snapshot([idleWindow(NOW - 180_000)]);
  other.accountId = "other";
  other.pools[0].accountId = "other";
  other.pools[0].billingSafety = "billing_safety_unknown";
  const engine = new Engine({
    store,
    now: () => NOW,
    workDir: path.join(root, "work"),
    log: () => undefined,
    read: async () => idle,
    confirmAccount: async () => {
      calls += 1;
      if (calls === 2) {
        ready();
        await hung;
      }
      return true;
    },
    send: async () => {
      sends += 1;
      return { outcome: "accepted", sessionId: "s", detail: "ok", started: true };
    },
  });
  engine.observe(idle);
  await started;
  engine.observe(other);
  release();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(sends, 0);
  assert.equal(store.recentTasks().some((row) => row.account_id === "acct" && row.message_result === "accepted"), false);
  store.close();
});

test("生产读取工厂传递取消信号，超时后槽可以再次读取", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aiquota5h-slot-"));
  const hang = path.join(root, "hang.mjs");
  fs.writeFileSync(hang, "setInterval(() => {}, 1000);\n");
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
        args: [hang],
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
    readTimeoutMs: 10,
    send: async () => ({ outcome: "not_sent", sessionId: null, detail: "no", started: false }),
  });
  const first = engine.enqueue("codex", "startup");
  const settled = await Promise.race([
    first.then(() => "settled"),
    new Promise((resolve) => setTimeout(() => resolve("hung"), 80)),
  ]);
  assert.equal(settled, "settled");
  assert.equal(reads, 1);
  now += 20_000;
  const second = engine.enqueue("codex", "wake");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(reads, 2);
  await second;
  store.close();
});

test("Grok 响应体挂起时外部取消会中止底层读取", async () => {
  const external = new AbortController();
  let underlying: AbortSignal | undefined;
  let bodyAborted = false;
  const pending = fetchBilling("token", Date.now(), external.signal, async (_url, init) => {
    underlying = init?.signal ?? undefined;
    return new Response(new ReadableStream({
      start(controller) {
        init?.signal?.addEventListener("abort", () => {
          bodyAborted = true;
          controller.error(new DOMException("aborted", "AbortError"));
        });
      },
    }), { status: 200 });
  });
  await new Promise((resolve) => setTimeout(resolve, 15));
  external.abort();
  await assert.rejects(pending);
  assert.equal(underlying?.aborted, true);
  assert.equal(bodyAborted, true);
});

test("Codex RPC 取消会结束子进程", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aiquota5h-rpc-"));
  const hang = path.join(root, "hang.mjs");
  fs.writeFileSync(hang, "setInterval(() => {}, 1000);\n");
  const controller = new AbortController();
  const rpc = await openRpc(process.execPath, [hang], 5_000, undefined, controller.signal);
  const pending = rpc.request("initialize", {});
  const pid = rpc.child.pid;
  assert.ok(pid);
  controller.abort();
  await assert.rejects(pending);
  const start = Date.now();
  while (Date.now() - start < 500) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("rpc 子进程仍在");
});

test("Antigravity 本地请求会随取消销毁", async () => {
  const server = http.createServer((_req, res) => {
    setTimeout(() => res.end("{}"), 5_000).unref();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("没有端口");
  const controller = new AbortController();
  const pending = callLs({ scheme: "http", port: address.port, csrf: "t" }, "RetrieveUserQuotaSummary", {}, controller.signal);
  controller.abort();
  await assert.rejects(pending);
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test("内核锁公开后第二个实例不能同时获得", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aiquota5h-publish-"));
  const lockPath = path.join(dir, "daemon.lock");
  let release: () => void = () => undefined;
  let entered: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const first = new InstanceLock(lockPath, {
    afterHeld: () => {
      entered();
      return new Promise((done) => { release = () => done(undefined); });
    },
  });
  const firstResult = first.acquire();
  await ready;
  assert.equal(await new InstanceLock(lockPath).acquire(), "busy");
  release();
  assert.equal(await firstResult, "acquired");
  await first.release();
});
