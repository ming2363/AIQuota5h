import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCommand } from "../proc.js";
import { classifyWindow, type PriorWindow } from "../decision.js";
import type { ProviderReadError, ProviderSnapshot, SendRequest, SendResult, WindowFact } from "../types.js";
import { CLAUDE_SETTINGS, claudeConfigDir, claudeEnvironment, loadClaudeOAuth } from "./claude-auth.js";
import { ProviderHttpError, retryAfterMs } from "./http.js";

const API = "https://api.anthropic.com";
const WINDOWS: Record<string, { key: string; name: string; duration: number }> = {
  five_hour: { key: "5h", name: "5 小时额度", duration: 5 * 60 * 60_000 },
  seven_day: { key: "weekly", name: "所有模型周额度", duration: 7 * 24 * 60 * 60_000 },
  seven_day_sonnet: { key: "weekly-sonnet", name: "Sonnet 周额度", duration: 7 * 24 * 60 * 60_000 },
  seven_day_opus: { key: "weekly-opus", name: "Opus 周额度", duration: 7 * 24 * 60 * 60_000 },
  seven_day_oauth_apps: { key: "weekly-oauth", name: "OAuth 应用周额度", duration: 7 * 24 * 60 * 60_000 },
};

function localJson(file: string): Record<string, any> {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; }
}

export function claudeProxyConfigured(configDir = path.join(os.homedir(), ".claude"), env: NodeJS.ProcessEnv = process.env): boolean {
  const configured = { ...localJson(path.join(configDir, "settings.json")).env, ...localJson(path.join(configDir, "settings.local.json")).env, ...env };
  const base = String(configured.ANTHROPIC_BASE_URL || API).replace(/\/+$/, "");
  return base !== API || Boolean(configured.ANTHROPIC_API_KEY || configured.ANTHROPIC_AUTH_TOKEN || configured.CLAUDE_CODE_USE_BEDROCK || configured.CLAUDE_CODE_USE_VERTEX || configured.CLAUDE_CODE_USE_FOUNDRY);
}

interface ClaudeReadOptions { now?: number; signal?: AbortSignal; configDir?: string; priors?: PriorWindow[]; fetcher?: typeof fetch; }

async function claudeSession(options: ClaudeReadOptions) {
  const configDir = options.configDir || claudeConfigDir();
  if (claudeProxyConfigured(configDir, {})) throw new Error("Claude 独立订阅目录配置了代理或 API 计费入口，请使用官方订阅登录");
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
  const oauth = await loadClaudeOAuth(configDir, signal, options.fetcher);
  if (!oauth.scopes?.includes("user:inference") || !oauth.scopes.includes("user:profile")) throw new Error("Claude 官方登录缺少订阅调用或账号读取权限，请重新登录");
  const get = async (endpoint: string): Promise<Record<string, any>> => {
    const response = await (options.fetcher || fetch)(`${API}${endpoint}`, {
      headers: { Authorization: `Bearer ${oauth.accessToken}`, "anthropic-beta": "oauth-2025-04-20", "User-Agent": "AIQuota5h/1.1.0" }, signal, redirect: "error",
    });
    if (!response.ok) throw new ProviderHttpError(`Claude 官方${endpoint.endsWith("/profile") ? "账号" : "额度"}接口 HTTP ${response.status}`, response.status, retryAfterMs(response.headers));
    return response.json() as Promise<Record<string, any>>;
  };
  const profile = await get("/api/oauth/profile");
  const account = profile.account;
  if (typeof account?.uuid !== "string" || !account.uuid.trim()) throw new Error("Claude 官方账号标识缺失，未保存额度快照");
  const usage = await get("/api/oauth/usage");
  const type = profile.organization?.organization_type;
  const subscription = type === "claude_pro" || type === "claude_max";
  const extras = [usage.extra_usage?.is_enabled, profile.organization?.has_extra_usage_enabled];
  const billingSafety = !subscription || extras.includes(true) ? "blocked" : extras.includes(false) ? "subscription_only" : "billing_safety_unknown";
  const snapshot = mapClaudeUsage(usage, account.uuid, typeof account.email === "string" ? account.email : "Claude 订阅账号", options.now ?? Date.now(), options.priors);
  const pool = snapshot.pools[0];
  pool.billingSafety = billingSafety;
  pool.billingEvidence = [subscription ? "官方 Pro/Max 订阅账号" : "未证明为个人 Pro/Max 订阅", billingSafety === "subscription_only" ? "官方明确返回额外用量未开启" : "额外用量已开启或状态未确认"];
  pool.blockReason = billingSafety === "subscription_only" ? pool.blockReason : "Claude 仅在官方 Pro/Max 订阅且额外付费明确关闭时自动激活";
  if (!pool.windows.some((w) => w.key === "weekly")) pool.blockReason = "Claude 官方接口未返回周额度，暂不激活";
  return { snapshot, token: oauth.accessToken, configDir };
}

