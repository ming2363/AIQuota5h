import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runtimePaths } from "../paths.js";
import { runCommand } from "../proc.js";
import { ProviderHttpError, retryAfterMs } from "./http.js";

export interface ClaudeOAuth {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scopes?: string[];
  subscriptionType?: string;
}

export function claudeConfigDir(): string {
  return path.join(runtimePaths().home, "claude-subscription");
}

export const CLAUDE_SETTINGS = JSON.stringify({ disableAllHooks: true, enabledPlugins: {}, autoMemoryEnabled: false, fastMode: false, alwaysThinkingEnabled: false });

export function claudeEnvironment(dir: string, token?: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  // An allowlist prevents proxy/API credentials, SDK tokens and model overrides from leaking into this subscription session.
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["HOME", "PATH", "TMPDIR", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE"]) {
    if (base[key] != null) env[key] = base[key];
  }
  env.CLAUDE_CONFIG_DIR = dir;
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  env.NO_COLOR = "1";
  if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token;
  return env;
}

export async function readClaudeKeychain(dir: string, signal?: AbortSignal): Promise<ClaudeOAuth | null> {
  if (process.platform !== "darwin") return null;
  const suffix = crypto.createHash("sha256").update(dir.normalize("NFC")).digest("hex").slice(0, 8);
  const result = await runCommand({ command: "/usr/bin/security", args: ["find-generic-password", "-a", os.userInfo().username, "-w", "-s", `Claude Code-credentials-${suffix}`], timeoutMs: 5_000, signal });
  if (result.code !== 0) return null;
  try { return JSON.parse(result.stdout).claudeAiOauth || null; } catch { return null; }
}

export function saveClaudeOAuth(dir: string, oauth: ClaudeOAuth): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, ".credentials.json");
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify({ claudeAiOauth: oauth }), { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}

const renewals = new Map<string, Promise<ClaudeOAuth>>();

export async function loadClaudeOAuth(dir: string, signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<ClaudeOAuth> {
  const pending = renewals.get(dir);
  if (pending) return pending;
  const job = (async () => {
    let oauth: ClaudeOAuth | null = null;
    try { oauth = JSON.parse(fs.readFileSync(path.join(dir, ".credentials.json"), "utf8")).claudeAiOauth; } catch { /* first login is stored by the CLI in Keychain */ }
    oauth ||= await readClaudeKeychain(dir, signal);
    if (!oauth || !Number.isFinite(oauth.expiresAt)) throw new Error("Claude 独立订阅尚未登录，请运行 aiquota5h claude-login 完成官方登录");
    if (oauth.accessToken && oauth.expiresAt > Date.now() + 60_000) return oauth;
    if (!oauth.refreshToken) throw new Error("Claude 独立订阅登录已过期，请重新运行 aiquota5h claude-login");
    // Same refresh endpoint and public client ID as the installed official Claude Code CLI.
    const response = await fetcher("https://platform.claude.com/v1/oauth/token", {
      method: "POST", redirect: "error", signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grant_type: "refresh_token", refresh_token: oauth.refreshToken, client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e", scope: oauth.scopes?.join(" ") }),
    });
    if (!response.ok) throw new ProviderHttpError(`Claude 订阅续期失败 HTTP ${response.status}${response.status === 401 || response.status === 403 ? "，请重新运行 aiquota5h claude-login" : "，稍后自动重试"}`, response.status, retryAfterMs(response.headers));
    const data = await response.json() as Record<string, unknown>;
    if (typeof data.access_token !== "string" || !data.access_token || typeof data.expires_in !== "number" || !Number.isFinite(data.expires_in) || data.expires_in <= 0) {
      throw new Error("Claude 订阅续期响应无效，未覆盖原登录态");
    }
    const renewed: ClaudeOAuth = { ...oauth, accessToken: data.access_token, refreshToken: typeof data.refresh_token === "string" && data.refresh_token ? data.refresh_token : oauth.refreshToken,
      expiresAt: Date.now() + data.expires_in * 1_000, scopes: typeof data.scope === "string" ? data.scope.split(" ") : oauth.scopes };
    saveClaudeOAuth(dir, renewed);
    return renewed;
  })();
  renewals.set(dir, job);
  try { return await job; } finally { if (renewals.get(dir) === job) renewals.delete(dir); }
}
