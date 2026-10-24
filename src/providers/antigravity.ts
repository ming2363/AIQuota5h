import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { isShuttingDown, runCommand, safeEnv } from "../proc.js";
import { maskEmail, redactJson } from "../redact.js";
import { classifyWindow, clockFromSamples, type PriorWindow } from "../decision.js";
import type { PoolFact, ProviderReadError, ProviderSnapshot, SendRequest, SendResult, WindowFact } from "../types.js";

const SERVICE = "exa.language_server_pb.LanguageServerService";

interface Bucket {
  bucketId?: string;
  displayName?: string;
  description?: string;
  window?: string;
  remainingFraction?: number;
  resetTime?: string;
  precision?: "exact" | "rounded";
}

interface Group {
  displayName?: string;
  description?: string;
  buckets?: Bucket[];
}

function commandText(result: { stdout: string; stderr: string }): string {
  return `${result.stdout}\n${result.stderr}`;
}

export function extractHelpFlags(help: string): Set<string> {
  const flags = new Set<string>();
  for (const line of help.split(/\n/)) {
    const match = line.match(/^\s+(--[a-z0-9-]+)/i);
    if (match) flags.add(match[1]);
  }
  return flags;
}

export function assessAgyIsolation(help: string): { ok: boolean; reason: string; extraArgs: string[] } {
  const flags = extractHelpFlags(help);
  if (flags.size === 0) return { ok: false, reason: "无法解析 agy 帮助，不能确认隔离参数", extraArgs: [] };
  const pick = (names: string[], label: string): string | null => {
    const found = names.find((name) => flags.has(name));
    return found || null;
  };
  const plugins = pick(["--disable-plugins", "--no-plugins"], "plugins");
  const mcp = pick(["--disable-mcp", "--no-mcp"], "mcp");
  const hooks = pick(["--disable-hooks", "--no-hooks"], "hooks");
  const missing = [plugins ? "" : "plugins", mcp ? "" : "mcp", hooks ? "" : "hooks"].filter(Boolean);
  if (missing.length > 0) {
    return { ok: false, reason: `agy 帮助缺少调用级隔离参数：${missing.join("、")}`, extraArgs: [] };
  }
  return { ok: true, reason: "", extraArgs: [plugins!, mcp!, hooks!] };
}

export function parseAgyUsageTable(text: string): Group[] {
  const groups = new Map<string, Bucket[]>();
  for (const line of text.split(/\n/)) {
    const parts = line.split("\t").map((part) => part.trim()).filter(Boolean);
    if (parts.length < 3) continue;
    const [name, label, percentText, reset] = parts;
    const window = /five hour|5-hour|5h/i.test(label) ? "5h" : /week/i.test(label) ? "weekly" : "";
    if (!window) continue;
    const percent = Number(percentText.replace("%", ""));
    groups.set(name, [...(groups.get(name) || []), {
      bucketId: `${poolIdFor(name)}-${window}`,
      displayName: label,
      description: "",
      window,
      remainingFraction: Number.isFinite(percent) ? percent / 100 : undefined,
      resetTime: reset,
      precision: "rounded",
    }]);
  }
  return [...groups.entries()].map(([displayName, buckets]) => ({ displayName, buckets }));
}

export function selectAgyModels(text: string): Record<string, string> {
  const selected: Record<string, { model: string; score: number }> = {};
  for (const line of text.split(/\n/)) {
    const model = line.split(/\s+/)[0]?.trim();
    if (!model || !model.includes("-")) continue;
    const poolId = model.includes("argon") ? "gemini-argon" : model.includes("claude") || model.includes("gpt-oss") ? "claude-gpt" : model.includes("gemini") ? "gemini" : "";
    if (!poolId) continue;
    const score = (model.includes("-low") ? 0 : model.includes("-medium") ? 1 : 2) + (model.includes("opus") ? 5 : 0);
    if (!selected[poolId] || score < selected[poolId].score) selected[poolId] = { model, score };
  }
  return Object.fromEntries(Object.entries(selected).map(([poolId, item]) => [poolId, item.model]));
}

