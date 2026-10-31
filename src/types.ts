export const GRACE_MS = 65_000;
export const REFRESH_MS = 60_000;
export const CLAUDE_REFRESH_MS = 120_000;
export function providerRefreshMs(provider: string): number { return provider === "claude" ? CLAUDE_REFRESH_MS : REFRESH_MS; }
export const DUE_SLACK_MS = 5_000;
export const WATCHDOG_MS = 10_000;
export const VERIFY_DELAYS_MS = [5_000, 15_000, 30_000] as const;

export type ProviderId = "codex" | "claude" | "antigravity" | "grok";
export type WindowState = "active" | "idle" | "unknown";
export type ActivationMode = "usage_started" | "auto_reset" | "unknown";
export type Allowance = "allowed" | "exhausted" | "unknown";
export type BillingSafety = "subscription_only" | "billing_safety_unknown" | "blocked";
export type ClockKind = "anchored" | "sliding" | "absent" | "unknown";
export type TaskStatus =
  | "pending"
  | "in_flight"
  | "verifying"
  | "confirmed"
  | "skipped"
  | "blocked"
  | "deferred"
  | "unknown_result"
  | "stalled";

export interface WindowFact {
  key: string;
  kind: string;
  activationMode: ActivationMode;
  state: WindowState;
  oldEndedAt: number | null;
  resetAt: number | null;
  allowance: Allowance;
  remainingFraction?: number | null;
  sharesRequest: boolean;
  evidence: string[];
  windowId: string;
  preservedBoundary?: number | null;
}

export interface PoolFact {
  provider: ProviderId;
  accountId: string;
  accountLabel: string;
  poolId: string;
  models: string[];
  selectedModel: string | null;
  billingSafety: BillingSafety;
  billingEvidence: string[];
  windows: WindowFact[];
  observedAt: number;
  blockReason?: string;
}

export interface ProviderSnapshot {
  provider: ProviderId;
  accountId: string;
  accountLabel: string;
  authMode: string;
  appCliConsistent: boolean | null;
  consistencyEvidence: string;
  pools: PoolFact[];
  observedAt: number;
  rawSummary: string;
}

export interface ProviderReadError {
  provider: ProviderId;
  category: "unauthorized" | "rate_limited" | "network" | "protocol" | "unavailable" | "account_mismatch";
  message: string;
  retryAfterMs: number | null;
}

export interface SendRequest {
  provider: ProviderId;
  accountId: string;
  poolId: string;
  model: string;
  prompt: string;
  workDir: string;
}

export interface SendResult {
  outcome: "accepted" | "not_sent" | "unknown";
  sessionId: string | null;
  detail: string;
  started: boolean;
  acceptance?: "turn_completed" | "thread_only" | "none";
  usageTokens?: number | null;
  errorCategory?: ProviderReadError["category"];
  retryAfterMs?: number;
}

export interface Decision {
  action: "send" | "wait" | "skip" | "block";
  dueAt: number | null;
  reason: string;
  windowKeys: string[];
  billingBlocksSend: boolean;
}

export const SHORT_PROMPT = "只回复 OK，不调用工具，不读取或修改文件";
