import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isShuttingDown, runCommand, safeEnv } from "../proc.js";
import { redactJson } from "../redact.js";
import { classifyWindow } from "../decision.js";
import { ProviderHttpError, retryAfterMs } from "./http.js";
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
  try {
    const token = readToken();
    if (!token) return { provider: "grok", category: "unauthorized", message: "Grok 登录态缺失", retryAfterMs: null };
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
    const category = error instanceof ProviderHttpError && error.status === 429 ? "rate_limited" : /401|403|credential/i.test(message) ? "unauthorized" : "unavailable";
    return { provider: "grok", category, message, retryAfterMs: error instanceof ProviderHttpError && error.retryAfterMs != null ? error.retryAfterMs : category === "rate_limited" ? 300_000 : category === "unauthorized" ? null : 30_000 };
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
    if (!response.ok) throw new ProviderHttpError(`Grok billing HTTP ${response.status}`, response.status, retryAfterMs(response.headers));
    checkGrpcStatus(response.headers.get("grpc-status"));
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
  let size = 0;
  const onAbort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    while (!signal.aborted) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > 1024 * 1024) { await reader.cancel(); throw new Error("Grok 额度响应超过大小限制"); }
      chunks.push(Buffer.from(next.value));
    }
    if (signal.aborted) throw new Error("读取已取消");
    return Buffer.concat(chunks);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

// Field numbers and proto3 defaults verified against grok.com's GrokCreditsConfig descriptor.
export function parseCredits(bytes: Buffer, _now: number): { usedPercent: number | null; periodStart: number | null; periodEnd: number | null } {
  const response = protoFields(grpcPayload(bytes));
  const config = messageField(response, 1);
  if (!config) throw new Error("Grok 额度响应缺少 config，未覆盖历史额度");
  const fields = protoFields(config);
  const current = messageField(fields, 8);
  if (!current) throw new Error("Grok 额度响应缺少当前周期，未覆盖历史额度");
  const period = protoFields(current);
  if (numberField(period, 1, 0) !== 2) throw new Error("Grok 返回的不是已支持的周额度周期");
  const timestamp = (field: number): number => {
    const message = messageField(period, field);
    if (!message) throw new Error("Grok 周期时间缺失");
    const values = protoFields(message);
    const seconds = numberField(values, 1, 0);
    const nanos = numberField(values, 2, 0) ?? 0;
    if (seconds == null || seconds <= 0 || nanos < 0 || nanos >= 1e9) throw new Error("Grok 周期时间无效");
    return seconds * 1000 + Math.floor(nanos / 1e6);
  };
  const periodStart = timestamp(2), periodEnd = timestamp(3);
  if (periodEnd <= periodStart || Math.abs(periodEnd - periodStart - 7 * 86400_000) > 1000) throw new Error("Grok 周期长度异常，未覆盖历史额度");
  // A confirmed unified weekly config uses a non-optional proto3 float: omitted means zero.
  // Never default a missing config, a legacy account or an unrelated product percentage to zero.
  const unified = numberField(fields, 11, 0) === 1;
  const value = numberField(fields, 1, 5);
  const percent = value ?? (unified ? 0 : null);
  const usedPercent = percent != null && Number.isFinite(percent) && percent >= 0 && percent <= 100 ? percent : null;
  return { usedPercent, periodStart, periodEnd };
}

function checkGrpcStatus(status: string | null): void {
  if (status == null || status === "0") return;
  const http = status === "8" ? 429 : status === "16" ? 401 : status === "7" ? 403 : 502;
  throw new ProviderHttpError(`Grok gRPC status ${status} (HTTP ${http})`, http);
}

function grpcPayload(bytes: Buffer): Buffer {
  let offset = 0;
  let payload: Buffer | null = null;
  while (offset < bytes.length) {
    if (offset + 5 > bytes.length) throw new Error("Grok gRPC 帧头不完整");
    const flags = bytes[offset];
    const length = bytes.readUInt32BE(offset + 1);
    const start = offset + 5, end = start + length;
    if (end > bytes.length) throw new Error("Grok gRPC 响应被截断");
    if (flags === 0x80) {
      const trailers = bytes.subarray(start, end).toString("utf8");
      checkGrpcStatus(trailers.match(/(?:^|\r?\n)grpc-status:\s*(\d+)/i)?.[1] ?? null);
    } else if (flags === 0 && payload == null) payload = bytes.subarray(start, end);
    else throw new Error("Grok gRPC 帧格式不支持");
    offset = end;
  }
  if (!payload) throw new Error("Grok gRPC 响应缺少数据");
  return payload;
}

type ProtoField = { wire: number; value: number | Buffer };
function protoFields(bytes: Buffer): Map<number, ProtoField[]> {
  const fields = new Map<number, ProtoField[]>();
  let offset = 0;
  while (offset < bytes.length) {
    const key = readVarint(bytes, offset);
    if (!key) throw new Error("Grok protobuf 标签不完整");
    offset = key.offset;
    const field = Math.floor(key.value / 8), wire = key.value % 8;
    if (!field || field > 536870911) throw new Error("Grok protobuf 字段无效");
    let value: number | Buffer;
    if (wire === 0) {
      const item = readVarint(bytes, offset);
      if (!item) throw new Error("Grok protobuf 整数字段不完整");
      value = item.value; offset = item.offset;
    } else if (wire === 1 || wire === 5) {
      const length = wire === 1 ? 8 : 4;
      if (offset + length > bytes.length) throw new Error("Grok protobuf 数值字段不完整");
      value = wire === 1 ? bytes.readDoubleLE(offset) : bytes.readFloatLE(offset); offset += length;
    } else if (wire === 2) {
      const length = readVarint(bytes, offset);
      if (!length || length.value > bytes.length - length.offset) throw new Error("Grok protobuf 消息不完整");
      offset = length.offset;
      value = bytes.subarray(offset, offset + length.value); offset += length.value;
    } else throw new Error("Grok protobuf 编码不支持");
    const list = fields.get(field) || [];
    list.push({ wire, value }); fields.set(field, list);
  }
  return fields;
}

function scalarField(fields: Map<number, ProtoField[]>, key: number, wire: number): ProtoField | undefined {
  const list = fields.get(key);
  if (!list) return undefined;
  if (list.length !== 1 || list[0].wire !== wire) throw new Error("Grok 额度协议字段类型已变化");
  return list[0];
}
function numberField(fields: Map<number, ProtoField[]>, key: number, wire: number): number | null {
  return scalarField(fields, key, wire)?.value as number ?? null;
}
function messageField(fields: Map<number, ProtoField[]>, key: number): Buffer | undefined {
  return scalarField(fields, key, 2)?.value as Buffer | undefined;
}
function readVarint(bytes: Buffer, start: number): { value: number; offset: number } | null {
  let value = 0n, shift = 0n, offset = start;
  while (offset < bytes.length && shift <= 63n) {
    const byte = bytes[offset];
    value |= BigInt(byte & 0x7f) << shift;
    offset += 1;
    if ((byte & 0x80) === 0) {
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Grok protobuf 整数超出安全范围");
      return { value: Number(value), offset };
    }
    shift += 7n;
  }
  return null;
}
