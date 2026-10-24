import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createProviderRead } from "../src/runtime.js";
import { Engine } from "../src/engine.js";
import { mapCodexPools } from "../src/providers/codex.js";
import { Store } from "../src/store.js";
import type { PriorWindow } from "../src/decision.js";
import type { ProviderSnapshot } from "../src/types.js";

const START = 1_800_000_000_000;

function limits(primary: { used: number | null; resetAt: number | null }, secondary?: { used: number | null; resetAt: number | null } | null) {
  const body: Record<string, unknown> = {
    planType: "plus",
    credits: { hasCredits: false, balance: "0" },
  };
  if (primary.used != null || primary.resetAt != null) {
    body.primary = {
      usedPercent: primary.used,
      windowDurationMins: 300,
      resetsAt: primary.resetAt == null ? undefined : Math.floor(primary.resetAt / 1000),
    };
  }
  if (secondary) {
    body.secondary = {
      usedPercent: secondary.used,
      windowDurationMins: 10080,
      resetsAt: secondary.resetAt == null ? undefined : Math.floor(secondary.resetAt / 1000),
    };
  }
  return { rateLimits: body };
}

function snapshotFrom(now: number, raw: ReturnType<typeof limits>, priors: PriorWindow[] = [], accountId = "acct"): ProviderSnapshot {
  const pools = mapCodexPools({
    accountId,
    email: "a@example.com",
    plan: "plus",
    limits: raw,
    models: ["gpt-5.6-luna"],
    selected: "gpt-5.6-luna",
    now,
    priors,
    authMode: "chatgpt",
    hasApiKey: false,
  });
  return {
    provider: "codex",
    accountId,
    accountLabel: "a",
    authMode: "chatgpt",
    appCliConsistent: true,
    consistencyEvidence: "test",
    pools,
    observedAt: now,
    rawSummary: "{}",
  };
}

test("生产读取工厂把历史边界传给 Codex 映射，旧窗口到期后才能发一次", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aiquota5h-codex-prior-"));
  const store = new Store(path.join(root, "state.sqlite"));
  let now = START;
  let sends = 0;
  const oldReset = START + 60_000;
  const newReset = oldReset + 5 * 60 * 60_000;
  const weeklyReset = START + 7 * 24 * 60 * 60_000;
  let phase: "active" | "firstZero" | "slide" | "used" = "active";
  const read = createProviderRead({
    now: () => now,
    loadConfig: () => ({ cli: { codex: "codex" } }),
    priorsFor: () => store.windowPriors("codex"),
    readCodex: async (options) => snapshotFrom(now, limits(
      phase === "active"
        ? { used: 25, resetAt: oldReset }
        : phase === "used"
          ? { used: 2, resetAt: newReset }
          : { used: 0, resetAt: phase === "slide" ? newReset + (now - firstSampleAt) : newReset },
      { used: 0, resetAt: weeklyReset },
    ), options.priors),
  });
  const engine = new Engine({
    store,
    now: () => now,
    workDir: path.join(root, "work"),
    log: () => undefined,
    read,
    sleep: async (ms) => { now += ms; },
    confirmAccount: async () => true,
    send: async () => {
      sends += 1;
      return { outcome: "accepted", sessionId: "s", detail: "ok", started: true };
    },
  });
  await engine.enqueue("codex", "startup");
  assert.equal(sends, 0);
  assert.equal(store.allWindows().find((item) => item.window_key === "5h")?.state, "active");

  const firstSampleAt = oldReset + 30_000;
  now = firstSampleAt;
  phase = "firstZero";
  await engine.enqueue("codex", "refresh");
  assert.equal(store.allWindows().find((item) => item.window_key === "5h")?.state, "unknown");
  assert.equal(sends, 0, "只有一次 0% 和新 reset 不能证明未启动");

  now = oldReset + 60_000;
  phase = "slide";
  await engine.enqueue("codex", "refresh");
  assert.equal(store.allWindows().find((item) => item.window_key === "5h")?.state, "idle");
  assert.equal(sends, 0, "旧边界后 65 秒内即使已证明滑动也不发");

  now = oldReset + 180_000;
  const beforeWait = now;
  await engine.enqueue("codex", "refresh");
  await new Promise((resolve) => setTimeout(resolve, 30));
  const five = store.allWindows().find((item) => item.window_key === "5h");
  assert.equal(five?.state, "idle");
  assert.equal(five?.old_ended_at, oldReset);
  assert.ok((five?.evidence || "").includes("resampled_reset_still_slides") || (five?.evidence || "").includes("sampled_reset_slides_with_wall_clock"));
  assert.ok(now - beforeWait >= 5_000, "最终复核必须等到可比较的采样间隔");
  assert.equal(sends, 1);
  assert.equal(store.recentTasks()[0]?.window_key, "5h");

  phase = "used";
  await engine.enqueue("codex", "refresh");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(sends, 1, "用户已启动后不重发");
  store.close();
});

