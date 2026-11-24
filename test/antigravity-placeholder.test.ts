import assert from "node:assert/strict";
import test from "node:test";
import { decide } from "../src/decision.js";
import { mapGroups } from "../src/providers/antigravity.js";

// 复现 2026-11-05 现场数据：claude-gpt 周额度 17:28:51 到期后，服务端给出“旧重置时间 + 7 天”的固定占位时间，
// 剩余精确为 1、没有任何使用文字；5 小时窗口同时未开始计时（重置时间随查询滑动）。
const OLD_END = Date.parse("2026-11-05T09:28:51Z");
const WEEK = 7 * 24 * 60 * 60_000;
const NOW = OLD_END + 6 * 60_000;

function groups(now: number, weekly: { remainingFraction: number; resetAt: number; description?: string }) {
  return [{
    displayName: "Claude and GPT models",
    buckets: [
      { bucketId: "3p-weekly", window: "weekly", remainingFraction: weekly.remainingFraction, resetTime: new Date(weekly.resetAt).toISOString(), description: weekly.description },
      { bucketId: "3p-5h", window: "5h", remainingFraction: 1, resetTime: new Date(now + 5 * 60 * 60_000).toISOString() },
    ],
  }];
}

function pool(weekly: { remainingFraction: number; resetAt: number; description?: string }, priorWeekly: { state: "active" | "idle" | "unknown"; resetAt: number | null }) {
  return mapGroups({
    email: "a@example.com",
    groups: groups(NOW, weekly),
    secondGroups: groups(NOW + 8_000, weekly),
    now: NOW,
    priors: [
      { key: "weekly", poolId: "claude-gpt", windowId: "weekly:x", preservedBoundary: null, observedAt: OLD_END - 60_000, ...priorWeekly },
      { key: "5h", poolId: "claude-gpt", windowId: "5h:unbounded", resetAt: null, preservedBoundary: OLD_END + 60_000, state: "idle", observedAt: NOW - 60_000 },
    ],
    credits: 0,
    consistent: true,
    isolation: { ok: true, reason: "" },
  })[0];
}

test("周额度到期后精确满额、重置时间固定：判为固定日程进行中，不拦截池子，只激活未开始的 5 小时窗口", () => {
  // 2026-11-05 实测：发送请求后 claude-gpt 周额度重置时间仍是“旧重置 + 7 天”，周额度按固定日程重置
  const facts = pool({ remainingFraction: 1, resetAt: OLD_END + WEEK }, { state: "active", resetAt: OLD_END });
  const weekly = facts.windows.find((item) => item.key === "weekly")!;
  assert.equal(weekly.state, "active");
  assert.equal(weekly.activationMode, "auto_reset");
  assert.equal(weekly.resetAt, OLD_END + WEEK, "固定日程的重置时间是真实时间，照常展示");
  const decision = decide(facts, NOW);
  assert.equal(decision.action, "send");
  assert.equal(decision.reason, "idle_due");
  assert.deepEqual(decision.windowKeys, ["5h"]);
});

test("周额度已有使用文字或非满额时保持进行中，不触发激活", () => {
  const used = pool(
    { remainingFraction: 0.9963, resetAt: NOW + WEEK - 60_000, description: "You have used some of your weekly limit, it will fully refresh in 6 days, 23 hours." },
    { state: "active", resetAt: NOW + WEEK - 60_000 },
  );
  const weekly = used.windows.find((item) => item.key === "weekly")!;
  assert.equal(weekly.state, "active");
  // 5 小时窗口在本夹具里未开始计时，可以激活；周窗口不能成为激活目标
  assert.ok(!decide(used, NOW).windowKeys.includes("weekly"));
});

test("CLI 取整百分比的 100% 不能证明零用量", () => {
  const facts = mapGroups({
    email: "a@example.com",
    groups: [{ displayName: "Claude and GPT models", buckets: [{ bucketId: "claude-gpt-weekly", window: "weekly", remainingFraction: 1, resetTime: new Date(OLD_END + WEEK).toISOString(), description: "", precision: "rounded" }] }],
    secondGroups: [],
    now: NOW,
    priors: [{ key: "weekly", poolId: "claude-gpt", windowId: "weekly:x", preservedBoundary: null, observedAt: OLD_END - 60_000, state: "active", resetAt: OLD_END }],
    credits: 0,
    consistent: true,
    isolation: { ok: true, reason: "" },
  })[0];
  const weekly = facts.windows[0];
  assert.notEqual(weekly.state, "idle");
  assert.notEqual(weekly.activationMode, "auto_reset", "取整的 100% 不能证明固定日程");
});

