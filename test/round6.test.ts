import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Engine } from "../src/engine.js";
import { beginShutdown, killOwned, resetShutdownForTests } from "../src/proc.js";
import { sendCodex } from "../src/providers/codex.js";
import { Store } from "../src/store.js";
import type { ProviderSnapshot, WindowFact } from "../src/types.js";

const NOW = 30_000_000;

function idleWindow(): WindowFact {
  return {
    key: "5h",
    kind: "session",
    activationMode: "usage_started",
    state: "idle",
    oldEndedAt: NOW - 180_000,
    resetAt: null,
    allowance: "allowed",
    sharesRequest: true,
    evidence: ["server_past_boundary"],
    windowId: "5h:ended",
  };
}

function snapshot(): ProviderSnapshot {
  return {
    provider: "codex",
    accountId: "acct",
    accountLabel: "a",
    authMode: "chatgpt",
    appCliConsistent: true,
    consistencyEvidence: "test",
    observedAt: NOW,
    rawSummary: "{}",
    pools: [{
      provider: "codex",
      accountId: "acct",
      accountLabel: "a",
      poolId: "codex",
      models: ["gpt-5.6-luna"],
      selectedModel: "gpt-5.6-luna",
      billingSafety: "subscription_only",
      billingEvidence: [],
      observedAt: NOW,
      windows: [idleWindow()],
    }],
  };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("等待超时");
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

test("退出发生在 help 阶段时不会启动实际发送，已启动的请求不会当成未发送", async () => {
  const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  unrelated.unref();
  const leftovers: number[] = [];
  try {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "aiquota5h-stop-"));
    const ready = path.join(root, "ready");
    const marker = path.join(root, "sent");
    const script = path.join(root, "fake-codex");
    fs.writeFileSync(script, `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv.includes("--help")) {
  fs.writeFileSync(${JSON.stringify(ready)}, "1");
  process.on("SIGTERM", () => process.exit(0));
  setInterval(() => {}, 1000);
} else {
  fs.writeFileSync(${JSON.stringify(marker)}, String(process.pid));
  setInterval(() => {}, 1000);
}
`);
    fs.chmodSync(script, 0o755);
    const pending = sendCodex({
      provider: "codex",
      accountId: "acct",
      poolId: "codex",
      model: "gpt-5.6-luna",
      prompt: "只回复 OK",
      workDir: root,
    }, script);
    await waitFor(() => fs.existsSync(ready));
    beginShutdown();
    await killOwned();
    const result = await pending;
    assert.equal(fs.existsSync(marker), false);
    assert.equal(result.started, false);
    assert.equal(result.outcome, "not_sent");
    assert.equal(alive(unrelated.pid!), true);

    resetShutdownForTests();
    const startedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aiquota5h-started-"));
    const startedMarker = path.join(startedRoot, "sent");
    const startedScript = path.join(startedRoot, "fake-codex");
    fs.writeFileSync(startedScript, `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv.includes("--help")) process.exit(0);
fs.writeFileSync(${JSON.stringify(startedMarker)}, String(process.pid));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`);
    fs.chmodSync(startedScript, 0o755);
    const started = sendCodex({
      provider: "codex",
      accountId: "acct",
      poolId: "codex",
      model: "gpt-5.6-luna",
      prompt: "只回复 OK",
      workDir: startedRoot,
    }, startedScript);
    await waitFor(() => fs.existsSync(startedMarker));
    const senderPid = Number(fs.readFileSync(startedMarker, "utf8"));
    leftovers.push(senderPid);
    beginShutdown();
    await killOwned();
    const startedResult = await started;
    assert.equal(startedResult.started, true);
    assert.equal(startedResult.outcome, "unknown");
    assert.equal(alive(senderPid), false);
    assert.equal(alive(unrelated.pid!), true);
  } finally {
    for (const pid of leftovers) {
      try { process.kill(-pid, "SIGKILL"); } catch { /* 不是组长 */ }
      try { process.kill(pid, "SIGKILL"); } catch { /* 已退出 */ }
    }
    if (unrelated.pid) {
      try { process.kill(unrelated.pid, "SIGKILL"); } catch { /* 已退出 */ }
    }
    resetShutdownForTests();
    await killOwned();
  }
});

test("退出时晚完成的读取和排队任务不能启动发送", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aiquota5h-late-"));
  const store = new Store(path.join(root, "state.sqlite"));
  let sends = 0;
  let releaseRead: (value: ProviderSnapshot) => void = () => undefined;
  const snap = snapshot();
  const engine = new Engine({
    store,
    now: () => NOW,
    workDir: path.join(root, "work"),
    log: () => undefined,
    read: () => new Promise((resolve) => { releaseRead = resolve; }),
    confirmAccount: async () => true,
    send: async () => {
      sends += 1;
      return { outcome: "accepted", sessionId: "s", detail: "ok", started: true };
    },
  });
  const reading = engine.enqueue("codex", "startup");
  await new Promise((resolve) => setTimeout(resolve, 20));
  engine.stop();
  releaseRead(snap);
  await engine.drain();
  await reading;
  assert.equal(sends, 0);

  const queued = new Engine({
    store,
    now: () => NOW,
    workDir: path.join(root, "work"),
    log: () => undefined,
    read: async () => snap,
    confirmAccount: () => new Promise((resolve) => { releaseConfirm = resolve; }),
    send: async () => {
      sends += 1;
      return { outcome: "accepted", sessionId: "s", detail: "ok", started: true };
    },
  });
  let releaseConfirm: (value: boolean) => void = () => undefined;
  queued.observe(snap);
  await new Promise((resolve) => setTimeout(resolve, 20));
  queued.stop();
  releaseConfirm(true);
  await queued.drain();
  assert.equal(sends, 0);
  assert.notEqual(store.recentTasks()[0]?.status, "verifying");
  store.close();
});
