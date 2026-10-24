import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCommand } from "../proc.js";
import { classifyWindow } from "../decision.js";
import type { ProviderReadError, ProviderSnapshot, WindowFact } from "../types.js";

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

export async function readClaude(options: { now?: number; signal?: AbortSignal; configDir?: string } = {}): Promise<ProviderSnapshot | ProviderReadError> {
  const configDir = options.configDir || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  const error = (category: ProviderReadError["category"], message: string): ProviderReadError => ({ provider: "claude", category, message, retryAfterMs: 300_000 });
  if (claudeProxyConfigured(configDir)) return error("unavailable", "Claude Code 当前配置代理或 API 计费入口；无法读取官方订阅额度，请使用官方订阅登录后再启用。现有配置未修改。");
  try {
    let credentials = localJson(path.join(configDir, ".credentials.json"));
    if (!credentials.claudeAiOauth && process.platform === "darwin") {
      const suffix = process.env.CLAUDE_CONFIG_DIR ? `-${crypto.createHash("sha256").update(configDir).digest("hex").slice(0, 8)}` : "";
      const result = await runCommand({ command: "/usr/bin/security", args: ["find-generic-password", "-a", os.userInfo().username, "-w", "-s", `Claude Code-credentials${suffix}`], timeoutMs: 5_000, signal: options.signal });
      if (result.code === 0) { try { credentials = JSON.parse(result.stdout); } catch { /* 无有效订阅凭证 */ } }
    }
    const oauth = credentials.claudeAiOauth;
    if (typeof oauth?.accessToken !== "string" || !oauth.accessToken || (typeof oauth.expiresAt === "number" && oauth.expiresAt <= Date.now())) return error("unauthorized", "未找到有效的 Claude 官方订阅登录态；请在 Claude Code 中登录或刷新登录。工具不会自动改写凭证。");
    const get = async (endpoint: string): Promise<Record<string, unknown>> => {
      const response = await fetch(`${API}${endpoint}`, {
        headers: { Authorization: `Bearer ${oauth.accessToken}`, "anthropic-beta": "oauth-2025-04-20", "User-Agent": "AIQuota5h/1.1.0" },
        signal: options.signal, redirect: "error",
      });
      if (!response.ok) throw new Error(`Claude 官方额度接口 HTTP ${response.status}`);
      return response.json() as Promise<Record<string, unknown>>;
    };
    const profile = await get("/api/oauth/profile");
    const account = profile.account as { uuid?: string; email?: string } | undefined;
    if (typeof account?.uuid !== "string" || !account.uuid.trim()) return error("protocol", "Claude 官方账号标识缺失，未保存额度快照");
    const usage = await get("/api/oauth/usage");
    return mapClaudeUsage(usage, account.uuid, typeof account.email === "string" ? account.email : "Claude 订阅账号", options.now ?? Date.now());
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "Claude 额度读取失败";
    return error(/HTTP 401|HTTP 403/.test(message) ? "unauthorized" : "unavailable", message);
  }
}

export function mapClaudeUsage(usage: Record<string, unknown>, accountId: string, label: string, now: number): ProviderSnapshot {
  const windows = Object.entries(WINDOWS).flatMap(([source, meta]) => {
    const raw = usage[source] as { utilization?: unknown; resets_at?: unknown } | null | undefined;
    if (!raw || typeof raw !== "object") return [];
    const used = typeof raw.utilization === "number" && Number.isFinite(raw.utilization) && raw.utilization >= 0 && raw.utilization <= 100 ? raw.utilization : null;
    const reset = typeof raw.resets_at === "string" ? Date.parse(raw.resets_at) : NaN;
    const classified = classifyWindow({ key: meta.key, kind: meta.name, resetAt: Number.isFinite(reset) ? reset : null, durationMs: meta.duration,
      usedPercent: used, remainingFraction: used == null ? null : (100 - used) / 100, usageText: "", clock: Number.isFinite(reset) ? "anchored" : "absent", activationHint: source === "five_hour" ? "usage_started" : "unknown", sharesRequest: true }, null, now);
    return [{ ...classified, remainingFraction: used == null ? null : (100 - used) / 100 } as WindowFact];
  });
  if (!windows.length) throw new Error("Claude 官方接口没有返回可识别的额度窗口");
  return { provider: "claude", accountId, accountLabel: label, authMode: "claude-subscription-oauth", appCliConsistent: true,
    consistencyEvidence: "使用同一官方 OAuth 登录态读取账号与额度", observedAt: now, rawSummary: "Claude 官方订阅额度；不保存令牌或原始账号响应",
    pools: [{ provider: "claude", accountId, accountLabel: label, poolId: "claude-subscription", models: [], selectedModel: null,
      billingSafety: "billing_safety_unknown", billingEvidence: ["官方订阅只读接入；尚未验证调用隔离与额外计费状态"], windows, observedAt: now,
      blockReason: "Claude Code 当前仅支持额度监控，自动激活尚未完成隔离与费用验证" }] };
}
