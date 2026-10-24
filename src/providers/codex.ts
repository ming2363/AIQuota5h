import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isShuttingDown, runCommand, safeEnv } from "../proc.js";
import { redactJson } from "../redact.js";
import type { PoolFact, ProviderReadError, ProviderSnapshot, SendRequest, SendResult, WindowFact } from "../types.js";
import { classifyWindow, type PriorWindow } from "../decision.js";
import { openRpc } from "./rpc.js";

export interface CodexPaths {
  command: string;
  authPath?: string;
}

export function resolveCodexAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = String(env.CODEX_HOME || "").trim() || path.join(os.homedir(), ".codex");
  return path.join(home, "auth.json");
}

export function readCodexAccountId(authPath = resolveCodexAuthPath()): {
  accountId: string;
  authMode: string;
  hasApiKey: boolean;
} {
  const raw = JSON.parse(fs.readFileSync(authPath, "utf8")) as {
    auth_mode?: string;
    OPENAI_API_KEY?: string | null;
    tokens?: { account_id?: string };
  };
  const accountId = String(raw.tokens?.account_id || "").trim();
  if (!accountId) throw new Error("Codex 稳定账号标识缺失");
  return {
    accountId,
    authMode: String(raw.auth_mode || ""),
    hasApiKey: Boolean(raw.OPENAI_API_KEY),
  };
}

