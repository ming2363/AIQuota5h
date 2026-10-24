import assert from "node:assert/strict";
import test from "node:test";
import { classifyWindow, clockFromSamples, decide } from "../src/decision.js";
import type { PoolFact, WindowFact } from "../src/types.js";

const NOW = 1_000_000_000_000;

function window(partial: Partial<WindowFact> & Pick<WindowFact, "key">): WindowFact {
  return {
    key: partial.key,
    kind: partial.kind || partial.key,
    activationMode: partial.activationMode || "usage_started",
    state: partial.state || "idle",
    oldEndedAt: partial.oldEndedAt === undefined ? NOW - 180_000 : partial.oldEndedAt,
    resetAt: partial.resetAt ?? null,
    allowance: partial.allowance || "allowed",
    sharesRequest: partial.sharesRequest ?? true,
    evidence: partial.evidence || ["test"],
    windowId: partial.windowId || `${partial.key}:ended`,
  };
}

function pool(windows: WindowFact[], billing: PoolFact["billingSafety"] = "subscription_only"): PoolFact {
  return {
    provider: "codex",
    accountId: "acct",
    accountLabel: "a***@example.com",
    poolId: "codex",
    models: ["gpt-5.6-luna"],
    selectedModel: "gpt-5.6-luna",
    billingSafety: billing,
    billingEvidence: [],
    windows,
    observedAt: NOW,
  };
}

test("到期前与 119 秒不发送，满 120 秒才发送", () => {
  const ended = NOW - 119_000;
  const early = decide(pool([window({ key: "5h", oldEndedAt: ended })]), NOW);
  assert.equal(early.action, "wait");
  assert.equal(early.reason, "grace_pending");
  const due = decide(pool([window({ key: "5h", oldEndedAt: NOW - 120_000 })]), NOW);
  assert.equal(due.action, "send");
  const beforeEnd = decide(pool([window({ key: "5h", state: "active", oldEndedAt: null, resetAt: NOW + 60_000 })]), NOW);
  assert.equal(beforeEnd.action, "skip");
});

test("用户已手动激活则跳过", () => {
  const result = decide(pool([window({ key: "5h", state: "active", oldEndedAt: null, resetAt: NOW + 60_000 })]), NOW);
  assert.equal(result.action, "skip");
});

test("未来 reset 但未证明使用时不能当 active", () => {
  const classified = classifyWindow({
    key: "5h",
    kind: "session",
    resetAt: NOW + 300_000,
    durationMs: 300_000,
    usedPercent: 0,
    remainingFraction: 1,
    usageText: "",
    clock: "anchored",
    activationHint: "usage_started",
    sharesRequest: true,
  }, null, NOW);
  assert.equal(classified.state, "unknown");
  assert.match(classified.evidence.join(","), /future_reset_is_not_proof/);
});

test("100% 与百分比取整不能单独证明 idle 或 active", () => {
  const rounded = classifyWindow({
    key: "5h",
    kind: "session",
    resetAt: NOW + 10_000,
    durationMs: 300_000,
    usedPercent: 0,
    remainingFraction: 1,
    usageText: "",
    clock: "anchored",
    activationHint: "usage_started",
    sharesRequest: true,
  }, null, NOW);
  assert.equal(rounded.state, "unknown");
  assert.match(rounded.evidence.join(","), /used_percent_zero_not_proof/);
});

test("滑动时钟加未使用文本可以证明 idle，但没有旧边界不能发送", () => {
  const classified = classifyWindow({
    key: "5h",
    kind: "session",
    resetAt: NOW + 5 * 60 * 60_000,
    durationMs: 5 * 60 * 60_000,
    usedPercent: null,
    remainingFraction: 1,
    usageText: "",
    clock: "sliding",
    activationHint: "usage_started",
    sharesRequest: true,
  }, null, NOW);
  assert.equal(classified.state, "idle");
  assert.equal(classified.oldEndedAt, null);
  const result = decide(pool([window({
    key: "5h",
    state: "idle",
    oldEndedAt: null,
    evidence: classified.evidence,
  })]), NOW);
  assert.equal(result.action, "block");
  assert.equal(result.reason, "old_boundary_unknown");
});

test("服务端过去边界超过 120 秒时首次运行立即发送", () => {
  const classified = classifyWindow({
    key: "5h",
    kind: "session",
    resetAt: NOW - 180_000,
    durationMs: 300_000,
    usedPercent: 0,
    remainingFraction: null,
    usageText: "",
    clock: "absent",
    activationHint: "usage_started",
    sharesRequest: true,
  }, null, NOW);
  assert.equal(classified.state, "idle");
  assert.equal(classified.oldEndedAt, NOW - 180_000);
  assert.equal(decide(pool([window({ key: "5h", oldEndedAt: classified.oldEndedAt })]), NOW).action, "send");
});

test("同池多窗口合并一次，不同池由调用方分别决策", () => {
  const merged = decide(pool([
    window({ key: "5h", oldEndedAt: NOW - 200_000 }),
    window({ key: "weekly", oldEndedAt: NOW - 180_000 }),
  ]), NOW);
  assert.equal(merged.action, "send");
  assert.deepEqual(merged.windowKeys.sort(), ["5h", "weekly"]);
});

