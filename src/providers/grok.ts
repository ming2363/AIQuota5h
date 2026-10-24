import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isShuttingDown, runCommand, safeEnv } from "../proc.js";
import { redactJson } from "../redact.js";
import { classifyWindow } from "../decision.js";
import type { PoolFact, ProviderReadError, ProviderSnapshot, SendRequest, SendResult, WindowFact } from "../types.js";

const BILLING_URL = "https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig";

export function readGrokIdentity(authPath = path.join(os.homedir(), ".grok", "auth.json")): {
  userId: string;
  email: string;
  teamId: string;
} {
  const root = JSON.parse(fs.readFileSync(authPath, "utf8")) as Record<string, { key?: string; user_id?: string; email?: string; team_id?: string }>;
  const entry = Object.entries(root).find(([scope, value]) => scope.startsWith("https://auth.x.ai::") && value?.user_id);
  if (!entry?.[1]?.user_id) throw new Error("Grok 稳定 user_id 缺失");
  return {
    userId: entry[1].user_id,
    email: String(entry[1].email || ""),
    teamId: String(entry[1].team_id || ""),
  };
}

export async function readGrok(now = Date.now(), signal?: AbortSignal): Promise<ProviderSnapshot | ProviderReadError> {
  let identity;
  try {
    identity = readGrokIdentity();
  } catch (error) {
    return { provider: "grok", category: "unauthorized", message: error instanceof Error ? error.message : String(error), retryAfterMs: null };
  }
  const token = readToken();
  if (!token) return { provider: "grok", category: "unauthorized", message: "Grok 登录态缺失", retryAfterMs: null };
  try {
    const parsed = await fetchBilling(token, now, signal, fetch);
    const window = classifyWindow({
      key: "weekly",
      kind: "weekly",
      resetAt: parsed.periodEnd,
      durationMs: parsed.periodEnd && parsed.periodStart ? parsed.periodEnd - parsed.periodStart : null,
      usedPercent: parsed.usedPercent,
      remainingFraction: parsed.usedPercent == null ? null : Math.max(0, 100 - parsed.usedPercent) / 100,
      usageText: "fixed weekly schedule",
      clock: "anchored",
      activationHint: "auto_reset",
      sharesRequest: false,
    }, null, now);
    const fact: WindowFact = {
      key: window.key,
      kind: window.kind,
      activationMode: "auto_reset",
      state: parsed.periodStart != null && parsed.periodEnd != null && now >= parsed.periodStart && now < parsed.periodEnd ? "active" : window.state,
      oldEndedAt: null,
      resetAt: parsed.periodEnd,
      allowance: window.allowance,
      remainingFraction: parsed.usedPercent == null ? null : Math.max(0, Math.min(100, 100 - parsed.usedPercent)) / 100,
      sharesRequest: false,
      evidence: [
        ...window.evidence,
        "官方 FAQ：周额度按 Usage 页展示的固定日程重置，不需要消息启动",
        parsed.periodStart ? `period_start=${new Date(parsed.periodStart).toISOString()}` : "period_start_missing",
        parsed.periodEnd ? `period_end=${new Date(parsed.periodEnd).toISOString()}` : "period_end_missing",
      ],
      windowId: parsed.periodEnd ? `weekly:${parsed.periodEnd}` : "weekly:unknown",
    };
    const pool: PoolFact = {
      provider: "grok",
      accountId: identity.userId,
      accountLabel: identity.email,
      poolId: "supergrok-weekly",
      models: ["grok-4.7", "grok-4.7-build-fast"],
      selectedModel: "grok-4.7",
      billingSafety: "billing_safety_unknown",
      billingEvidence: [
        "订阅身份为 SuperGrok OIDC，backend_billed 在 CLI authenticate 中为 false",
        "未读到 Auto Top Up 开关，不能保证耗尽后不会购买额外额度",
        "周周期自动重置。用户要求新周期可发一条，但费用未知或 blocked 时仍不发送",
      ],
      windows: [fact],
      observedAt: now,
      blockReason: undefined,
    };
    return {
      provider: "grok",
      accountId: identity.userId,
      accountLabel: identity.email,
      authMode: "oidc-cached-token",
      appCliConsistent: true,
      consistencyEvidence: "Grok Build 以 CLI 登录态为准；Grok Bot 不是本工具入口。稳定标识为 user_id，不是 token",
      pools: [pool],
      observedAt: now,
      rawSummary: redactJson({ usedPercent: parsed.usedPercent, periodStart: parsed.periodStart, periodEnd: parsed.periodEnd }),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const category = /401|403|credential/i.test(message) ? "unauthorized" : "unavailable";
    return { provider: "grok", category, message, retryAfterMs: category === "unauthorized" ? null : 30_000 };
  }
}

export function buildGrokArgs(request: Pick<SendRequest, "model" | "prompt" | "workDir">): string[] {
  return [
    "-p",
    request.prompt,
    "--model",
    request.model,
    "--max-turns",
    "1",
    "--disable-web-search",
    "--no-subagents",
    "--no-plan",
    "--permission-mode",
    "dontAsk",
    "--cwd",
    request.workDir,
  ];
}

export async function sendGrok(request: SendRequest, command = "grok", signal?: AbortSignal): Promise<SendResult> {
  if (isShuttingDown() || signal?.aborted) return { outcome: "not_sent", sessionId: null, detail: "退出中，未启动发送", started: false };
  if (!request.model) return { outcome: "not_sent", sessionId: null, detail: "没有可用模型", started: false };
  const args = buildGrokArgs(request);
  const help = await runCommand({ command, args: ["-h"], timeoutMs: 10_000, signal });
  if (isShuttingDown() || signal?.aborted) return { outcome: "not_sent", sessionId: null, detail: "退出中，未启动发送", started: false };
  const helpText = `${help.stdout}\n${help.stderr}`;
  for (const flag of ["--single", "--max-turns", "--disable-web-search", "--no-subagents", "--no-plan", "--permission-mode", "--cwd"]) {
    if (!helpText.includes(flag)) return { outcome: "not_sent", sessionId: null, detail: `Grok 帮助缺少 ${flag}`, started: false };
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
  if (!result.started) return { outcome: "not_sent", sessionId: null, detail: result.spawnError || "未能启动 grok", started: false };
  const sessionId = result.stdout.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0] || null;
  if (result.code === 0 && result.stdout.trim() && !result.timedOut) {
    return { outcome: "accepted", sessionId, detail: "Grok 接受了本次短消息", started: true };
  }
  return { outcome: "unknown", sessionId, detail: result.stderr.slice(0, 300) || `exit ${result.code}`, started: true };
}

function readToken(): string {
  const root = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".grok", "auth.json"), "utf8")) as Record<string, { key?: string }>;
  const entry = Object.entries(root).find(([scope, value]) => scope.startsWith("https://auth.x.ai::") && value?.key);
  return entry?.[1].key?.trim() || "";
}