export async function readCodex(options: {
  command: string;
  now?: number;
  priors?: PriorWindow[];
  signal?: AbortSignal;
}): Promise<ProviderSnapshot | ProviderReadError> {
  if (options.signal?.aborted) {
    return { provider: "codex", category: "unavailable", message: "读取已取消", retryAfterMs: 15_000 };
  }
  const now = options.now ?? Date.now();
  const authPath = resolveCodexAuthPath();
  let identity;
  try {
    identity = readCodexAccountId(authPath);
  } catch (error) {
    return { provider: "codex", category: "unauthorized", message: error instanceof Error ? error.message : String(error), retryAfterMs: null };
  }
  const rpc = await openRpc(options.command, ["app-server", "--listen", "stdio://"], 20_000, safeEnv(), options.signal);
  try {
    await rpc.request("initialize", {
      clientInfo: { name: "aiquota5h", title: "AIQuota5h", version: "1.1.0" },
      capabilities: { experimentalApi: true },
    });
    rpc.notify("initialized");
    const account = await rpc.request("account/read", { refreshToken: false }) as {
      account?: { type?: string; email?: string; planType?: string };
    };
    const limits = await rpc.request("account/rateLimits/read") as Record<string, unknown>;
    let models: string[] = [];
    try {
      let cursor: string | undefined;
      for (let page = 0; page < 5; page += 1) {
        const listed = await rpc.request("model/list", cursor ? { cursor } : {}) as {
          data?: Array<{ id?: string; model?: string }>;
          models?: Array<{ id?: string; model?: string }>;
          nextCursor?: string;
        };
        const rows = listed.data || listed.models || [];
        models.push(...rows.map((item) => item.id || item.model || "").filter(Boolean));
        if (!listed.nextCursor) break;
        cursor = listed.nextCursor;
      }
    } catch { /* 模型列表失败不伪造 */ }
    const email = account.account?.email || "";
    const plan = account.account?.planType || "";
    const rpcType = account.account?.type || "";
    const selected = pickCodexModel(models);
    const consistent = Boolean(identity.accountId && email && identity.authMode === "chatgpt" && rpcType === "chatgpt");
    const pools = mapCodexPools({
      accountId: identity.accountId,
      email,
      plan,
      limits,
      models,
      selected,
      now,
      priors: (options.priors || []).filter((item) => !item.accountId || item.accountId === identity.accountId),
      authMode: identity.authMode,
      hasApiKey: identity.hasApiKey,
    });
    if (!consistent) {
      for (const pool of pools) pool.blockReason = pool.blockReason || "account_context_unverified";
    }
    return {
      provider: "codex",
      accountId: identity.accountId,
      accountLabel: email,
      authMode: identity.authMode || rpcType || "",
      appCliConsistent: consistent,
      consistencyEvidence: consistent
        ? `auth.json 与 app-server 使用同一 CODEX_HOME（${path.dirname(authPath)}），类型均为 chatgpt`
        : "无法证明 auth.json 与 app-server 是同一 ChatGPT 订阅身份",
      pools,
      observedAt: now,
      rawSummary: redactJson({ account: { plan, type: account.account?.type }, limits, models }),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const category = /unauthorized|auth|login/i.test(message) ? "unauthorized" : /429|rate/i.test(message) ? "rate_limited" : "unavailable";
    return { provider: "codex", category, message, retryAfterMs: category === "rate_limited" ? 60_000 : 15_000 };
  } finally {
    rpc.close();
  }
}

export function pickCodexModel(models: string[]): string | null {
  const ranked = [...models].sort((left, right) => scoreModel(left) - scoreModel(right));
  return ranked[0] || null;
}

function scoreModel(model: string): number {
  const text = model.toLowerCase();
  let score = 100;
  if (text.includes("luna")) score -= 40;
  if (text.includes("mini")) score -= 30;
  if (text.includes("terra")) score -= 10;
  if (text.includes("sol")) score -= 5;
  if (text.includes("astra")) score += 30;
  return score;
}

export function assessCodexBilling(input: {
  authMode: string;
  hasApiKey: boolean;
  plan: string;
  snapshot: Record<string, unknown>;
}): { billingSafety: PoolFact["billingSafety"]; evidence: string[] } {
  const evidence = [`auth=${input.authMode || "missing"}`, `plan=${input.plan || "missing"}`];
  if (input.authMode !== "chatgpt" || input.hasApiKey) {
    evidence.push(input.hasApiKey ? "存在 API Key 字段" : "认证模式不是 chatgpt");
    return { billingSafety: "billing_safety_unknown", evidence };
  }
  if (!input.plan || /usage[_ ]based|cbp/i.test(input.plan)) {
    evidence.push(input.plan ? "计划为按量计费" : "计划字段缺失");
    return { billingSafety: input.plan ? "blocked" : "billing_safety_unknown", evidence };
  }
  if (!Object.hasOwn(input.snapshot, "credits") || input.snapshot.credits == null || typeof input.snapshot.credits !== "object") {
    evidence.push("credits 字段缺失，不能默认余额为 0");
    return { billingSafety: "billing_safety_unknown", evidence };
  }
  const credits = input.snapshot.credits as { hasCredits?: boolean; balance?: unknown; unlimited?: boolean };
  if (credits.unlimited === true || credits.hasCredits === true || credits.hasCredits !== false) {
    evidence.push("hasCredits 不是明确的 false");
    return { billingSafety: "billing_safety_unknown", evidence };
  }
  if (credits.balance === undefined || credits.balance === null || credits.balance === "") {
    evidence.push("credits.balance 缺失");
    return { billingSafety: "billing_safety_unknown", evidence };
  }
  const balance = Number(credits.balance);
  if (!Number.isFinite(balance) || balance !== 0) {
    evidence.push(`credits.balance 无法证明为 0（${String(credits.balance)}）`);
    return { billingSafety: "billing_safety_unknown", evidence };
  }
  evidence.push("credits.hasCredits=false 且 balance=0");
  evidence.push("不调用重置券接口，发送时剥离 API Key");
  return { billingSafety: "subscription_only", evidence };
}

export function mapCodexPools(input: {
  accountId: string;
  email: string;
  plan: string;
  limits: Record<string, unknown>;
  models: string[];
  selected: string | null;
  now: number;
  priors: PriorWindow[];
  authMode: string;
  hasApiKey: boolean;
}): PoolFact[] {
  const byId = (input.limits.rateLimitsByLimitId || input.limits.rate_limits_by_limit_id || {}) as Record<string, unknown>;
  const direct = (input.limits.rateLimits || input.limits.rate_limits || byId.codex || {}) as Record<string, unknown>;
  const entries = Object.keys(byId).length > 0 ? Object.entries(byId) : [["codex", direct]];
  return entries.map(([limitId, raw]) => {
    const snapshot = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const billing = assessCodexBilling({
      authMode: input.authMode,
      hasApiKey: input.hasApiKey,
      plan: String(snapshot.planType || input.plan || ""),
      snapshot,
    });
    const billingSafety = billing.billingSafety;
    const evidence = billing.evidence;
    const windows = ["primary", "secondary"].flatMap((name) => {
      const window = snapshot[name] as { usedPercent?: number; windowDurationMins?: number; resetsAt?: number } | undefined;
      if (!window) {
        if (!snapshot.primary && !snapshot.secondary) return [];
        const key = name === "primary" ? "5h" : "weekly";
        return [toFact(classifyWindow({
          key,
          kind: key === "5h" ? "session" : "weekly",
          resetAt: null,
          durationMs: null,
          usedPercent: null,
          remainingFraction: null,
          usageText: "",
          clock: "absent",
          activationHint: "usage_started",
          sharesRequest: true,
        }, null, input.now))];
      }
      const key = name === "primary" ? "5h" : "weekly";
      const prior = input.priors.find((item) => item.key === key && (!item.poolId || item.poolId === String(snapshot.limitId || limitId)) && (!item.accountId || item.accountId === input.accountId)) || null;
      const classified = classifyWindow({
        key,
        kind: key === "5h" ? "session" : "weekly",
        resetAt: window.resetsAt ? window.resetsAt * 1000 : null,
        durationMs: (window.windowDurationMins || 0) * 60_000,
        usedPercent: window.usedPercent ?? null,
        remainingFraction: window.usedPercent == null ? null : Math.max(0, 100 - window.usedPercent) / 100,
        usageText: "",
        clock: window.resetsAt ? "anchored" : "absent",
        activationHint: "usage_started",
        sharesRequest: true,
      }, prior, input.now);
      return [{ ...toFact(classified), remainingFraction: window.usedPercent == null ? null : Math.max(0, Math.min(100, 100 - window.usedPercent)) / 100 }];
    });
    return {
      provider: "codex" as const,
      accountId: input.accountId,
      accountLabel: input.email,
      poolId: String(snapshot.limitId || limitId),
      models: input.models,
      selectedModel: input.selected,
      billingSafety,
      billingEvidence: evidence,
      windows,
      observedAt: input.now,
      blockReason: input.selected ? undefined : "model_unknown",
    };
  });
}

function toFact(window: ReturnType<typeof classifyWindow>): WindowFact {
  return {
    key: window.key,
    kind: window.kind,
    activationMode: window.activationMode,
    state: window.state,
    oldEndedAt: window.oldEndedAt,
    resetAt: window.resetAt,
    allowance: window.allowance,
    sharesRequest: window.sharesRequest,
    evidence: window.evidence,
    windowId: window.windowId,
    preservedBoundary: window.preservedBoundary,
  };
}

export const CODEX_DISABLED_FEATURES = [
  "shell_tool",
  "hooks",
  "plugins",
  "browser_use",
  "browser_use_external",
  "computer_use",
  "multi_agent",
  "image_generation",
  "in_app_browser",
] as const;

export function buildCodexArgs(request: Pick<SendRequest, "model" | "workDir" | "prompt">): string[] {
  const disables = CODEX_DISABLED_FEATURES.flatMap((feature) => ["--disable", feature]);
  return [
    "-a",
    "never",
    "exec",
    "--ignore-user-config",
    "--ignore-rules",
    "--ephemeral",
    "--skip-git-repo-check",
    "--json",
    "--color",
    "never",
    "-s",
    "read-only",
    ...disables,
    "-m",
    request.model,
    "-c",
    'model_reasoning_effort="low"',
    "-c",
    "mcp_servers={}",
    "-C",
    request.workDir,
    request.prompt,
  ];
}

export function parseCodexArgs(args: string[]): { ok: boolean; error?: string; workDir?: string } {
  const execAt = args.indexOf("exec");
  if (execAt < 0) return { ok: false, error: "缺少 exec" };
  const before = args.slice(0, execAt);
  const after = args.slice(execAt + 1);
  if (after.includes("-a") || after.includes("--ask-for-approval")) return { ok: false, error: "unexpected argument '-a' found" };
  if (!before.includes("-a") && !before.includes("--ask-for-approval")) return { ok: false, error: "缺少顶层批准策略" };
  if (args.includes("--dangerously-bypass-approvals-and-sandbox")) return { ok: false, error: "禁止跳过全部权限" };
  for (const flag of ["--ignore-user-config", "--ignore-rules", "--ephemeral", "--skip-git-repo-check"]) {
    if (!after.includes(flag)) return { ok: false, error: `缺少 ${flag}` };
  }
  const sandbox = after.indexOf("-s");
  if (sandbox < 0 || after[sandbox + 1] !== "read-only") return { ok: false, error: "缺少只读沙箱" };
  const disabled = new Set<string>();
  for (let index = 0; index < after.length; index += 1) {
    if (after[index] === "--disable") disabled.add(after[index + 1] || "");
  }
  for (const feature of CODEX_DISABLED_FEATURES) {
    if (!disabled.has(feature)) return { ok: false, error: `未禁用 ${feature}` };
  }
  const cwdAt = after.indexOf("-C");
  if (cwdAt < 0 || !after[cwdAt + 1]) return { ok: false, error: "缺少工作目录" };
  return { ok: true, workDir: after[cwdAt + 1] };
}

export async function sendCodex(request: SendRequest, command: string, signal?: AbortSignal): Promise<SendResult> {
  if (isShuttingDown() || signal?.aborted) return { outcome: "not_sent", sessionId: null, detail: "退出中，未启动发送", started: false };
  const args = buildCodexArgs(request);
  const parsed = parseCodexArgs(args);
  if (!parsed.ok) return { outcome: "not_sent", sessionId: null, detail: parsed.error || "参数无效", started: false };
  const helpArgs = args.slice(0, -1).concat("--help");
  const help = await runCommand({ command, args: helpArgs, timeoutMs: 10_000, signal });
  if (isShuttingDown() || signal?.aborted || !help.started) {
    return { outcome: "not_sent", sessionId: null, detail: "退出中或未能完成参数检查，未启动发送", started: false };
  }
  if (help.code !== 0) {
    return { outcome: "not_sent", sessionId: null, detail: help.stderr.slice(0, 300) || "Codex 拒绝该参数组合", started: false };
  }
  const result = await runCommand({
    command,
    args,
    cwd: request.workDir,
    timeoutMs: 90_000,
    env: safeEnv(),
    maxOutput: 300_000,
    signal,
  });
  if (result.spawnError && !result.started) {
    return { outcome: "not_sent", sessionId: null, detail: result.spawnError, started: false };
  }
  const facts = codexFacts(result.stdout);
  if (result.timedOut || result.code == null) {
    return { outcome: "unknown", sessionId: facts.threadId, detail: "Codex 执行超时或连接中断，先核实不再重发", started: true, acceptance: "none" };
  }
  if (facts.turnCompleted && result.code === 0) {
    return {
      outcome: "accepted",
      sessionId: facts.threadId,
      detail: `模型回合已完成；用量=${facts.usageTokens ?? "未见"}；窗口是否启动仍待额度观测`,
      started: true,
      acceptance: "turn_completed",
      usageTokens: facts.usageTokens,
    };
  }
  if (facts.threadStarted) {
    return { outcome: "unknown", sessionId: facts.threadId, detail: "只看到 thread.started，没有模型完成事件，不能当作已接受", started: true, acceptance: "thread_only" };
  }
  return { outcome: "unknown", sessionId: facts.threadId, detail: result.stderr.slice(0, 180) || `exit ${result.code}，没有完成事件`, started: true, acceptance: "none" };
}

function codexFacts(stdout: string): { threadStarted: boolean; turnCompleted: boolean; threadId: string | null; usageTokens: number | null } {
  let threadStarted = false;
  let turnCompleted = false;
  let threadId: string | null = null;
  let usageTokens: number | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const event = JSON.parse(trimmed) as { type?: string; thread_id?: string; usage?: { input_tokens?: number; output_tokens?: number } };
      if (event.type === "thread.started") {
        threadStarted = true;
        if (typeof event.thread_id === "string") threadId = event.thread_id;
      }
      if (event.type === "turn.completed") {
        turnCompleted = true;
        const input = event.usage?.input_tokens;
        const output = event.usage?.output_tokens;
        if (typeof input === "number" || typeof output === "number") usageTokens = (typeof input === "number" ? input : 0) + (typeof output === "number" ? output : 0);
      }
    } catch {
      continue;
    }
  }
  if (!threadId) threadId = stdout.match(/"thread_id":"([^"]+)"/)?.[1] || null;
  if (!threadStarted && /"type":"thread\.started"/.test(stdout)) threadStarted = true;
  if (!turnCompleted && /"type":"turn\.completed"/.test(stdout)) turnCompleted = true;
  return { threadStarted, turnCompleted, threadId, usageTokens };
}