test("Antigravity 各额度池历史边界不跨池串用", () => {
  const claude5hEnd = OLD_END + 20_000;
  const facts = mapGroups({
    email: "a@example.com",
    groups: [
      {
        displayName: "Claude and GPT models",
        buckets: [
          { bucketId: "claude-gpt-5h", window: "5h", remainingFraction: 1, resetTime: new Date(NOW + 5 * 60 * 60_000).toISOString() },
          { bucketId: "claude-gpt-weekly", window: "weekly", remainingFraction: 1, resetTime: new Date(OLD_END + WEEK).toISOString() },
        ],
      },
      {
        displayName: "Gemini",
        buckets: [
          { bucketId: "gemini-5h", window: "5h", remainingFraction: 1, resetTime: new Date(NOW + 5 * 60 * 60_000).toISOString() },
          { bucketId: "gemini-weekly", window: "weekly", remainingFraction: 1, resetTime: new Date(NOW + WEEK).toISOString() },
        ],
      },
    ],
    secondGroups: [
      {
        displayName: "Claude and GPT models",
        buckets: [
          { bucketId: "claude-gpt-5h", window: "5h", remainingFraction: 1, resetTime: new Date(NOW + 8_000 + 5 * 60 * 60_000).toISOString() },
          { bucketId: "claude-gpt-weekly", window: "weekly", remainingFraction: 1, resetTime: new Date(OLD_END + WEEK).toISOString() },
        ],
      },
      {
        displayName: "Gemini",
        buckets: [
          { bucketId: "gemini-5h", window: "5h", remainingFraction: 1, resetTime: new Date(NOW + 8_000 + 5 * 60 * 60_000).toISOString() },
          { bucketId: "gemini-weekly", window: "weekly", remainingFraction: 1, resetTime: new Date(NOW + 8_000 + WEEK).toISOString() },
        ],
      },
    ],
    now: NOW,
    priors: [
      { key: "5h", poolId: "claude-gpt", windowId: "5h:unbounded", resetAt: null, preservedBoundary: claude5hEnd, state: "idle", observedAt: NOW - 60_000 },
      { key: "weekly", poolId: "claude-gpt", windowId: "weekly:x", preservedBoundary: null, observedAt: OLD_END - 60_000, state: "active", resetAt: OLD_END },
    ],
    credits: 0,
    consistent: true,
    isolation: { ok: true, reason: "" },
  });
  const claude = facts.find((poolItem) => poolItem.poolId === "claude-gpt")!;
  const gemini = facts.find((poolItem) => poolItem.poolId === "gemini")!;
  assert.equal(claude.windows.find((w) => w.key === "5h")?.oldEndedAt, claude5hEnd);
  assert.equal(gemini.windows.find((w) => w.key === "5h")?.oldEndedAt, null, "gemini 不能借用 claude-gpt 的 5h 历史边界");
  assert.equal(gemini.windows.find((w) => w.key === "weekly")?.activationMode, "usage_started", "gemini weekly 不能借用 claude-gpt weekly 的固定日程 prior");
});

test("Antigravity 固定日程 weekly 不设 sharesRequest，到期切换不误触发 auto_reset_due", () => {
  const facts = pool({ remainingFraction: 1, resetAt: OLD_END + WEEK }, { state: "active", resetAt: OLD_END });
  const weekly = facts.windows.find((item) => item.key === "weekly")!;
  assert.equal(weekly.activationMode, "auto_reset");
  assert.equal(weekly.sharesRequest, false);
  // 若 5h 也已 active，固定日程 weekly 的 prior 到期切换不能因为 sharesRequest=true 而误发请求
  const active5h = { ...facts.windows.find((item) => item.key === "5h")!, state: "active" as const, oldEndedAt: null, resetAt: NOW + 4 * 60 * 60_000 };
  const decision = decide({ ...facts, windows: [active5h, weekly] }, NOW);
  assert.equal(decision.action, "skip");
  assert.equal(decision.reason, "no_idle_activation_target");
});