export async function readAntigravity(options: {
  agy?: string | null;
  now?: number;
  priors?: PriorWindow[];
  usageText?: string;
  helpText?: string;
  modelsText?: string;
  signal?: AbortSignal;
}): Promise<ProviderSnapshot | ProviderReadError> {
  if (options.signal?.aborted) return cancelledRead();
  const now = options.now ?? Date.now();
  let endpoint = options.usageText ? null : detectEndpoint();
  let ownedStop: (() => void) | null = null;
  if (!endpoint && !options.usageText) {
    const owned = await startOwnedLanguageServer(options.signal);
    if (options.signal?.aborted) return cancelledRead();
    if (owned) {
      endpoint = owned.endpoint;
      ownedStop = owned.stop;
    }
  }
  if (options.signal?.aborted) {
    ownedStop?.();
    return cancelledRead();
  }
  if (!endpoint) return readAntigravityViaCli(options, now);
  try {
    const first = await callLs(endpoint, "RetrieveUserQuotaSummary", { forceRefresh: true }, options.signal);
    const status = await callLs(endpoint, "GetUserStatus", {
      metadata: { ideName: "antigravity", extensionName: "antigravity", ideVersion: "unknown", locale: "en" },
    }, options.signal);
    const email = String(status?.userStatus?.email || "").trim().toLowerCase();
    if (!email) {
      return { provider: "antigravity", category: "unauthorized", message: "无法读取 Antigravity 账号邮箱", retryAfterMs: null };
    }
    const groups = ((first?.response?.groups || []) as Group[]);
    const ambiguous = groups.flatMap((group) => (group.buckets || []).filter((bucket) => needsSlideCheck(bucket)).map((bucket) => bucket.bucketId));
    let second: Record<string, unknown> | null = null;
    if (ambiguous.length > 0) {
      await delay(8_000, options.signal);
      second = await callLs(endpoint, "RetrieveUserQuotaSummary", { forceRefresh: true }, options.signal);
    }
    const cli = options.agy ? await readAgyIdentity(options.agy, options.signal) : { email: "", credits: null as number | null, error: "agy 未安装" };
    const helpText = options.helpText ?? (options.agy ? commandText(await runCommand({ command: options.agy, args: ["--help"], timeoutMs: 10_000, signal: options.signal })) : "");
    const modelsText = options.modelsText ?? (options.agy ? (await runCommand({ command: options.agy, args: ["models"], timeoutMs: 20_000, env: safeEnv(), signal: options.signal })).stdout : "");
    const consistent = cli.email ? cli.email === email : null;
    const pools = mapGroups({
      email,
      groups,
      secondGroups: ((second?.response as { groups?: Group[] } | undefined)?.groups || []),
      now,
      priors: options.priors || [],
      credits: cli.credits,
      consistent,
      isolation: assessAgyIsolation(helpText),
      modelMap: selectAgyModels(modelsText),
    });
    return {
      provider: "antigravity",
      accountId: email,
      accountLabel: email,
      authMode: "google-consumer-keyring",
      appCliConsistent: consistent,
      consistencyEvidence: consistent == null
        ? "仅有 App language server 身份，CLI 身份未核对"
        : consistent
          ? "App language server 与 agy keyring 邮箱一致"
          : "App 与 agy 邮箱不一致",
      pools,
      observedAt: Date.now(),
      rawSummary: redactJson({ email: maskEmail(email), groups, credits: cli.credits, cliError: cli.error }),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { provider: "antigravity", category: /401|403|unauthorized/i.test(message) ? "unauthorized" : "unavailable", message, retryAfterMs: 30_000 };
  } finally {
    ownedStop?.();
  }
}

export function mapGroups(input: {
  email: string;
  groups: Group[];
  secondGroups: Group[];
  now: number;
  priors: PriorWindow[];
  credits: number | null;
  consistent: boolean | null;
  isolation?: { ok: boolean; reason: string };
  modelMap?: Record<string, string>;
}): PoolFact[] {
  const second = new Map<string, Bucket>();
  for (const group of input.secondGroups) {
    for (const bucket of group.buckets || []) if (bucket.bucketId) second.set(bucket.bucketId, bucket);
  }
  return input.groups.map((group) => {
    const poolId = poolIdFor(group.displayName || "quota");
    const selected = input.modelMap?.[poolId];
    const models = selected ? [selected] : modelsFor(poolId);
    const windows = (group.buckets || []).map((bucket) => {
      const key = bucket.window === "weekly" ? "weekly" : bucket.window === "5h" ? "5h" : bucket.bucketId || "window";
      const resetAt = bucket.resetTime ? Date.parse(bucket.resetTime) : null;
      const other = bucket.bucketId ? second.get(bucket.bucketId) : undefined;
      const otherReset = other?.resetTime ? Date.parse(other.resetTime) : null;
      const sampled = otherReset && resetAt
        ? clockFromSamples([{ at: input.now, resetAt }, { at: input.now + 8_000, resetAt: otherReset }])
        : null;
      const exact = bucket.precision !== "rounded";
      const clock = sampled && sampled !== "unknown"
        ? sampled
        : exact && /you have used/i.test(bucket.description || "")
          ? "anchored"
          : resetAt ? "unknown" : "absent";
      const hint = key === "5h"
        ? "usage_started" as const
        : /fully refresh|refresh in/i.test(bucket.description || "") && clock !== "sliding"
          ? "auto_reset" as const
          : "unknown" as const;
      const prior = input.priors.find((item) => item.key === `${poolId}:${key}` || item.key === key) || null;
      const classified = classifyWindow({
        key,
        kind: key,
        resetAt,
        durationMs: key === "5h" ? 5 * 60 * 60_000 : key === "weekly" ? 7 * 24 * 60 * 60_000 : null,
        usedPercent: null,
        remainingFraction: typeof bucket.remainingFraction === "number" ? bucket.remainingFraction : null,
        usageText: bucket.description || "",
        clock,
        activationHint: hint,
        sharesRequest: true,
      }, prior ? { ...prior, key } : null, input.now);
      return { ...toFact(classified), remainingFraction: typeof bucket.remainingFraction === "number" && Number.isFinite(bucket.remainingFraction) && bucket.remainingFraction >= 0 && bucket.remainingFraction <= 1 ? bucket.remainingFraction : null };
    });
    const billingSafety = input.consistent !== true || input.credits !== 0
      ? input.consistent === false ? "blocked" : "billing_safety_unknown"
      : "subscription_only";
    const identityBlock = input.consistent === false ? "account_mismatch" : input.consistent !== true ? "account_unverified" : undefined;
    return {
      provider: "antigravity" as const,
      accountId: input.email,
      accountLabel: input.email,
      poolId,
      models,
      selectedModel: selected || null,
      billingSafety,
      billingEvidence: [
        "认证为 Google consumer keyring，不是 Gemini API key 模式",
        input.credits == null ? "AI credits 余额未读到" : `AI credits=${input.credits}`,
        "额度耗尽后的 overage 开关未在本地配置中找到；余额为 0 时没有可消耗的额外额度",
        input.isolation?.ok ? "调用级隔离参数可用" : (input.isolation?.reason || "尚未核对 agy 隔离参数"),
      ],
      windows,
      observedAt: input.now,
      blockReason: input.isolation?.ok ? identityBlock : (input.isolation?.reason || identityBlock || "agy_isolation_unknown"),
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
  };
}

export function poolIdFor(name: string): string {
  const text = name.toLowerCase();
  if (text.includes("argon")) return "gemini-argon";
  if (text.includes("claude") || text.includes("gpt")) return "claude-gpt";
  if (text.includes("gemini")) return "gemini";
  return name.toLowerCase().replace(/\s+/g, "-");
}

export function modelsFor(poolId: string): string[] {
  if (poolId === "gemini") return ["gemini-3.8-flash-low", "gemini-3.8-flash-medium"];
  if (poolId === "claude-gpt") return ["claude-sonnet-5-5-low", "gpt-oss-120b-medium"];
  if (poolId === "gemini-argon") return ["gemini-4-argon-low"];
  return [];
}

export async function verifyAgyModel(agy: string, model: string): Promise<boolean> {
  const result = await runCommand({ command: agy, args: ["models"], timeoutMs: 20_000, env: safeEnv() });
  return result.stdout.split(/\s+/).includes(model);
}

export function buildAgyArgs(request: SendRequest, extraArgs: string[] = []): string[] {
  return [
    "-p",
    request.prompt,
    "--model",
    request.model,
    "--effort",
    "low",
    "--output-format",
    "json",
    "--print-timeout",
    "90s",
    "--sandbox",
    "--mode",
    "plan",
    "--disable-slash-commands",
    ...extraArgs,
  ];
}

export function parseAgySendOutput(stdout: string): { accepted: boolean; conversationId: string | null; status: string } {
  const match = stdout.match(/\{[\s\S]*"status"\s*:\s*"[^"]+"[\s\S]*\}/);
  if (!match) return { accepted: false, conversationId: null, status: "" };
  try {
    const parsed = JSON.parse(match[0]) as { status?: string; conversation_id?: string };
    return {
      accepted: parsed.status === "SUCCESS",
      conversationId: parsed.conversation_id || null,
      status: parsed.status || "",
    };
  } catch {
    return { accepted: false, conversationId: null, status: "" };
  }
}

export async function sendAntigravity(request: SendRequest, agy: string, signal?: AbortSignal): Promise<SendResult> {
  if (isShuttingDown() || signal?.aborted) return { outcome: "not_sent", sessionId: null, detail: "退出中，未启动发送", started: false };
  const help = await runCommand({ command: agy, args: ["--help"], timeoutMs: 10_000, signal });
  if (isShuttingDown() || signal?.aborted) return { outcome: "not_sent", sessionId: null, detail: "退出中，未启动发送", started: false };
  const isolation = assessAgyIsolation(commandText(help));
  if (!isolation.ok) {
    return { outcome: "not_sent", sessionId: null, detail: isolation.reason, started: false };
  }
  const listed = await runCommand({ command: agy, args: ["models"], timeoutMs: 20_000, env: safeEnv(), signal });
  if (isShuttingDown() || signal?.aborted) return { outcome: "not_sent", sessionId: null, detail: "退出中，未启动发送", started: false };
  if (!listed.stdout.split(/\s+/).includes(request.model)) {
    return { outcome: "not_sent", sessionId: null, detail: "目标模型不在当前 agy models 列表中", started: false };
  }
  const args = buildAgyArgs(request, isolation.extraArgs);
  const result = await runCommand({
    command: agy,
    args,
    cwd: request.workDir,
    timeoutMs: 100_000,
    env: safeEnv(),
    signal,
  });
  if (!result.started) return { outcome: "not_sent", sessionId: null, detail: result.spawnError || "未能启动 agy", started: false };
  const parsed = parseAgySendOutput(result.stdout);
  if (parsed.accepted && result.code === 0 && !result.timedOut) return { outcome: "accepted", sessionId: parsed.conversationId, detail: "agy 接受了短消息", started: true };
  return { outcome: "unknown", sessionId: parsed.conversationId, detail: result.stderr.slice(0, 300) || `exit ${result.code}`, started: true };
}

async function readAntigravityViaCli(options: {
  agy?: string | null;
  now?: number;
  priors?: PriorWindow[];
  usageText?: string;
  helpText?: string;
  modelsText?: string;
  signal?: AbortSignal;
}, now: number): Promise<ProviderSnapshot | ProviderReadError> {
  if (options.signal?.aborted) return cancelledRead();
  if (!options.agy && !options.usageText) {
    return { provider: "antigravity", category: "unavailable", message: "App language server 未运行，且未配置 agy", retryAfterMs: 30_000 };
  }
  try {
    const usageText = options.usageText ?? (options.agy ? (await runCommand({
      command: options.agy,
      args: ["-p", "/usage", "--output-format", "text", "--print-timeout", "20s", "--sandbox", "--mode", "plan"],
      timeoutMs: 25_000,
      env: safeEnv(),
      signal: options.signal,
    })).stdout : "");
    const helpText = options.helpText ?? (options.agy ? commandText(await runCommand({ command: options.agy, args: ["--help"], timeoutMs: 10_000, signal: options.signal })) : "");
    const modelsText = options.modelsText ?? (options.agy ? (await runCommand({ command: options.agy, args: ["models"], timeoutMs: 20_000, env: safeEnv(), signal: options.signal })).stdout : "");
    const groups = parseAgyUsageTable(usageText);
    if (groups.length === 0) {
      return { provider: "antigravity", category: "protocol", message: "agy /usage 没有返回可解析额度", retryAfterMs: 30_000 };
    }
    const cli = options.agy && !options.usageText ? await readAgyIdentity(options.agy, options.signal) : { email: "", credits: null as number | null, error: "" };
    const isolation = assessAgyIsolation(helpText);
    const pools = mapGroups({
      email: cli.email || "cli-unverified",
      groups,
      secondGroups: [],
      now,
      priors: options.priors || [],
      credits: cli.credits,
      consistent: cli.email ? null : false,
      isolation,
      modelMap: selectAgyModels(modelsText),
    });
    return {
      provider: "antigravity",
      accountId: cli.email || "cli-unverified",
      accountLabel: cli.email,
      authMode: "agy-cli",
      appCliConsistent: false,
      consistencyEvidence: cli.email
        ? "App language server 未运行，身份来自 agy keyring 日志；未与图形进程交叉核对"
        : "非图形读取没有得到账号邮箱",
      pools,
      observedAt: now,
      rawSummary: redactJson({ source: "agy-usage", groups, isolation: isolation.reason }),
    };
  } catch (error) {
    return { provider: "antigravity", category: "unavailable", message: error instanceof Error ? error.message : String(error), retryAfterMs: 30_000 };
  }
}

function needsSlideCheck(bucket: Bucket): boolean {
  return bucket.remainingFraction != null
    && bucket.remainingFraction >= 0.999999
    && !/you have used/i.test(bucket.description || "");
}

async function startOwnedLanguageServer(signal?: AbortSignal): Promise<{ endpoint: { scheme: "https"; port: number; csrf: string }; stop: () => void } | null> {
  if (signal?.aborted) return null;
  const bin = "/Applications/Antigravity.app/Contents/Resources/bin/language_server";
  if (!fs.existsSync(bin)) return null;
  const csrf = crypto.randomUUID();
  let version = "unknown";
  try {
    version = execFileSync("/usr/bin/defaults", ["read", "/Applications/Antigravity.app/Contents/Info", "CFBundleShortVersionString"], { encoding: "utf8" }).trim() || "unknown";
  } catch { /* 版本未知不影响启动尝试 */ }
  const { spawn } = await import("node:child_process");
  const { trackChild, killTree } = await import("../proc.js");
  const child = spawn(bin, [
    "--standalone",
    "--override_ide_name", "antigravity",
    "--subclient_type", "hub",
    "--override_ide_version", version,
    "--override_user_agent_name", "antigravity",
    "--https_server_port", "0",
    "--csrf_token", csrf,
    "--app_data_dir", "antigravity",
    "--api_server_url", "https://generativelanguage.googleapis.com",
    "--cloud_code_endpoint", "https://daily-cloudcode-pa.googleapis.com",
  ], { detached: true, stdio: "ignore" });
  trackChild(child);
  const stop = () => killTree(child);
  const onAbort = () => stop();
  signal?.addEventListener("abort", onAbort, { once: true });
  const deadline = Date.now() + 8_000;
  try {
    while (Date.now() < deadline && !signal?.aborted) {
      if (!child.pid || child.exitCode != null) break;
      try {
        const ports = execFileSync("/usr/sbin/lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", String(child.pid)], { encoding: "utf8" });
        const port = Number(ports.match(/:(\d+)\s+\(LISTEN\)/)?.[1]);
        if (port && !signal?.aborted) return { endpoint: { scheme: "https", port, csrf }, stop };
      } catch { /* 尚未监听 */ }
      await delay(200, signal);
    }
  } catch {
    stop();
    return null;
  } finally {
    if (signal?.aborted) stop();
  }
  stop();
  return null;
}

function detectEndpoint(): { scheme: "https" | "http"; port: number; csrf: string } | null {
  const text = execFileSync("/bin/ps", ["-ax", "-o", "pid=,command="], { encoding: "utf8" });
  const line = text.split("\n").find((item) => item.includes("language_server") && item.includes("--csrf_token") && item.toLowerCase().includes("antigravity"));
  if (!line) return null;
  const pid = line.trim().split(/\s+/)[0];
  const csrf = line.match(/--csrf_token(?:=|\s+)(\S+)/)?.[1];
  if (!pid || !csrf) return null;
  const ports = execFileSync("/usr/sbin/lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", pid], { encoding: "utf8" });
  const port = Number(ports.match(/:(\d+)\s+\(LISTEN\)/)?.[1]);
  if (!port) return null;
  return { scheme: "https", port, csrf };
}

export function callLs(endpoint: { scheme: "https" | "http"; port: number; csrf: string }, method: string, body: unknown, signal?: AbortSignal): Promise<any> {
  if (signal?.aborted) return Promise.reject(new Error("读取已取消"));
  const payload = Buffer.from(JSON.stringify(body));
  const transport = endpoint.scheme === "https" ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.request({
      host: "127.0.0.1",
      port: endpoint.port,
      method: "POST",
      path: `/${SERVICE}/${method}`,
      headers: {
        "content-type": "application/json",
        "content-length": payload.length,
        "connect-protocol-version": "1",
        "x-codeium-csrf-token": endpoint.csrf,
        "user-agent": "AIQuota5h",
      },
      timeout: 12_000,
      rejectUnauthorized: false,
      signal,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode !== 200) {
          reject(new Error(`${method} returned ${res.statusCode}`));
          return;
        }
        try { resolve(JSON.parse(text)); } catch (error) { reject(error); }
      });
    });
    const onAbort = () => req.destroy(new Error("读取已取消"));
    signal?.addEventListener("abort", onAbort, { once: true });
    req.on("close", () => signal?.removeEventListener("abort", onAbort));
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error(`${method} timed out`)));
    req.write(payload);
    req.end();
  });
}