test("同池一个 active 不跳过另一个到期 idle", () => {
  const result = decide(pool([
    window({ key: "weekly", state: "active", oldEndedAt: null, resetAt: NOW + 86_400_000 }),
    window({ key: "5h", oldEndedAt: NOW - 180_000 }),
  ]), NOW);
  assert.equal(result.action, "send");
  assert.deepEqual(result.windowKeys, ["5h"]);
});

test("五小时恢复但周额度耗尽时不发送", () => {
  const result = decide(pool([
    window({ key: "5h", oldEndedAt: NOW - 180_000 }),
    window({ key: "weekly", state: "active", allowance: "exhausted", oldEndedAt: null, resetAt: NOW + 86_400_000, sharesRequest: true }),
  ]), NOW);
  assert.equal(result.action, "wait");
  assert.equal(result.reason, "allowance_exhausted");
});

test("同请求会启动的周窗口未满 120 秒时等待，满 120 秒才合并", () => {
  const wait = decide(pool([
    window({ key: "5h", oldEndedAt: NOW - 180_000 }),
    window({ key: "weekly", oldEndedAt: NOW - 119_000 }),
  ]), NOW);
  assert.equal(wait.action, "wait");
  assert.equal(wait.dueAt, NOW - 119_000 + 120_000);
  const send = decide(pool([
    window({ key: "5h", oldEndedAt: NOW - 180_000 }),
    window({ key: "weekly", oldEndedAt: NOW - 120_000 }),
  ]), NOW);
  assert.equal(send.action, "send");
});

test("周限制自动恢复不另加宽限", () => {
  const result = decide(pool([
    window({ key: "5h", oldEndedAt: NOW - 180_000 }),
    window({ key: "weekly", activationMode: "auto_reset", state: "active", oldEndedAt: null, resetAt: NOW + 1_000, sharesRequest: false }),
  ]), NOW);
  assert.equal(result.action, "send");
});

test("付费回退未知时禁止发送", () => {
  const result = decide(pool([window({ key: "5h", oldEndedAt: NOW - 180_000 })], "billing_safety_unknown"), NOW);
  assert.equal(result.action, "block");
  assert.equal(result.reason, "billing_safety_unknown");
});

test("自动恢复的当前周期不补发，费用未知或 blocked 的周期切换也不发送", () => {
  const current = decide(pool([
    window({ key: "weekly", activationMode: "auto_reset", state: "active", sharesRequest: false, oldEndedAt: null, resetAt: NOW + 86_400_000 }),
  ], "billing_safety_unknown"), NOW);
  assert.equal(current.action, "skip");
  const unknown = decide(pool([
    window({ key: "weekly", activationMode: "auto_reset", state: "active", sharesRequest: false, oldEndedAt: NOW - 180_000, resetAt: NOW + 86_400_000 }),
  ], "billing_safety_unknown"), NOW);
  assert.equal(unknown.action, "block");
  assert.equal(unknown.reason, "billing_safety_unknown");
  const blocked = decide(pool([
    window({ key: "weekly", activationMode: "auto_reset", state: "active", sharesRequest: false, oldEndedAt: NOW - 180_000, resetAt: NOW + 86_400_000 }),
  ], "blocked"), NOW);
  assert.equal(blocked.action, "block");
  assert.equal(blocked.reason, "billing_blocked");
  const exhausted = decide(pool([
    window({ key: "weekly", activationMode: "auto_reset", state: "active", allowance: "exhausted", sharesRequest: false, oldEndedAt: NOW - 180_000, resetAt: NOW + 86_400_000 }),
  ]), NOW);
  assert.notEqual(exhausted.action, "send");
  const due = decide(pool([
    window({ key: "weekly", activationMode: "auto_reset", state: "active", sharesRequest: false, oldEndedAt: NOW - 120_000, resetAt: NOW + 86_400_000 }),
  ]), NOW);
  assert.equal(due.action, "send");
  assert.equal(due.reason, "auto_reset_due");
});

test("旧 reset 已过去但仍有正使用率时不能当 idle", () => {
  const classified = classifyWindow({
    key: "5h",
    kind: "session",
    resetAt: NOW - 60_000,
    durationMs: 300_000,
    usedPercent: 24,
    remainingFraction: 0.76,
    usageText: "",
    clock: "anchored",
    activationHint: "usage_started",
    sharesRequest: true,
  }, null, NOW);
  assert.equal(classified.state, "unknown");
  assert.equal(classified.allowance, "allowed");
  const exhausted = classifyWindow({
    key: "5h",
    kind: "session",
    resetAt: NOW - 60_000,
    durationMs: 300_000,
    usedPercent: 100,
    remainingFraction: 0,
    usageText: "",
    clock: "anchored",
    activationHint: "usage_started",
    sharesRequest: true,
  }, null, NOW);
  assert.equal(exhausted.allowance, "exhausted");
  assert.notEqual(exhausted.state, "idle");
});

test("时钟滑动与锚定样本", () => {
  assert.equal(clockFromSamples([{ at: 0, resetAt: 10_000 }, { at: 8_000, resetAt: 18_000 }]), "sliding");
  assert.equal(clockFromSamples([{ at: 0, resetAt: 10_000 }, { at: 8_000, resetAt: 10_000 }]), "anchored");
});
