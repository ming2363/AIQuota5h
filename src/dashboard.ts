import { maskEmail, maskId, redactText } from "./redact.js";
import type { Store, TaskRow } from "./store.js";
import { blocksActivation } from "./verify.js";
import type { WindowFact } from "./types.js";

export const PROVIDER_NAMES: Record<string, string> = {
  codex: "Codex", claude: "Claude Code", antigravity: "Antigravity", grok: "Grok Build",
};

export function poolName(provider: string, pool: string): string {
  if (provider === "antigravity") return ({ gemini: "Gemini", "claude-gpt": "Claude / GPT-OSS", "gemini-argon": "Gemini 4 Argon" } as Record<string, string>)[pool] || pool;
  return PROVIDER_NAMES[provider] || pool;
}

export function dashboard(store: Store, running: boolean, now = Date.now()) {
  const windows = store.allWindows();
  const outstanding = store.activationTasks();
  const order = Object.keys(PROVIDER_NAMES);
  const pools = store.snapshots().sort((a, b) => order.indexOf(String(a.provider)) - order.indexOf(String(b.provider))).filter((row) => {
    const account = store.getMeta(`account:${row.provider}`);
    return !account || account === row.account_id;
  }).map((row) => {
    const related = windows.filter((item) => item.provider === row.provider && item.account_id === row.account_id && item.pool_id === row.pool_id);
    const guards = outstanding.filter((task) => {
      if (task.provider !== row.provider || task.account_id !== row.account_id || task.pool_id !== row.pool_id) return false;
      const window = related.find((item) => item.window_key === task.window_key);
      return blocksActivation(task, window ? {
        key: window.window_key, state: window.state as WindowFact["state"], activationMode: window.activation_mode as WindowFact["activationMode"],
        oldEndedAt: window.old_ended_at, resetAt: window.reset_at,
      } : undefined, now);
    });
    const label = String(row.account_label || row.account_id);
    return {
      id: `${row.provider}:${row.pool_id}`, provider: String(row.provider), poolId: String(row.pool_id),
      name: poolName(String(row.provider), String(row.pool_id)),
      account: label.includes("@") ? maskEmail(label) : maskId(label),
      selectedModel: row.selected_model as string | null,
      models: jsonArray(row.models_json), observedAt: Number(row.observed_at),
      stale: now - Number(row.observed_at) > 180_000,
      billingSafety: String(row.billing_safety), blockReason: row.block_reason ? redactText(String(row.block_reason)) : null,
      guards: guards.map((task) => task.id),
      autoActivate: row.provider !== "claude" && store.getMeta(`activate:${row.provider}:${row.pool_id}`) !== "0",
      monitoring: store.monitoring(String(row.provider)),
      activationSupported: row.provider !== "claude",
      lastRead: store.db.prepare("SELECT status, detail, started_at AS startedAt, finished_at AS finishedAt FROM provider_reads WHERE provider = ? ORDER BY id DESC LIMIT 1").get(String(row.provider)) || null,
      windows: related.map((window) => ({
        id: window.window_key, name: window.window_key === "5h" ? "5 小时额度" : window.window_key === "weekly" ? "周额度" : window.kind,
        state: window.state, activationMode: window.activation_mode, allowance: window.allowance,
        remainingFraction: window.remaining_fraction, resetAt: window.reset_at, dueAt: window.due_at,
        evidence: jsonArray(window.evidence).map(redactText),
      })),
    };
  });
  return {
    version: 1, generatedAt: now, running, paused: store.paused(), pools,
    refreshPending: store.getMeta("refreshRequested") !== store.getMeta("refreshAcknowledged"),
    providers: Object.entries(PROVIDER_NAMES).map(([id, name]) => ({
      id, name, auth: store.getMeta(`auth:${id}`) || "unknown",
      monitoring: store.monitoring(id),
      lastRead: store.db.prepare("SELECT status, detail, started_at AS startedAt, finished_at AS finishedAt FROM provider_reads WHERE provider = ? ORDER BY id DESC LIMIT 1").get(id) || null,
      hasSnapshot: pools.some((pool) => pool.provider === id),
    })),
  };
}

export function readHistory(store: Store, offset = 0, limit = 30) {
  const total = (store.db.prepare("SELECT COUNT(*) AS n FROM provider_reads").get() as { n: number }).n;
  const rows = store.db.prepare("SELECT id, provider, started_at AS at, finished_at AS finishedAt, reason, status, detail FROM provider_reads ORDER BY id DESC LIMIT ? OFFSET ?").all(limit, offset) as Array<{ id: number; provider: string; at: number; finishedAt: number | null; reason: string; status: string; detail: string }>;
  const items = rows.map((row) => ({ ...row, detail: redactText(row.detail) }));
  return { total, offset, limit, items };
}

export function taskHistory(store: Store, offset = 0, limit = 30, provider?: string) {
  const where = provider ? " WHERE provider = ?" : "";
  const params = provider ? [provider] : [];
  const total = (store.db.prepare(`SELECT COUNT(*) AS n FROM tasks${where}`).get(...params) as { n: number }).n;
  const rows = store.db.prepare(`SELECT * FROM tasks${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset) as unknown as TaskRow[];
  return { total, offset, limit, items: rows.map((row) => ({
    id: row.id, provider: row.provider, pool: poolName(row.provider, row.pool_id), window: row.window_key,
    status: row.status === "skipped" && row.error_category === "period_unconfirmed" ? "historical_unconfirmed" : row.status,
    attempts: row.attempt_count, at: row.claimed_at || row.updated_at, updatedAt: row.updated_at,
    messageResult: row.message_result, windowResult: row.window_result,
    detail: redactText(row.detail || ""),
  })) };
}

function jsonArray(value: unknown): string[] {
  try { const parsed: unknown = JSON.parse(String(value)); return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []; }
  catch { return []; }
}
