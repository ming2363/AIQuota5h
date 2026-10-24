import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { GRACE_MS, type PoolFact, type ProviderId, type TaskStatus, type WindowFact } from "./types.js";
import { blocksActivation } from "./verify.js";

export interface TaskRow {
  id: number;
  provider: ProviderId;
  account_id: string;
  pool_id: string;
  expired_window_id: string;
  window_key: string;
  old_ended_at: number;
  due_at: number;
  status: TaskStatus;
  attempt_count: number;
  session_id: string | null;
  message_result: string | null;
  window_result: string | null;
  error_category: string | null;
  detail: string | null;
  updated_at: number;
  claimed_at?: number | null;
  phase: string | null;
  retry_after: number | null;
}

export interface WindowRow {
  provider: string;
  account_id: string;
  pool_id: string;
  window_key: string;
  window_id: string;
  kind: string;
  activation_mode: string;
  state: string;
  evidence: string;
  old_ended_at: number | null;
  preserved_boundary: number | null;
  reset_at: number | null;
  due_at: number | null;
  remaining_fraction: number | null;
  allowance: string;
  shares_request: number;
  updated_at: number;
}

export class Store {
  readonly db: DatabaseSync;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    this.migrate();
    this.ensurePhase();
    this.updateGracePolicy();
  }

  private updateGracePolicy(): void {
    if (this.getMeta("gracePolicyMs") === String(GRACE_MS)) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE windows SET due_at = old_ended_at + ? WHERE old_ended_at IS NOT NULL").run(GRACE_MS);
      this.db.prepare("UPDATE tasks SET due_at = old_ended_at + ? WHERE status IN ('pending','deferred') AND phase = 'claimed' AND (message_result IS NULL OR message_result = 'not_sent')").run(GRACE_MS);
      this.setMeta("gracePolicyMs", String(GRACE_MS));
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  private ensurePhase(): void {
    const columns = this.db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "phase")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN phase TEXT");
    }
    if (!columns.some((column) => column.name === "retry_after")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN retry_after INTEGER");
    }
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pool_snapshots (
        provider TEXT NOT NULL,
        account_id TEXT NOT NULL,
        pool_id TEXT NOT NULL,
        observed_at INTEGER NOT NULL,
        account_label TEXT NOT NULL,
        selected_model TEXT,
        models_json TEXT NOT NULL,
        billing_safety TEXT NOT NULL,
        billing_evidence TEXT NOT NULL,
        block_reason TEXT,
        raw_summary TEXT NOT NULL,
        PRIMARY KEY (provider, account_id, pool_id)
      );
      CREATE TABLE IF NOT EXISTS windows (
        provider TEXT NOT NULL,
        account_id TEXT NOT NULL,
        pool_id TEXT NOT NULL,
        window_key TEXT NOT NULL,
        window_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        activation_mode TEXT NOT NULL,
        state TEXT NOT NULL,
        evidence TEXT NOT NULL,
        old_ended_at INTEGER,
        preserved_boundary INTEGER,
        reset_at INTEGER,
        due_at INTEGER,
        remaining_fraction REAL,
        allowance TEXT NOT NULL,
        shares_request INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (provider, account_id, pool_id, window_key)
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        account_id TEXT NOT NULL,
        pool_id TEXT NOT NULL,
        expired_window_id TEXT NOT NULL,
        window_key TEXT NOT NULL,
        old_ended_at INTEGER NOT NULL,
        due_at INTEGER NOT NULL,
        status TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        claimed_at INTEGER,
        session_id TEXT,
        message_result TEXT,
        window_result TEXT,
        error_category TEXT,
        detail TEXT,
        updated_at INTEGER NOT NULL,
        phase TEXT,
        retry_after INTEGER,
        UNIQUE (provider, account_id, pool_id, expired_window_id)
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        level TEXT NOT NULL,
        provider TEXT,
        message TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS provider_reads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        reason TEXT NOT NULL,
        status TEXT NOT NULL,
        detail TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS provider_reads_provider_id ON provider_reads(provider, id DESC);
    `);
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  paused(): boolean {
    return this.getMeta("paused") === "1";
  }

  setPaused(paused: boolean): void {
    this.setMeta("paused", paused ? "1" : "0");
  }

  monitoring(provider: string): boolean {
    return this.getMeta(`monitor:${provider}`) !== "0";
  }

  activating(provider: string, poolId: string): boolean {
    return provider !== "claude" && this.monitoring(provider) && this.getMeta(`activate:${provider}:${poolId}`) !== "0";
  }

  startRead(provider: string, reason: string, at: number): number {
    return Number(this.db.prepare("INSERT INTO provider_reads(provider, started_at, reason, status, detail) VALUES(?, ?, ?, 'running', '')").run(provider, at, reason).lastInsertRowid);
  }

  finishRead(id: number, status: string, detail: string, at: number): void {
    this.db.prepare("UPDATE provider_reads SET finished_at = ?, status = ?, detail = ? WHERE id = ?").run(at, status, detail.slice(0, 1000), id);
  }

  addEvent(level: string, message: string, provider?: string, at = Date.now()): void {
    this.db.prepare("INSERT INTO events(at, level, provider, message) VALUES(?, ?, ?, ?)").run(at, level, provider ?? null, message.slice(0, 1000));
    this.db.prepare("DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY id DESC LIMIT 500)").run();
  }

  savePool(pool: PoolFact, rawSummary: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`
        INSERT INTO pool_snapshots(
          provider, account_id, pool_id, observed_at, account_label, selected_model,
          models_json, billing_safety, billing_evidence, block_reason, raw_summary
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(provider, account_id, pool_id) DO UPDATE SET
          observed_at = excluded.observed_at,
          account_label = excluded.account_label,
          selected_model = excluded.selected_model,
          models_json = excluded.models_json,
          billing_safety = excluded.billing_safety,
          billing_evidence = excluded.billing_evidence,
          block_reason = excluded.block_reason,
          raw_summary = excluded.raw_summary
      `).run(
        pool.provider,
        pool.accountId,
        pool.poolId,
        pool.observedAt,
        pool.accountLabel,
        pool.selectedModel,
        JSON.stringify(pool.models),
        pool.billingSafety,
        JSON.stringify(pool.billingEvidence),
        pool.blockReason ?? null,
        rawSummary,
      );
      const keep = new Set(pool.windows.map((window) => window.key));
      const existing = this.db.prepare(
        "SELECT window_key FROM windows WHERE provider = ? AND account_id = ? AND pool_id = ?",
      ).all(pool.provider, pool.accountId, pool.poolId) as Array<{ window_key: string }>;
      for (const row of existing) {
        if (!keep.has(row.window_key)) {
          this.db.prepare(
            "DELETE FROM windows WHERE provider = ? AND account_id = ? AND pool_id = ? AND window_key = ?",
          ).run(pool.provider, pool.accountId, pool.poolId, row.window_key);
        }
      }
      for (const window of pool.windows) {
        const dueAt = window.oldEndedAt == null ? null : window.oldEndedAt + GRACE_MS;
        this.db.prepare(`
          INSERT INTO windows(
            provider, account_id, pool_id, window_key, window_id, kind, activation_mode, state,
            evidence, old_ended_at, preserved_boundary, reset_at, due_at, remaining_fraction,
            allowance, shares_request, updated_at
          ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(provider, account_id, pool_id, window_key) DO UPDATE SET
            window_id = excluded.window_id,
            kind = excluded.kind,
            activation_mode = excluded.activation_mode,
            state = excluded.state,
            evidence = excluded.evidence,
            old_ended_at = CASE
              WHEN excluded.old_ended_at IS NOT NULL THEN excluded.old_ended_at
              WHEN excluded.state = 'active' THEN NULL
              ELSE windows.old_ended_at
            END,
            preserved_boundary = CASE
              WHEN excluded.preserved_boundary IS NOT NULL THEN excluded.preserved_boundary
              WHEN excluded.state = 'active' THEN NULL
              ELSE COALESCE(windows.preserved_boundary, windows.old_ended_at)
            END,
            reset_at = excluded.reset_at,
            due_at = CASE
              WHEN excluded.old_ended_at IS NOT NULL THEN excluded.due_at
              WHEN excluded.state = 'active' THEN NULL
              WHEN windows.old_ended_at IS NOT NULL THEN windows.old_ended_at + ${GRACE_MS}
              ELSE excluded.due_at
            END,
            remaining_fraction = excluded.remaining_fraction,
            allowance = excluded.allowance,
            shares_request = excluded.shares_request,
            updated_at = excluded.updated_at
        `).run(
          pool.provider,
          pool.accountId,
          pool.poolId,
          window.key,
          window.windowId,
          window.kind,
          window.activationMode,
          window.state,
          JSON.stringify(window.evidence),
          window.oldEndedAt,
          window.preservedBoundary !== undefined ? window.preservedBoundary : window.oldEndedAt,
          window.resetAt,
          dueAt,
          window.remainingFraction != null && Number.isFinite(window.remainingFraction) && window.remainingFraction >= 0 && window.remainingFraction <= 1 ? window.remainingFraction : null,
          window.allowance,
          window.sharesRequest ? 1 : 0,
          pool.observedAt,
        );
      }
      const genKey = `gen:${pool.provider}:${pool.accountId}:${pool.poolId}`;
      const fpKey = `fp:${pool.provider}:${pool.accountId}:${pool.poolId}`;
      const fingerprint = authorizationFingerprint(pool);
      if (this.getMeta(fpKey) !== fingerprint) {
        const nextGen = Number(this.getMeta(genKey) || "0") + 1;
        this.setMeta(genKey, String(nextGen));
        this.setMeta(fpKey, fingerprint);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  poolGeneration(provider: string, accountId: string, poolId: string): number {
    return Number(this.getMeta(`gen:${provider}:${accountId}:${poolId}`) || "0");
  }

  windowsFor(provider: string, accountId: string, poolId: string): WindowRow[] {
    return this.db.prepare(
      "SELECT * FROM windows WHERE provider = ? AND account_id = ? AND pool_id = ? ORDER BY window_key",
    ).all(provider, accountId, poolId) as unknown as WindowRow[];
  }

  windowPriors(provider: string): Array<{
    key: string;
    resetAt: number | null;
    preservedBoundary: number | null;
    windowId: string;
    accountId: string;
    poolId: string;
    state: "active" | "idle" | "unknown";
    observedAt: number;
  }> {
    return this.allWindows().filter((row) => row.provider === provider).map((row) => ({
      key: row.window_key,
      resetAt: row.reset_at,
      preservedBoundary: row.preserved_boundary,
      windowId: row.window_id,
      accountId: row.account_id,
      poolId: row.pool_id,
      state: row.state === "active" || row.state === "idle" ? row.state : "unknown",
      observedAt: row.updated_at,
    }));
  }

  priorWindow(provider: string, accountId: string, poolId: string, key: string): WindowRow | null {
    return (this.db.prepare(
      "SELECT * FROM windows WHERE provider = ? AND account_id = ? AND pool_id = ? AND window_key = ?",
    ).get(provider, accountId, poolId, key) as WindowRow | undefined) ?? null;
  }

  invalidateAccount(provider: ProviderId, previousAccountId: string, at: number): void {
    this.db.prepare(
      "UPDATE tasks SET status = 'skipped', error_category = 'account_changed', detail = '账号已切换，旧任务失效', updated_at = ? WHERE provider = ? AND account_id = ? AND status IN ('pending','in_flight','verifying','blocked','unknown_result','stalled')",
    ).run(at, provider, previousAccountId);
  }

  claim(pool: PoolFact, windows: WindowFact[], now: number): TaskRow[] {
    if (!this.activating(pool.provider, pool.poolId)) return [];
    const idle = windows.filter((window) => window.oldEndedAt != null);
    if (idle.length === 0) return [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const outstanding = this.activationTasks().filter((row) => row.provider === pool.provider && row.account_id === pool.accountId && row.pool_id === pool.poolId);
      if (outstanding.some((row) => blocksActivation(row, pool.windows.find((window) => window.key === row.window_key), now))) {
        this.db.exec("COMMIT");
        return [];
      }
      const claimed: TaskRow[] = [];
      for (const window of idle) {
        const expiredId = window.windowId;
        this.db.prepare(`
          INSERT INTO tasks(
            provider, account_id, pool_id, expired_window_id, window_key, old_ended_at, due_at,
            status, attempt_count, updated_at
          ) VALUES(?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)
          ON CONFLICT(provider, account_id, pool_id, expired_window_id) DO NOTHING
        `).run(
          pool.provider,
          pool.accountId,
          pool.poolId,
          expiredId,
          window.key,
          window.oldEndedAt,
          (window.oldEndedAt as number) + GRACE_MS,
          now,
        );
        const row = this.db.prepare(
          "SELECT * FROM tasks WHERE provider = ? AND account_id = ? AND pool_id = ? AND expired_window_id = ?",
        ).get(pool.provider, pool.accountId, pool.poolId, expiredId) as TaskRow | undefined;
        if (row && exhaustedTemporary(row)) {
          this.updateTasks([row.id], {
            status: "blocked",
            error_category: row.error_category || "model_unknown",
            detail: row.error_category === "sample_pending" ? "采样间隔不足，有限重试已用尽" : "模型目录暂时失败，有限重试已用尽",
          }, now);
          this.db.exec("COMMIT");
          return [];
        }
        if (!row || !canReclaim(row, now, this.paused())) {
          this.db.exec("COMMIT");
          return [];
        }
        claimed.push(row);
      }
      for (const row of claimed) {
        this.db.prepare(
          "UPDATE tasks SET status = 'in_flight', phase = 'claimed', attempt_count = attempt_count + 1, claimed_at = ?, updated_at = ?, retry_after = NULL WHERE id = ? AND status IN ('pending','deferred')",
        ).run(now, now, row.id);
      }
      const fresh = claimed.map((row) => this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(row.id) as unknown as TaskRow);
      if (fresh.some((row) => row.status !== "in_flight")) {
        this.db.exec("ROLLBACK");
        return [];
      }
      this.db.exec("COMMIT");
      return fresh;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* 已结束 */ }
      throw error;
    }
  }

  updateTasks(ids: number[], patch: Partial<TaskRow> & { status: TaskStatus }, at: number): void {
    for (const id of ids) {
      this.db.prepare(`
        UPDATE tasks SET status = ?, session_id = COALESCE(?, session_id), message_result = COALESCE(?, message_result),
          window_result = COALESCE(?, window_result), error_category = COALESCE(?, error_category),
          detail = COALESCE(?, detail), updated_at = ?,
          retry_after = COALESCE(?, retry_after) WHERE id = ?
      `).run(
        patch.status,
        patch.session_id ?? null,
        patch.message_result ?? null,
        patch.window_result ?? null,
        patch.error_category ?? null,
        patch.detail ?? null,
        at,
        patch.retry_after ?? null,
        id,
      );
    }
  }

  tasksByStatus(statuses: TaskStatus[]): TaskRow[] {
    if (statuses.length === 0) return [];
    const marks = statuses.map(() => "?").join(",");
    return this.db.prepare(`SELECT * FROM tasks WHERE status IN (${marks}) ORDER BY id`).all(...statuses) as unknown as TaskRow[];
  }

  activationTasks(): TaskRow[] {
    return this.db.prepare("SELECT * FROM tasks WHERE status IN ('in_flight','verifying','unknown_result','stalled') OR error_category = 'period_unconfirmed' ORDER BY id").all() as unknown as TaskRow[];
  }

  recentTasks(limit = 20): TaskRow[] {
    return this.db.prepare("SELECT * FROM tasks ORDER BY updated_at DESC LIMIT ?").all(limit) as unknown as TaskRow[];
  }

  recentEvents(limit = 30): Array<{ at: number; level: string; provider: string | null; message: string }> {
    return this.db.prepare("SELECT at, level, provider, message FROM events ORDER BY id DESC LIMIT ?").all(limit) as Array<{ at: number; level: string; provider: string | null; message: string }>;
  }

  snapshots(): Array<Record<string, unknown>> {
    return this.db.prepare("SELECT * FROM pool_snapshots ORDER BY provider, pool_id").all() as Array<Record<string, unknown>>;
  }

  allWindows(): WindowRow[] {
    return this.db.prepare("SELECT * FROM windows ORDER BY provider, pool_id, window_key").all() as unknown as WindowRow[];
  }

  setPhase(ids: number[], phase: string, at: number): void {
    for (const id of ids) {
      this.db.prepare("UPDATE tasks SET phase = ?, updated_at = ? WHERE id = ?").run(phase, at, id);
    }
  }

  recoverInFlight(at: number): TaskRow[] {
    const rows = this.tasksByStatus(["in_flight"]);
    for (const row of rows) {
      if (row.phase === "claimed") {
        if (row.attempt_count >= 2) {
          this.updateTasks([row.id], {
            status: "blocked",
            error_category: "not_sent",
            detail: "领取后未启动外部进程，有限重试已用尽",
          }, at);
        } else {
          this.updateTasks([row.id], {
            status: "pending",
            error_category: "not_sent",
            detail: "领取后未启动外部进程，允许有限重试",
          }, at);
        }
        continue;
      }
      this.updateTasks([row.id], {
        status: "verifying",
        error_category: "recovered",
        detail: "外部进程可能已启动，只冻结本池并先核实",
      }, at);
      this.setPhase([row.id], "spawned", at);
    }
    return this.tasksByStatus(["verifying", "pending", "blocked"]);
  }
}

const RECOVERABLE = new Set(["refresh_failed", "paused", "provider_unavailable", "model_unavailable", "model_unknown", "rate_limited", "stale_authorization", "shutdown", "sample_pending"]);
const TEMPORARY_ATTEMPT_LIMIT = 3;

function authorizationFingerprint(pool: PoolFact): string {
  return JSON.stringify({
    billingSafety: pool.billingSafety,
    blockReason: pool.blockReason || "",
    selectedModel: pool.selectedModel || "",
    windows: [...pool.windows].sort((left, right) => left.key.localeCompare(right.key)).map((window) => ({
      key: window.key,
      state: window.state,
      allowance: window.allowance,
      activationMode: window.activationMode,
      windowId: window.windowId,
      oldEndedAt: window.oldEndedAt,
    })),
  });
}

function exhaustedTemporary(row: TaskRow): boolean {
  return row.status === "deferred"
    && row.phase === "claimed"
    && row.message_result === "not_sent"
    && (row.error_category === "model_unknown" || row.error_category === "model_unavailable" || row.error_category === "sample_pending")
    && row.attempt_count >= TEMPORARY_ATTEMPT_LIMIT;
}

function canReclaim(row: TaskRow, now: number, paused: boolean): boolean {
  if (row.status === "pending") return true;
  if (row.status !== "deferred" || row.phase !== "claimed") return false;
  if (row.message_result && row.message_result !== "not_sent") return false;
  if (!RECOVERABLE.has(row.error_category || "")) return false;
  if (row.error_category === "paused" && paused) return false;
  if (row.retry_after != null && row.retry_after > now) return false;
  return true;
}
