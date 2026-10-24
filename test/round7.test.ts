import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Engine } from "../src/engine.js";
import { beginShutdown, killOwned, resetShutdownForTests, shutdownSignal } from "../src/proc.js";
import { openRpc } from "../src/providers/rpc.js";
import { Store } from "../src/store.js";
import type { ProviderReadError, ProviderSnapshot } from "../src/types.js";

function snapshot(): ProviderSnapshot {
  return {
    provider: "codex",
    accountId: "acct",
    accountLabel: "a",
    authMode: "chatgpt",
    appCliConsistent: true,
    consistencyEvidence: "test",
    observedAt: 1,
    rawSummary: "{}",
    pools: [],
  };
}

test("完成的读取和 RPC 释放退出监听器，进行中的任务仍会被取消", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aiquota5h-listeners-"));
  const store = new Store(path.join(root, "state.sqlite"));
  const hang = path.join(root, "hang.mjs");
  fs.writeFileSync(hang, "setInterval(() => {}, 1000);\n");
  try {
    const engine = new Engine({
      store,
      now: () => 1,
      workDir: root,
      log: () => undefined,
      read: async () => snapshot(),
      send: async () => ({ outcome: "not_sent", sessionId: null, detail: "no", started: false }),
    });
    const before = getEventListeners(engine.stopSignal(), "abort").length;
    for (let index = 0; index < 20; index += 1) await engine.enqueue("codex", "refresh");
    assert.equal(getEventListeners(engine.stopSignal(), "abort").length, before);

    let aborted = false;
    const live = new Engine({
      store,
      now: () => 1,
      workDir: root,
      log: () => undefined,
      read: (_provider, signal) => new Promise((resolve) => {
        signal?.addEventListener("abort", () => {
          aborted = true;
          resolve({ provider: "codex", category: "unavailable", message: "cancelled", retryAfterMs: 1 } satisfies ProviderReadError);
        });
      }),
      send: async () => ({ outcome: "not_sent", sessionId: null, detail: "no", started: false }),
    });
    const reading = live.enqueue("codex", "startup");
    await new Promise((resolve) => setTimeout(resolve, 20));
    live.stop();
    await live.drain();
    await reading;
    assert.equal(aborted, true);
    assert.equal(getEventListeners(live.stopSignal(), "abort").length, 0);

    const baseline = getEventListeners(shutdownSignal(), "abort").length;
    const clients = [];
    for (let index = 0; index < 12; index += 1) clients.push(await openRpc(process.execPath, [hang]));
    for (const client of clients) client.close();
    await killOwned();
    assert.equal(getEventListeners(shutdownSignal(), "abort").length, baseline);

    const natural = await openRpc(process.execPath, ["-e", "setTimeout(() => process.exit(0), 30)"]);
    await new Promise((resolve) => natural.child.once("close", resolve));
    await killOwned();
    assert.equal(getEventListeners(shutdownSignal(), "abort").length, baseline);

    const rpc = await openRpc(process.execPath, [hang]);
    const pid = rpc.child.pid!;
    beginShutdown();
    await killOwned();
    assert.equal(getEventListeners(shutdownSignal(), "abort").length, baseline);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.throws(() => process.kill(pid, 0));
  } finally {
    resetShutdownForTests();
    await killOwned();
    store.close();
  }
});