test("已证明 idle 后，最终复核发现时钟不再滑动则不发", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aiquota5h-codex-race-"));
  const store = new Store(path.join(root, "state.sqlite"));
  let now = START;
  let sends = 0;
  const oldReset = START + 60_000;
  const weeklyReset = START + 8 * 24 * 60 * 60_000;
  let mode: "active" | "first" | "slide" | "started" = "active";
  let sampleReset = oldReset + 5 * 60 * 60_000;
  let anchoredReset = 0;
  const firstSampleAt = oldReset + 30_000;
  const read = createProviderRead({
    now: () => now,
    loadConfig: () => ({ cli: { codex: "codex" } }),
    priorsFor: () => store.windowPriors("codex"),
    readCodex: async (options) => snapshotFrom(now, limits(
      mode === "active"
        ? { used: 25, resetAt: oldReset }
        : mode === "started"
          ? { used: 0, resetAt: anchoredReset }
          : { used: 0, resetAt: sampleReset },
      { used: 20, resetAt: weeklyReset },
    ), options.priors),
  });
  const engine = new Engine({
    store,
    now: () => now,
    workDir: root,
    log: () => undefined,
    read,
    confirmAccount: async () => {
      if (mode === "slide") {
        now += 10_000;
        anchoredReset = now + 5 * 60 * 60_000;
        mode = "started";
      }
      return true;
    },
    send: async () => {
      sends += 1;
      return { outcome: "accepted", sessionId: "s", detail: "ok", started: true };
    },
  });
  await engine.enqueue("codex", "startup");
  now = firstSampleAt;
  mode = "first";
  sampleReset = oldReset + 5 * 60 * 60_000;
  await engine.enqueue("codex", "refresh");
  now = oldReset + 180_000;
  mode = "slide";
  sampleReset = (oldReset + 5 * 60 * 60_000) + (now - firstSampleAt);
  await engine.enqueue("codex", "refresh");
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(sends, 0);
  assert.notEqual(store.recentTasks()[0]?.status, "verifying");
  await engine.enqueue("codex", "refresh");
  assert.equal(store.allWindows().find((item) => item.window_key === "5h")?.state, "unknown");
  assert.equal(sends, 0);
  store.close();
});

