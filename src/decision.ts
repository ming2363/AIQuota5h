import { GRACE_MS, type Decision, type PoolFact, type WindowFact } from "./types.js";

export const SAMPLE_MIN_MS = 5_000;

export function decide(pool: PoolFact, now: number, graceMs = GRACE_MS): Decision {
  const billingBlocksSend = pool.billingSafety !== "subscription_only";
  const allowanceUnknown = pool.windows.filter((window) => window.allowance === "unknown");
  const exhausted = pool.windows.filter((window) => window.allowance === "exhausted");
  const modeUnknown = pool.windows.filter(
    (window) => window.sharesRequest && window.activationMode === "unknown",
  );
  const targets = pool.windows.filter(
    (window) => window.sharesRequest && window.activationMode === "usage_started",
  );
  const stateUnknown = targets.filter((window) => window.state === "unknown");
  const unprovenKnownQuota = stateUnknown.filter(isUnprovenKnownQuota);
  const blockingUnknown = stateUnknown.filter((window) => !isUnprovenKnownQuota(window));
  const idle = targets.filter((window) => window.state === "idle");

  if (allowanceUnknown.length > 0) {
    return block("allowance_unknown", allowanceUnknown, billingBlocksSend);
  }
  if (exhausted.length > 0) {
    const resumeAt = exhausted
      .map((window) => window.resetAt)
      .filter((value): value is number => value != null && value > now)
      .sort((left, right) => left - right)[0] ?? null;
    return {
      action: "wait",
      dueAt: resumeAt,
      reason: "allowance_exhausted",
      windowKeys: exhausted.map((window) => window.key),
      billingBlocksSend,
    };
  }
  if (modeUnknown.length > 0) {
    return block("activation_mode_unknown", modeUnknown, billingBlocksSend);
  }
  if (blockingUnknown.length > 0) {
    return block("window_state_unknown", blockingUnknown, billingBlocksSend);
  }
  // Independent weekly caps do not trigger an extra request while a usage-started session is already active.
  const rollover = pool.windows.filter((window) => window.activationMode === "auto_reset" && (window.sharesRequest || targets.length === 0) && window.oldEndedAt != null && window.allowance === "allowed");
  if (idle.length === 0 && rollover.length > 0) {
    const dueAt = Math.max(...rollover.map((window) => (window.oldEndedAt as number) + graceMs));
    const keys = rollover.map((window) => window.key);
    if (billingBlocksSend) {
      return {
        action: "block",
        dueAt,
        reason: pool.billingSafety === "blocked" ? "billing_blocked" : "billing_safety_unknown",
        windowKeys: keys,
        billingBlocksSend: true,
      };
    }
    if (dueAt > now) return { action: "wait", dueAt, reason: "grace_pending", windowKeys: keys, billingBlocksSend: false };
    return { action: "send", dueAt, reason: "auto_reset_due", windowKeys: keys, billingBlocksSend: false };
  }
  if (idle.length === 0) {
    if (unprovenKnownQuota.length > 0) {
      return block("activation_unproven", unprovenKnownQuota, billingBlocksSend);
    }
    return {
      action: "skip",
      dueAt: null,
      reason: "no_idle_activation_target",
      windowKeys: [],
      billingBlocksSend,
    };
  }
  const missingBoundary = idle.filter((window) => window.oldEndedAt == null);
  if (missingBoundary.length > 0) {
    return block("old_boundary_unknown", missingBoundary, billingBlocksSend);
  }
  const dueAt = Math.max(...idle.map((window) => (window.oldEndedAt as number) + graceMs));
  if (billingBlocksSend) {
    return {
      action: "block",
      dueAt,
      reason: pool.billingSafety === "blocked" ? "billing_blocked" : "billing_safety_unknown",
      windowKeys: idle.map((window) => window.key),
      billingBlocksSend: true,
    };
  }
  if (dueAt > now) {
    return {
      action: "wait",
      dueAt,
      reason: "grace_pending",
      windowKeys: idle.map((window) => window.key),
      billingBlocksSend: false,
    };
  }
  return {
    action: "send",
    dueAt,
    reason: "idle_due",
    windowKeys: idle.map((window) => window.key),
    billingBlocksSend: false,
  };
}

function trustedOldEnd(prior: PriorWindow | null, now: number): number | null {
  if (!prior) return null;
  if (prior.preservedBoundary != null && prior.preservedBoundary <= now) return prior.preservedBoundary;
  if (prior.state === "active" && prior.resetAt != null && prior.resetAt <= now) return prior.resetAt;
  return null;
}

function newWindowClock(prior: PriorWindow | null, resetAt: number, now: number): "anchored" | "sliding" | "unknown" {
  if (!prior?.observedAt || prior.resetAt == null || prior.resetAt <= prior.observedAt) return "unknown";
  if (prior.state === "active" && prior.resetAt <= now) return "unknown";
  return clockFromSamples([
    { at: prior.observedAt, resetAt: prior.resetAt },
    { at: now, resetAt },
  ]);
}