export async function fetchBilling(
  token: string,
  now: number,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<{ usedPercent: number | null; periodStart: number | null; periodEnd: number | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  const onAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener("abort", onAbort);
  try {
    const response = await fetchImpl(BILLING_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        "X-XAI-Token-Auth": "xai-grok-cli",
        Accept: "*/*",
        "Content-Type": "application/grpc-web+proto",
        Origin: "https://grok.com",
        Referer: "https://grok.com/?_s=usage",
        "x-grpc-web": "1",
        "x-user-agent": "connect-es/2.1.1",
      },
      body: Buffer.from([0, 0, 0, 0, 0]),
    });
    if (response.status === 401 || response.status === 403) throw new Error("Grok billing unauthorized");
    if (!response.ok) throw new Error(`Grok billing HTTP ${response.status}`);
    const bytes = await readBody(response, controller.signal);
    return parseCredits(bytes, now);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

async function readBody(response: Response, signal: AbortSignal): Promise<Buffer> {
  if (signal.aborted) throw new Error("读取已取消");
  const body = response.body;
  if (!body) return Buffer.from(await response.arrayBuffer());
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  const onAbort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    while (!signal.aborted) {
      const next = await Promise.race([
        reader.read(),
        new Promise<never>((_resolve, reject) => {
          if (signal.aborted) reject(new Error("读取已取消"));
          else signal.addEventListener("abort", () => reject(new Error("读取已取消")), { once: true });
        }),
      ]);
      if (next.done) break;
      chunks.push(Buffer.from(next.value));
    }
    if (signal.aborted) throw new Error("读取已取消");
    return Buffer.concat(chunks);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export function parseCredits(bytes: Buffer, now: number): { usedPercent: number | null; periodStart: number | null; periodEnd: number | null } {
  const payload = grpcPayload(bytes);
  const scan = scanProto(payload);
  const percent = scan.floats.find((field) => field.path.endsWith(".1") && field.value >= 0 && field.value <= 100)?.value ?? null;
  const start = scan.varints.find((field) => field.path === "1.4.1")?.value;
  const end = scan.varints.find((field) => field.path === "1.5.1")?.value;
  return {
    usedPercent: percent,
    periodStart: start ? start * 1000 : null,
    periodEnd: end && end * 1000 > now - 86_400_000 ? end * 1000 : end ? end * 1000 : null,
  };
}

function grpcPayload(bytes: Buffer): Buffer {
  let offset = 0;
  const frames: Buffer[] = [];
  while (offset + 5 <= bytes.length) {
    const flags = bytes[offset];
    const length = bytes.readUInt32BE(offset + 1);
    const start = offset + 5;
    const end = start + length;
    if (end > bytes.length) break;
    if ((flags & 0x80) === 0) frames.push(bytes.subarray(start, end));
    offset = end;
  }
  return frames[0] || Buffer.alloc(0);
}

function scanProto(bytes: Buffer, pathPrefix: number[] = [], depth = 0): { floats: Array<{ path: string; value: number }>; varints: Array<{ path: string; value: number }> } {
  const out = { floats: [] as Array<{ path: string; value: number }>, varints: [] as Array<{ path: string; value: number }> };
  let offset = 0;
  while (offset < bytes.length && depth < 8) {
    const key = readVarint(bytes, offset);
    if (!key) break;
    offset = key.offset;
    const field = Math.floor(key.value / 8);
    const wire = key.value % 8;
    const next = pathPrefix.concat(field);
    const name = next.join(".");
    if (wire === 0) {
      const value = readVarint(bytes, offset);
      if (!value) break;
      out.varints.push({ path: name, value: value.value });
      offset = value.offset;
    } else if (wire === 1) offset += 8;
    else if (wire === 2) {
      const length = readVarint(bytes, offset);
      if (!length) break;
      offset = length.offset;
      const end = offset + length.value;
      if (end > bytes.length) break;
      const nested = scanProto(bytes.subarray(offset, end), next, depth + 1);
      out.floats.push(...nested.floats);
      out.varints.push(...nested.varints);
      offset = end;
    } else if (wire === 5) {
      out.floats.push({ path: name, value: bytes.readFloatLE(offset) });
      offset += 4;
    } else break;
  }
  return out;
}

function readVarint(bytes: Buffer, start: number): { value: number; offset: number } | null {
  let value = 0n;
  let shift = 0n;
  let offset = start;
  while (offset < bytes.length && shift <= 63n) {
    const byte = bytes[offset];
    value |= BigInt(byte & 0x7f) << shift;
    offset += 1;
    if ((byte & 0x80) === 0) return { value: Number(value), offset };
    shift += 7n;
  }
  return null;
}