test("从未证明启动的候选时间和新窗口初始 0% 都不能发送", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aiquota5h-codex-false-"));
  const store = new Store(path.join(root, "state.sqlite"));
  let now = START;
  let sends = 0;
  const firstReset = START + 60_000;
  const laterReset = firstReset + 5 * 60 * 60_000;
  let mode: "first" | "later" | "anchored" = "first";
  let anchoredReset = laterReset;
  const read = createProviderRead({
    now: () => now,
    loadConfig: () => ({ cli: { codex: "codex" } }),
    priorsFor: () => store.windowPriors("codex"),
    readCodex: async (options) => snapshotFrom(now, limits(
      { used: 0, resetAt: mode === "first" ? firstReset : mode === "anchored" ? anchoredReset : laterReset + (now - (firstReset + 30_000)) },
      { used: 0, resetAt: START + 8 * 24 * 60 * 60_000 },
    ), options.priors),
  });
  const engine = new Engine({
    store,
    now: () => now,
    workDir: root,
    log: () => undefined,
    read,
    confirmAccount: async () => true,
    send: async () => {
      sends += 1;
      return { outcome: "accepted", sessionId: "s", detail: "ok", started: true };
    },
  });
  await engine.enqueue("codex", "startup");
  assert.equal(store.allWindows().find((item) => item.window_key === "5h")?.state, "unknown");
  now = firstReset + 180_000;
  mode = "later";
  await engine.enqueue("codex", "refresh");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(store.allWindows().find((item) => item.window_key === "5h")?.state, "unknown");
  assert.equal(sends, 0);

  const started = new Store(path.join(root, "started.sqlite"));
  let startedNow = START;
  const startedReset = START + 60_000;
  const nextReset = startedReset + 5 * 60 * 60_000;
  let startedMode: "active" | "zero" | "stable" = "active";
  const startedRead = createProviderRead({
    now: () => startedNow,
    loadConfig: () => ({ cli: { codex: "codex" } }),
    priorsFor: () => started.windowPriors("codex"),
    readCodex: async (options) => snapshotFrom(startedNow, limits(
      startedMode === "active"
        ? { used: 25, resetAt: startedReset }
        : { used: 0, resetAt: nextReset },
      { used: 12, resetAt: START + 8 * 24 * 60 * 60_000 },
    ), options.priors),
  });
  const startedEngine = new Engine({
    store: started,
    now: () => startedNow,
    workDir: path.join(root, "started-work"),
    log: () => undefined,
    read: startedRead,
    confirmAccount: async () => true,
    send: async () => {
      sends += 1;
      return { outcome: "accepted", sessionId: "s", detail: "ok", started: true };
    },
  });
  await startedEngine.enqueue("codex", "startup");
  startedNow = startedReset + 40_000;
  startedMode = "zero";
  await startedEngine.enqueue("codex", "refresh");
  startedNow = startedReset + 180_000;
  startedMode = "stable";
  anchoredReset = nextReset;
  await startedEngine.enqueue("codex", "refresh");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(started.allWindows().find((item) => item.window_key === "5h")?.state, "unknown");
  assert.equal(sends, 0);
  store.close();
  started.close();
});

test("同账号不同额度池不能借用旧边界", () => {
  const sharedNow = START;
  const ownReset = sharedNow + 3_600_000;
  const otherReset = sharedNow - 180_000;
  const mixed = mapCodexPools({
    accountId: "acct",
    email: "a@example.com",
    plan: "plus",
    limits: {
      rateLimitsByLimitId: {
        codex_other: {
          limitId: "codex_other",
          planType: "plus",
          credits: { hasCredits: false, balance: "0" },
          primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: Math.floor(ownReset / 1000) },
          secondary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: Math.floor((sharedNow + 86_400_000) / 1000) },
        },
      },
    },
    models: ["gpt-5.6-luna"],
    selected: "gpt-5.6-luna",
    now: sharedNow,
    priors: [
      { key: "5h", poolId: "codex", accountId: "acct", resetAt: otherReset, preservedBoundary: otherReset, windowId: "codex-old", state: "active", observedAt: sharedNow - 3_600_000 },
      { key: "5h", poolId: "codex_other", accountId: "acct", resetAt: ownReset, preservedBoundary: null, windowId: "other-live", state: "active", observedAt: sharedNow - 60_000 },
    ],
    authMode: "chatgpt",
    hasApiKey: false,
  });
  assert.equal(mixed[0].windows.find((item) => item.key === "5h")?.state, "active");
  const reversed = mapCodexPools({
    accountId: "acct",
    email: "a@example.com",
    plan: "plus",
    limits: {
      rateLimitsByLimitId: {
        codex: {
          limitId: "codex",
          planType: "plus",
          credits: { hasCredits: false, balance: "0" },
          primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: Math.floor((sharedNow + 3_600_000) / 1000) },
        },
        codex_other: {
          limitId: "codex_other",
          planType: "plus",
          credits: { hasCredits: false, balance: "0" },
          primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: Math.floor(ownReset / 1000) },
        },
      },
    },
    models: ["gpt-5.6-luna"],
    selected: "gpt-5.6-luna",
    now: sharedNow,
    priors: [
      { key: "5h", poolId: "codex_other", accountId: "acct", resetAt: ownReset, preservedBoundary: null, windowId: "other-live", state: "active", observedAt: sharedNow - 60_000 },
      { key: "5h", poolId: "codex", accountId: "acct", resetAt: otherReset, preservedBoundary: otherReset, windowId: "codex-old", state: "active", observedAt: sharedNow - 3_600_000 },
    ],
    authMode: "chatgpt",
    hasApiKey: false,
  });
  assert.equal(reversed.find((pool) => pool.poolId === "codex_other")?.windows.find((item) => item.key === "5h")?.state, "active");
  assert.notEqual(reversed.find((pool) => pool.poolId === "codex_other")?.windows.find((item) => item.key === "5h")?.oldEndedAt, otherReset);
});

