import type { WindowFact } from "./types.js";

export const VERIFY_STALL_MS = 30 * 60_000;
export const CONFIRM_SLACK_MS = 30 * 60_000;
export const PERIOD_PRECISION_MS = 5_000;

type ActivationTask = {
  window_key: string;
  old_ended_at: number;
  claimed_at?: number | null;
  status: string;
  error_category: string | null;
};
type ActivationWindow = Pick<WindowFact, "key" | "state" | "activationMode" | "oldEndedAt" | "resetAt">;

export function windowDurationMs(key: string): number {
  return key === "weekly" ? 7 * 24 * 60 * 60_000 : 5 * 60 * 60_000;
}

export function laterPeriodProven(
  task: { window_key: string; old_ended_at: number; claimed_at?: number | null; updated_at?: number },
  window: ActivationWindow,
  now: number,
): boolean {
  const sentAt = task.claimed_at ?? null;
  if (sentAt == null || window.key !== task.window_key) return false;
  if (window.activationMode === "usage_started" && window.state === "active" && window.resetAt != null && window.resetAt > now) {
    const startedAt = window.resetAt - windowDurationMs(window.key);
    return startedAt <= now && startedAt > sentAt + CONFIRM_SLACK_MS;
  }
  if (window.oldEndedAt == null || window.oldEndedAt > now) return false;
  if (window.oldEndedAt <= sentAt) return false;
  if (Math.abs(window.oldEndedAt - task.old_ended_at) <= PERIOD_PRECISION_MS) return false;
  const periodStart = window.oldEndedAt - windowDurationMs(window.key);
  return periodStart + PERIOD_PRECISION_MS >= sentAt;
}

/** 历史未确认任务仍保留去重保护，只有窗口证据证明已进入后续周期才放行。 */
export function blocksActivation(task: ActivationTask, window: ActivationWindow | undefined, now: number): boolean {
  if (task.status === "in_flight") return true;
  if (!["verifying", "unknown_result", "stalled"].includes(task.status) && task.error_category !== "period_unconfirmed") return false;
  return !window || !laterPeriodProven(task, window, now);
}

export function confirmsTask(
  task: { window_key: string; old_ended_at: number; claimed_at?: number | null; updated_at: number; message_result?: string | null },
  window: WindowFact,
  now: number,
): boolean {
  if (task.message_result != null && task.message_result !== "accepted") return false;
  if (window.key !== task.window_key || window.state !== "active" || window.resetAt == null || window.resetAt <= now) return false;
  const startedAt = window.resetAt - windowDurationMs(window.key);
  const sentAt = task.claimed_at ?? task.updated_at;
  if (startedAt + PERIOD_PRECISION_MS < sentAt) return false;
  if (startedAt > sentAt + CONFIRM_SLACK_MS) return false;
  if (startedAt + 120_000 < task.old_ended_at) return false;
  return true;
}