function isUnprovenKnownQuota(window: WindowFact): boolean {
  return window.allowance === "allowed" && window.evidence.some((item) => item === "used_percent_zero_not_proof" || item === "future_reset_is_not_proof_of_first_use");
}

function block(reason: string, windows: WindowFact[], billingBlocksSend: boolean): Decision {
  return {
    action: "block",
    dueAt: null,
    reason,
    windowKeys: windows.map((window) => window.key),
    billingBlocksSend,
  };
}

export interface ObservedWindow {
  key: string;
  kind: string;
  resetAt: number | null;
  durationMs: number | null;
  usedPercent: number | null;
  remainingFraction: number | null;
  usageText: string;
  clock: "anchored" | "sliding" | "absent" | "unknown";
  activationHint: "usage_started" | "auto_reset" | "unknown";
  sharesRequest: boolean;
}

export interface ClassifiedWindow {
  key: string;
  kind: string;
  activationMode: "usage_started" | "auto_reset" | "unknown";
  state: "active" | "idle" | "unknown";
  oldEndedAt: number | null;
  resetAt: number | null;
  allowance: "allowed" | "exhausted" | "unknown";
  sharesRequest: boolean;
  evidence: string[];
  windowId: string;
  preservedBoundary: number | null;
}

export interface PriorWindow {
  key: string;
  resetAt: number | null;
  preservedBoundary: number | null;
  windowId: string;
  accountId?: string;
  poolId?: string;
  state?: "active" | "idle" | "unknown";
  observedAt?: number | null;
}

/** 百分比取整、未来 resetAt、100% 剩余都不能单独判定窗口已启动。 */
export function classifyWindow(
  observed: ObservedWindow,
  prior: PriorWindow | null,
  now: number,
): ClassifiedWindow {
  const evidence: string[] = [`clock=${observed.clock}`];
  const usageRecorded = usageIsRecorded(observed, evidence);
  const allowance = allowanceOf(observed, evidence);
  const activationMode = observed.activationHint;
  const resetAt = observed.clock === "sliding" ? null : observed.resetAt;
  let preservedBoundary = prior?.preservedBoundary ?? null;
  let state: ClassifiedWindow["state"] = "unknown";
  let oldEndedAt: number | null = null;

  if (activationMode === "auto_reset") {
    state = resetAt != null && resetAt > now ? "active" : observed.resetAt != null && observed.resetAt <= now ? "idle" : "unknown";
    evidence.push("auto_reset_no_grace");
    if (state === "idle" && observed.resetAt != null && observed.resetAt <= now) {
      oldEndedAt = observed.resetAt;
      evidence.push("server_past_boundary");
    }
    return finish(observed, activationMode, state, oldEndedAt, resetAt, allowance, evidence, preservedBoundary);
  }

  if (usageRecorded === true && observed.clock === "anchored" && observed.resetAt != null && observed.resetAt > now) {
    state = "active";
    preservedBoundary = null;
    evidence.push("usage_recorded_and_anchored_reset");
    return finish(observed, activationMode, state, null, observed.resetAt, allowance, evidence, preservedBoundary);
  }

  if (observed.clock === "sliding" && usageRecorded === false) {
    state = "idle";
    evidence.push("sliding_reset_matches_unstarted_window");
    if (prior?.resetAt != null && prior.resetAt <= now) {
      preservedBoundary = prior.resetAt;
      oldEndedAt = prior.resetAt;
      evidence.push("preserved_previous_anchored_end");
    } else if (preservedBoundary != null && preservedBoundary <= now) {
      oldEndedAt = preservedBoundary;
      evidence.push("preserved_old_boundary");
    } else {
      oldEndedAt = null;
      evidence.push("old_boundary_not_on_server");
    }
    return finish(observed, "usage_started", state, oldEndedAt, null, allowance, evidence, preservedBoundary ?? oldEndedAt);
  }

  if ((observed.clock === "absent" || (observed.resetAt != null && observed.resetAt <= now)) && usageRecorded !== true) {
    const boundary = observed.resetAt != null && observed.resetAt <= now
      ? observed.resetAt
      : prior?.resetAt != null && prior.resetAt <= now
        ? prior.resetAt
        : preservedBoundary != null && preservedBoundary <= now
          ? preservedBoundary
          : null;
    if (boundary != null) {
      state = "idle";
      oldEndedAt = boundary;
      preservedBoundary = boundary;
      evidence.push("server_or_preserved_past_boundary_without_new_clock");
    } else {
      state = "unknown";
      evidence.push("no_past_boundary");
    }
    return finish(observed, activationMode === "unknown" ? "usage_started" : activationMode, state, oldEndedAt, observed.resetAt, allowance, evidence, preservedBoundary);
  }

  if (observed.clock === "anchored" && observed.resetAt != null && observed.resetAt > now && usageRecorded !== true) {
    const sameReset = prior?.resetAt != null && Math.abs(observed.resetAt - prior.resetAt) <= 1000;
    if (sameReset && prior?.state === "active") {
      evidence.push("same_reset_prior_active_zero_is_rounding");
      return finish(observed, activationMode, "active", null, observed.resetAt, allowance, evidence, null);
    }
    const trustedEnd = trustedOldEnd(prior, now);
    if (prior?.state === "idle" && trustedEnd != null && prior.resetAt != null && prior.observedAt != null) {
      const wall = now - prior.observedAt;
      const sampled = clockFromSamples([
        { at: prior.observedAt, resetAt: prior.resetAt },
        { at: now, resetAt: observed.resetAt },
      ]);
      if (sampled === "sliding") {
        evidence.push("resampled_reset_still_slides");
        return finish(observed, activationMode, "idle", trustedEnd, observed.resetAt, allowance, evidence, trustedEnd);
      }
      evidence.push(wall < SAMPLE_MIN_MS ? "sample_interval_too_short" : "resampled_reset_no_longer_slides");
      return finish(observed, activationMode, "unknown", null, observed.resetAt, allowance, evidence, trustedEnd);
    }
    const sampled = newWindowClock(prior, observed.resetAt, now);
    if (sampled === "sliding") {
      evidence.push("sampled_reset_slides_with_wall_clock");
      if (trustedEnd != null) evidence.push("trusted_previous_active_end");
      else evidence.push("old_boundary_not_on_server");
      return finish(observed, activationMode, "idle", trustedEnd, observed.resetAt, allowance, evidence, trustedEnd);
    }
    if (sampled === "anchored") evidence.push("sampled_reset_anchored_zero_not_unstarted");
    else evidence.push("future_reset_is_not_proof_of_first_use");
    return finish(observed, activationMode, "unknown", null, observed.resetAt, allowance, evidence, trustedEnd);
  }

  evidence.push("insufficient_window_evidence");
  return finish(observed, activationMode, "unknown", preservedBoundary != null && preservedBoundary <= now ? preservedBoundary : null, resetAt, allowance, evidence, preservedBoundary);
}