test("没有历史边界的 0% 快照不能发送，周 0% 也不阻断已证明的五小时窗口", async () => {
  const bare = mapCodexPools({
    accountId: "acct",
    email: "a@example.com",
    plan: "plus",
    limits: limits({ used: 0, resetAt: START + 60_000 }, { used: 0, resetAt: START + 86_400_000 }),
    models: ["gpt-5.6-luna"],
    selected: "gpt-5.6-luna",
    now: START,
    priors: [],
    authMode: "chatgpt",
    hasApiKey: false,
  });
  assert.equal(bare[0].windows.find((item) => item.key === "5h")?.state, "unknown");
  assert.equal(bare[0].windows.find((item) => item.key === "5h")?.oldEndedAt, null);
  assert.equal(bare[0].windows.find((item) => item.key === "weekly")?.allowance, "allowed");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aiquota5h-codex-gap-"));
  const store = new Store(path.join(root, "state.sqlite"));
  let sends = 0;
  const engine = new Engine({
    store,
    now: () => START,
    workDir: root,
    log: () => undefined,
    read: async () => snapshotFrom(START, limits({ used: 0, resetAt: START + 60_000 }, { used: 0, resetAt: START + 86_400_000 })),
    confirmAccount: async () => true,
    send: async () => {
      sends += 1;
      return { outcome: "accepted", sessionId: "s", detail: "ok", started: true };
    },
  });
  engine.observe(snapshotFrom(START, limits({ used: 0, resetAt: START + 60_000 }, { used: 0, resetAt: START + 86_400_000 })));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(sends, 0);
  assert.equal(store.recentTasks().length, 0);
  store.close();
});

test("周额度耗尽或字段缺失阻止发送，同重置上的 0% 不能抹掉已启动", () => {
  const exhausted = mapCodexPools({
    accountId: "acct",
    email: "a@example.com",
    plan: "plus",
    limits: limits({ used: 0, resetAt: START + 3_600_000 }, { used: 100, resetAt: START + 86_400_000 }),
    models: ["gpt-5.6-luna"],
    selected: "gpt-5.6-luna",
    now: START,
    priors: [{ key: "5h", resetAt: START - 180_000, preservedBoundary: START - 180_000, windowId: "old", state: "active" }],
    authMode: "chatgpt",
    hasApiKey: false,
  });
  assert.equal(exhausted[0].windows.find((item) => item.key === "weekly")?.allowance, "exhausted");

  const missing = mapCodexPools({
    accountId: "acct",
    email: "a@example.com",
    plan: "plus",
    limits: limits({ used: 0, resetAt: START + 3_600_000 }, null),
    models: ["gpt-5.6-luna"],
    selected: "gpt-5.6-luna",
    now: START,
    priors: [],
    authMode: "chatgpt",
    hasApiKey: false,
  });
  assert.equal(missing[0].windows.find((item) => item.key === "weekly")?.allowance, "unknown");

  const rounded = mapCodexPools({
    accountId: "acct",
    email: "a@example.com",
    plan: "plus",
    limits: limits({ used: 0, resetAt: START + 3_600_000 }, { used: 0, resetAt: START + 86_400_000 }),
    models: ["gpt-5.6-luna"],
    selected: "gpt-5.6-luna",
    now: START,
    priors: [{ key: "5h", resetAt: START + 3_600_000, preservedBoundary: null, windowId: "same", state: "active" }],
    authMode: "chatgpt",
    hasApiKey: false,
  });
  assert.equal(rounded[0].windows.find((item) => item.key === "5h")?.state, "active");
});