export async function readClaude(options: ClaudeReadOptions = {}): Promise<ProviderSnapshot | ProviderReadError> {
  try {
    return (await claudeSession(options)).snapshot;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "Claude 额度读取失败";
    return claudeReadError(cause, message);
  }
}

function claudeReadError(cause: unknown, message: string): ProviderReadError {
  const status = cause instanceof ProviderHttpError ? cause.status : null;
  const category = status != null ? status === 429 ? "rate_limited" : status === 401 || status === 403 ? "unauthorized" : "unavailable"
    : /HTTP 429/.test(message) ? "rate_limited" : /HTTP 401|HTTP 403|登录|续期/.test(message) ? "unauthorized" : "unavailable";
  return { provider: "claude", category, message,
    retryAfterMs: cause instanceof ProviderHttpError && cause.retryAfterMs != null ? cause.retryAfterMs : 300_000 };
}

export function mapClaudeUsage(usage: Record<string, unknown>, accountId: string, label: string, now: number, priors: PriorWindow[] = []): ProviderSnapshot {
  const windows = Object.entries(WINDOWS).flatMap(([source, meta]) => {
    const raw = usage[source] as { utilization?: unknown; resets_at?: unknown } | null | undefined;
    if (!raw || typeof raw !== "object") return [];
    const used = typeof raw.utilization === "number" && Number.isFinite(raw.utilization) && raw.utilization >= 0 && raw.utilization <= 100 ? raw.utilization : null;
    const reset = typeof raw.resets_at === "string" ? Date.parse(raw.resets_at) : NaN;
    const prior = priors.find((item) => item.key === meta.key && item.accountId === accountId && item.poolId === "claude-subscription"
      && (item.state === "active" || item.preservedBoundary != null)) || null;
    const classified = classifyWindow({ key: meta.key, kind: meta.name, resetAt: Number.isFinite(reset) ? reset : null, durationMs: meta.duration,
      usedPercent: used, remainingFraction: used == null ? null : (100 - used) / 100, usageText: "", clock: Number.isFinite(reset) ? "anchored" : "absent", activationHint: source === "five_hour" ? "usage_started" : "auto_reset", sharesRequest: source === "five_hour" }, prior, now);
    return [{ ...classified, remainingFraction: used == null ? null : (100 - used) / 100 } as WindowFact];
  });
  if (!windows.length) throw new Error("Claude 官方接口没有返回可识别的额度窗口");
  return { provider: "claude", accountId, accountLabel: label, authMode: "claude-subscription-oauth", appCliConsistent: true,
    consistencyEvidence: "使用同一官方 OAuth 登录态读取账号与额度", observedAt: now, rawSummary: "Claude 官方订阅额度；不保存令牌或原始账号响应",
    pools: [{ provider: "claude", accountId, accountLabel: label, poolId: "claude-subscription", models: ["sonnet"], selectedModel: windows.some((w) => w.key === "5h") ? "sonnet" : null,
      billingSafety: "billing_safety_unknown", billingEvidence: ["尚未核对官方个人订阅及额外付费状态"], windows, observedAt: now,
      blockReason: windows.some((w) => w.key === "5h") ? undefined : "Claude 官方接口未返回 5 小时窗口，暂不激活" }] };
}