function usageIsRecorded(observed: ObservedWindow, evidence: string[]): boolean | null {
  if (observed.usedPercent != null && observed.usedPercent > 0) {
    evidence.push("used_percent_positive");
    return true;
  }
  if (/you have used|已使用/i.test(observed.usageText)) {
    evidence.push("server_usage_text");
    return true;
  }
  if (observed.usedPercent === 0) evidence.push("used_percent_zero_not_proof");
  if (observed.remainingFraction != null && observed.remainingFraction >= 0.999999) {
    evidence.push("remaining_full_not_proof");
  }
  if (
    observed.clock === "sliding"
    && observed.remainingFraction != null
    && observed.remainingFraction >= 0.999999
    && !/you have used|已使用/i.test(observed.usageText)
  ) {
    evidence.push("sliding_full_remaining_without_usage_text");
    return false;
  }
  if (observed.remainingFraction != null && observed.remainingFraction < 0.999) {
    evidence.push("remaining_below_rounding_floor");
    return true;
  }
  return null;
}

function allowanceOf(observed: ObservedWindow, evidence: string[]): "allowed" | "exhausted" | "unknown" {
  if (observed.usedPercent != null && observed.usedPercent >= 100) {
    evidence.push("used_percent_exhausted");
    return "exhausted";
  }
  if (observed.remainingFraction != null && observed.remainingFraction <= 0) {
    evidence.push("remaining_exhausted");
    return "exhausted";
  }
  if (observed.usedPercent != null && observed.usedPercent < 100) return "allowed";
  if (observed.remainingFraction != null && observed.remainingFraction > 0) return "allowed";
  evidence.push("allowance_unknown");
  return "unknown";
}

function finish(
  observed: ObservedWindow,
  activationMode: ClassifiedWindow["activationMode"],
  state: ClassifiedWindow["state"],
  oldEndedAt: number | null,
  resetAt: number | null,
  allowance: ClassifiedWindow["allowance"],
  evidence: string[],
  preservedBoundary: number | null,
): ClassifiedWindow {
  const windowId = resetAt != null
    ? `${observed.key}:${resetAt}`
    : oldEndedAt != null
      ? `${observed.key}:ended:${oldEndedAt}`
      : `${observed.key}:unbounded`;
  return {
    key: observed.key,
    kind: observed.kind,
    activationMode,
    state,
    oldEndedAt,
    resetAt,
    allowance,
    sharesRequest: observed.sharesRequest,
    evidence,
    windowId,
    preservedBoundary,
  };
}

export function clockFromSamples(samples: Array<{ at: number; resetAt: number }>): "anchored" | "sliding" | "unknown" {
  if (samples.length < 2) return "unknown";
  const wall = samples[1].at - samples[0].at;
  const reset = samples[1].resetAt - samples[0].resetAt;
  if (wall < SAMPLE_MIN_MS || reset <= 0) {
    if (wall >= SAMPLE_MIN_MS && Math.abs(reset) <= 1_000) return "anchored";
    return "unknown";
  }
  if (Math.abs(reset - wall) <= 2_000) return "sliding";
  if (Math.abs(reset) <= 1_000) return "anchored";
  return "unknown";
}