test("账号切换不能复用旧边界", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aiquota5h-codex-acct-"));
  const store = new Store(path.join(root, "state.sqlite"));
  const oldReset = START - 180_000;
  store.savePool({
    provider: "codex",
    accountId: "old",
    accountLabel: "old",
    poolId: "codex",
    models: ["gpt-5.6-luna"],
    selectedModel: "gpt-5.6-luna",
    billingSafety: "subscription_only",
    billingEvidence: [],
    observedAt: START,
    windows: [{
      key: "5h",
      kind: "session",
      activationMode: "usage_started",
      state: "active",
      oldEndedAt: null,
      resetAt: oldReset,
      allowance: "allowed",
      sharesRequest: true,
      evidence: ["usage_recorded_and_anchored_reset"],
      windowId: `5h:${oldReset}`,
    }],
  }, "{}");
  const mapped = mapCodexPools({
    accountId: "new",
    email: "n@example.com",
    plan: "plus",
    limits: limits({ used: 0, resetAt: START + 3_600_000 }, { used: 0, resetAt: START + 86_400_000 }),
    models: ["gpt-5.6-luna"],
    selected: "gpt-5.6-luna",
    now: START,
    priors: store.windowPriors("codex").filter((item) => item.accountId === "new"),
    authMode: "chatgpt",
    hasApiKey: false,
  });
  assert.equal(mapped[0].windows.find((item) => item.key === "5h")?.oldEndedAt, null);
  assert.equal(mapped[0].windows.find((item) => item.key === "5h")?.state, "unknown");
  store.close();
});

test("固定 reset 在 0/1/2 秒不能证明滑动，足够间隔仍固定也不发", async () => {
  for (const interval of [0, 1_000, 2_000, 6_000]) {
    const run = await dueConfirm(`gap-${interval}`, interval, true);
    try {
      assert.equal(run.sends, 0, `${interval}ms 不应发送`);
      assert.notEqual(run.task?.status, "verifying");
      assert.equal(run.task?.message_result, "not_sent");
      if (interval < 5_000) assert.match(run.confirmEvidence, /sample_interval_too_short/);
      else assert.match(run.confirmEvidence, /resampled_reset_no_longer_slides/);
      assert.doesNotMatch(run.confirmEvidence, /resampled_reset_still_slides/);
    } finally {
      run.cleanup();
    }
  }
});

test("采样等待期间暂停、退出或账号变化都不发，未发任务可恢复", async () => {
  const paused = await dueConfirm("pause", 5_000, false, {
    onWait: (ctx) => ctx.store.setPaused(true),
  });
  try {
    assert.equal(paused.sends, 0);
    assert.equal(paused.task?.status, "deferred");
    assert.equal(paused.task?.error_category, "paused");
    assert.equal(paused.task?.message_result, "not_sent");
    paused.store.setPaused(false);
    paused.now += 8_000;
    paused.freeze = false;
    paused.advanceLimit = 20_000;
    await paused.engine.enqueue("codex", "resume");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(paused.sends, 1, "暂停解除且时钟仍滑动后应补发一次");
  } finally {
    paused.cleanup();
  }

  const stopped = await dueConfirm("stop", 0, true, {
    onWait: (ctx) => ctx.engine.stop(),
  });
  try {
    assert.equal(stopped.sends, 0);
    assert.equal(stopped.task?.status, "deferred");
    assert.equal(stopped.task?.error_category, "shutdown");
    assert.equal(stopped.task?.message_result, "not_sent");
    const recovered = new Engine({
      store: stopped.store,
      now: () => stopped.now,
      workDir: path.join(stopped.root, "recovered"),
      log: () => undefined,
      read: stopped.read,
      sleep: async (ms) => { stopped.now += ms; },
      confirmAccount: async () => true,
      send: async () => {
        stopped.sends += 1;
        return { outcome: "accepted", sessionId: "s", detail: "ok", started: true };
      },
    });
    recovered.recover();
    assert.equal(stopped.store.tasksByStatus(["deferred"]).some((row) => row.error_category === "shutdown" && row.message_result === "not_sent"), true);
    stopped.freeze = false;
    stopped.now += 8_000;
    await recovered.enqueue("codex", "startup");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(stopped.sends, 1, "退出时未发出的任务恢复后只发一次");
  } finally {
    stopped.cleanup();
  }

  const switched = await dueConfirm("account", 5_000, false, {
    onWait: (ctx) => { ctx.accountId = "other"; },
  });
  try {
    assert.equal(switched.sends, 0);
    assert.equal(switched.task?.error_category, "account_mismatch");
    assert.equal(switched.task?.message_result, "not_sent");
  } finally {
    switched.cleanup();
  }
});