export async function confirmAgyAccount(agy: string, expected: string): Promise<boolean> {
  const identity = await readAgyIdentity(agy);
  return Boolean(identity.email && identity.email === expected.trim().toLowerCase());
}

async function readAgyIdentity(agy: string, signal?: AbortSignal): Promise<{ email: string; credits: number | null; error: string }> {
  const logFile = path.join(os.tmpdir(), `aiquota5h-agy-${process.pid}.log`);
  try {
    const credits = await runCommand({
      command: agy,
      args: ["--log-file", logFile, "-p", "/credits", "--output-format", "text", "--print-timeout", "20s", "--sandbox", "--mode", "plan"],
      timeoutMs: 25_000,
      env: safeEnv(),
      signal,
    });
    const email = fs.existsSync(logFile)
      ? (fs.readFileSync(logFile, "utf8").match(/email=([^\s,]+)/)?.[1] || "").toLowerCase()
      : "";
    const match = credits.stdout.match(/Remaining credits\s+(\d+)/i);
    return { email, credits: match ? Number(match[1]) : null, error: credits.stderr.slice(0, 200) };
  } catch (error) {
    return { email: "", credits: null, error: error instanceof Error ? error.message : String(error) };
  } finally {
    try { fs.unlinkSync(logFile); } catch { /* 无日志 */ }
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error("读取已取消"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("读取已取消"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function cancelledRead(): ProviderReadError {
  return { provider: "antigravity", category: "unavailable", message: "读取已取消", retryAfterMs: 15_000 };
}