export function buildClaudeArgs(request: SendRequest): string[] {
  return ["--setting-sources", "", "--settings", CLAUDE_SETTINGS, "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
    "--tools", "", "--disable-slash-commands", "--no-chrome", "--no-session-persistence", "--permission-mode", "dontAsk",
    "--system-prompt", "Reply only OK. Do not use tools or access files.", "--model", request.model, "--effort", "low", "--max-turns", "1", "--output-format", "json", "--print", request.prompt];
}

export async function sendClaude(request: SendRequest, command: string, signal?: AbortSignal, options: ClaudeReadOptions = {}): Promise<SendResult> {
  const notSent = (detail: string): SendResult => ({ outcome: "not_sent", sessionId: null, detail, started: false });
  if (request.model !== "sonnet") return notSent("Claude 激活仅使用官方订阅 Sonnet 模型");
  let sending = false;
  try {
    // Use the same verified token for the profile, quota and CLI, even if login changes concurrently.
    const session = await claudeSession({ ...options, signal });
    if (session.snapshot.accountId !== request.accountId) return notSent("Claude 官方订阅账号已变化，未发送");
    if (session.snapshot.pools[0].blockReason || session.snapshot.pools[0].billingSafety !== "subscription_only" || session.snapshot.pools[0].windows.some((w) => w.allowance !== "allowed")) return notSent("Claude 额度或费用条件不允许发送");
    const sessionWindow = session.snapshot.pools[0].windows.find((w) => w.key === "5h");
    if (!sessionWindow || sessionWindow.state === "active" || (sessionWindow.resetAt != null && sessionWindow.resetAt > Date.now())) return notSent("Claude 5 小时窗口已启动或状态未确认，未发送");
    const managed = "/Library/Application Support/ClaudeCode";
    if (fs.existsSync(managed) && fs.readdirSync(managed).some((name) => name.endsWith(".json") || name === "managed-settings.d")) return notSent("Claude 存在受管设置，尚未验证调用隔离");
    const args = buildClaudeArgs(request);
    const env = claudeEnvironment(session.configDir, session.token);
    const help = await runCommand({ command, args: [...args.slice(0, -2), "--help"], cwd: request.workDir, env, timeoutMs: 10_000, signal });
    if (help.code !== 0 || !help.started) return notSent("Claude CLI 不支持所需隔离参数，未发送");
    for (const flag of ["--setting-sources", "--strict-mcp-config", "--tools", "--disable-slash-commands", "--no-session-persistence", "--no-chrome", "--permission-mode"]) {
      if (!help.stdout.includes(flag)) return notSent(`Claude CLI 缺少隔离参数 ${flag}，未发送`);
    }
    sending = true;
    const result = await runCommand({ command, args, cwd: request.workDir, env, timeoutMs: 90_000, maxOutput: 300_000, signal });
    if (!result.started) return notSent("Claude CLI 未启动，请检查路径或退出状态");
    let data: Record<string, any> = {};
    try { data = JSON.parse(result.stdout); } catch { /* An ambiguous started request must never be retried. */ }
    const completed = result.code === 0 && !result.timedOut && data.type === "result" && data.subtype === "success" && data.is_error === false;
    const sessionId = typeof data.session_id === "string" ? data.session_id : null;
    return { outcome: completed ? "accepted" : "unknown", sessionId, started: true, acceptance: completed ? "turn_completed" : "none",
      detail: completed ? "Claude 模型回合已完成，新窗口是否启动仍待额度核验" : "Claude 请求已启动但结果未确认，先核实，不再重发" };
  } catch (cause) {
    if (sending) return { outcome: "unknown", sessionId: null, started: true, detail: "Claude 发送阶段异常，先核实，不再重发", acceptance: "none" };
    const error = claudeReadError(cause, cause instanceof Error ? cause.message : "Claude 官方订阅复核失败");
    return { ...notSent(error.message), errorCategory: error.category, retryAfterMs: error.retryAfterMs ?? 300_000 };
  }
}