interface DueRun {
  root: string;
  store: Store;
  engine: Engine;
  read: ReturnType<typeof createProviderRead>;
  now: number;
  sends: number;
  freeze: boolean;
  advanceLimit: number;
  accountId: string;
  confirmEvidence: string;
  task: ReturnType<Store["recentTasks"]>[number] | undefined;
  cleanup: () => void;
}

async function dueConfirm(
  name: string,
  advanceLimit: number,
  freezeReset: boolean,
  hooks: { onWait?: (ctx: DueRun) => void } = {},
): Promise<DueRun> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `aiquota5h-codex-${name}-`));
  const store = new Store(path.join(root, "state.sqlite"));
  const run = {
    root,
    store,
    now: START,
    sends: 0,
    freeze: freezeReset,
    advanceLimit,
    accountId: "acct",
    confirmEvidence: "",
    task: undefined,
  } as DueRun;
  let phase: "active" | "zero" | "slide" = "active";
  let waiting = false;
  let frozen = 0;
  let advanced = 0;
  const oldReset = START + 60_000;
  const newReset = oldReset + 5 * 60 * 60_000;
  const firstSampleAt = oldReset + 30_000;
  const holder: { engine?: Engine } = {};
  const read = createProviderRead({
    now: () => run.now,
    loadConfig: () => ({ cli: { codex: "codex" } }),
    priorsFor: () => store.windowPriors("codex"),
    readCodex: async (options) => {
      const sliding = newReset + (run.now - firstSampleAt);
      const resetAt = phase === "active" ? oldReset : waiting && run.freeze ? frozen : sliding;
      const snapshot = snapshotFrom(run.now, limits(
        { used: phase === "active" ? 25 : 0, resetAt },
        { used: 0, resetAt: START + 8 * 24 * 60 * 60_000 },
      ), options.priors, run.accountId);
      if (waiting) run.confirmEvidence = snapshot.pools[0]?.windows.find((item) => item.key === "5h")?.evidence.join(",") || "";
      return snapshot;
    },
  });
  const engine = new Engine({
    store,
    now: () => run.now,
    workDir: root,
    log: () => undefined,
    read,
    sleep: async (ms, signal) => {
      if (!waiting) {
        waiting = true;
        frozen = newReset + (run.now - firstSampleAt);
        hooks.onWait?.(run);
      }
      if (signal.aborted) throw new Error("aborted");
      const step = Math.min(ms, Math.max(0, run.advanceLimit - advanced));
      run.now += step;
      advanced += step;
    },
    confirmAccount: async () => true,
    send: async () => {
      run.sends += 1;
      return { outcome: "accepted", sessionId: "s", detail: "ok", started: true };
    },
  });
  holder.engine = engine;
  run.engine = engine;
  run.read = read;
  run.cleanup = () => {
    engine.stop();
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  };
  try {
    await engine.enqueue("codex", "startup");
    run.now = firstSampleAt;
    phase = "zero";
    await engine.enqueue("codex", "refresh");
    run.now = oldReset + 180_000;
    phase = "slide";
    await engine.enqueue("codex", "refresh");
    await new Promise((resolve) => setTimeout(resolve, 40));
    run.task = store.recentTasks()[0];
    return run;
  } catch (error) {
    run.cleanup();
    throw error;
  }
}
