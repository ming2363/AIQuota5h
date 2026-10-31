import fs from "node:fs";
import path from "node:path";
import { SAMPLE_MIN_MS, decide } from "./decision.js";
import { VERIFY_STALL_MS, blocksActivation, confirmsTask, laterPeriodProven, windowDurationMs } from "./verify.js";
import type { Store, TaskRow } from "./store.js";
import { redactText } from "./redact.js";
import { GRACE_MS, providerRefreshMs, SHORT_PROMPT, type PoolFact, type ProviderId, type ProviderReadError, type ProviderSnapshot, type SendResult, type WindowFact } from "./types.js";

export interface EngineDeps {
  store: Store;
  now: () => number;
  read: (provider: ProviderId, signal?: AbortSignal) => Promise<ProviderSnapshot | ProviderReadError>;
  send: (pool: PoolFact, workDir: string, signal?: AbortSignal) => Promise<SendResult>;
  confirmAccount?: (pool: PoolFact) => Promise<boolean>;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  log: (level: string, message: string, provider?: string) => void;
  workDir: string;
  readTimeoutMs?: number;
}

const BACKOFF = [15_000, 30_000, 60_000, 300_000];
const PROVIDERS: ProviderId[] = ["codex", "claude", "antigravity", "grok"];

export class Engine {
  private nextAllowed = new Map<ProviderId, number>();
  private inflight = new Map<ProviderId, Promise<void>>();
  private dueSuppressed = new Map<string, number>();
  private accountSerial = new Map<string, Promise<void>>();
  private reads = new Map<ProviderId, Promise<ProviderSnapshot | ProviderReadError>>();
  private readControllers = new Set<AbortController>();
  private stopped = false;
  private readonly stopController = new AbortController();

  constructor(private readonly deps: EngineDeps) {}

  stop(): void {
    this.stopped = true;
    this.stopController.abort();
    for (const controller of this.readControllers) controller.abort();
  }

  stopSignal(): AbortSignal {
    return this.stopController.signal;
  }

  drain(): Promise<void> {
    return Promise.allSettled([...this.inflight.values(), ...this.accountSerial.values()]).then(() => undefined);
  }

  recover(): void {
    this.deps.store.db.prepare("UPDATE provider_reads SET status = 'interrupted', finished_at = ?, detail = '后台重启，旧读取已中断' WHERE status = 'running'").run(this.deps.now());
    const rows = this.deps.store.recoverInFlight(this.deps.now());
    if (rows.length > 0) this.deps.log("warn", `恢复 ${rows.length} 个中断任务，未启动的才允许有限重试`);
  }

  review(reason: string): Promise<void> {
    return Promise.all(PROVIDERS.map((provider) => this.enqueue(provider, reason))).then(() => undefined);
  }

  enqueue(provider: ProviderId, reason: string): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const current = this.inflight.get(provider);
    if (current) return current;
    const job = this.runProvider(provider, reason).finally(() => {
      if (this.inflight.get(provider) === job) this.inflight.delete(provider);
    });
    this.inflight.set(provider, job);
    return job;
  }

  shouldProbeDue(now = this.deps.now()): boolean {
    const tasks = this.deps.store.activationTasks();
    const windows = this.deps.store.allWindows();
    return windows.some((window) => {
      if (!this.deps.store.activating(window.provider, window.pool_id)) return false;
      const expiredActive = window.activation_mode === "usage_started" && window.state === "active" && window.reset_at != null && window.reset_at + GRACE_MS <= now;
      if (!expiredActive && (window.state !== "idle" || window.due_at == null || window.due_at > now)) return false;
      const key = `${window.provider}:${window.account_id}:${window.pool_id}`;
      if ((this.dueSuppressed.get(key) ?? 0) > now) return false;
      if (tasks.some((task) => {
        if (task.provider !== window.provider || task.account_id !== window.account_id || task.pool_id !== window.pool_id) return false;
        const observed = windows.find((item) => item.provider === task.provider && item.account_id === task.account_id && item.pool_id === task.pool_id && item.window_key === task.window_key);
        return blocksActivation(task, observed ? {
          key: observed.window_key, state: observed.state as WindowFact["state"], activationMode: observed.activation_mode as WindowFact["activationMode"],
          oldEndedAt: observed.old_ended_at, resetAt: observed.reset_at,
        } : undefined, now);
      })) return false;
      return now >= this.retryAt(window.provider as ProviderId);
    });
  }

  private async runProvider(provider: ProviderId, reason: string): Promise<void> {
    if (!this.deps.store.monitoring(provider)) return;
    const now = this.deps.now();
    if (now < this.retryAt(provider)) return;
    const lastRead = Number(this.deps.store.getMeta(`lastReadOk:${provider}`) || "0");
    if ((reason === "refresh" || reason === "startup") && provider === "claude" && lastRead > 0 && now >= lastRead && now - lastRead < providerRefreshMs(provider)) return;
    if (reason === "manual" && provider === "claude" && lastRead > 0 && now - lastRead < 30_000) return;
    if (this.deps.store.paused() && reason !== "startup" && reason !== "manual") {
      this.deps.log("info", `已暂停，跳过发送 (${reason})`, provider);
      return;
    }
    const result = await this.readShared(provider, reason);
    if (this.stopped) return;
    if (isError(result)) {
      this.deps.store.addEvent("error", `${provider} 读取失败：${result.message}`, provider, this.deps.now());
      this.deps.log("error", result.message, provider);
      return;
    }
    this.deps.store.setMeta(`auth:${provider}`, "ok");
    this.observe(result);
  }

  observe(snapshot: ProviderSnapshot): void {
    if (this.stopped) return;
    const now = this.deps.now();
    const previous = this.deps.store.getMeta(`account:${snapshot.provider}`);
    if (previous && previous !== snapshot.accountId) {
      this.deps.store.invalidateAccount(snapshot.provider, previous, now);
      this.deps.store.addEvent("warn", "检测到账号切换，旧任务已失效", snapshot.provider, now);
    }
    this.deps.store.setMeta(`account:${snapshot.provider}`, snapshot.accountId);
    for (const pool of snapshot.pools) {
      const enriched = this.applyPriors(pool);
      const decision = decide(enriched, now);
      enriched.blockReason = enriched.blockReason || (decision.action === "block" ? decision.reason : undefined);
      this.deps.store.savePool(enriched, snapshot.rawSummary);
      this.verifyPool(enriched);
      const blocker = decision.action === "send" ? this.blockingTask(enriched, now) : null;
      const message = blocker
        ? `${pool.poolId} 未领取：任务 ${blocker.id} 仍为 ${blocker.status}，已持续 ${Math.round((now - (blocker.claimed_at || blocker.updated_at)) / 60_000)} 分钟，未发送`
        : `${pool.poolId} ${decision.action === "send" ? "decide" : decision.action}:${decision.reason}`;
      this.deps.store.addEvent("info", message, snapshot.provider, now);
      this.deps.log("info", message, snapshot.provider);
      const key = poolKey(enriched);
      if (decision.action === "wait" && decision.dueAt) this.dueSuppressed.set(key, decision.dueAt);
      else if (decision.action !== "send" || blocker) this.dueSuppressed.set(key, now + 60_000);
      if (decision.action === "send" && !blocker && !this.stopped && !this.deps.store.paused() && this.deps.store.activating(pool.provider, pool.poolId) && snapshot.appCliConsistent === true) {
        void this.dispatch(enriched, decision.windowKeys);
      }
    }
  }

  private applyPriors(pool: PoolFact): PoolFact {
    const now = this.deps.now();
    const windows = pool.windows.map((window) => {
      const prior = this.deps.store.priorWindow(pool.provider, pool.accountId, pool.poolId, window.key);
      if (window.activationMode === "auto_reset" && prior) {
        if (prior.window_id !== window.windowId && prior.reset_at != null && prior.reset_at <= now) {
          return { ...window, oldEndedAt: prior.reset_at, evidence: [...window.evidence, "prior_period_ended"] };
        }
        if (prior.window_id === window.windowId && prior.old_ended_at != null) {
          return { ...window, oldEndedAt: prior.old_ended_at, evidence: [...window.evidence, "preserved_period_boundary"] };
        }
      }
      if (!prior || window.state === "active" || window.oldEndedAt != null) return window;
      if (window.state !== "idle") return window;
      const boundary = prior.preserved_boundary
        ?? (prior.state === "active" && prior.reset_at != null && prior.reset_at <= now ? prior.reset_at : null);
      if (boundary != null && boundary <= now) {
        return { ...window, oldEndedAt: boundary, evidence: [...window.evidence, "preserved_old_boundary"] };
      }
      return window;
    });
    return { ...pool, windows };
  }

  private async dispatch(pool: PoolFact, keys: string[]): Promise<void> {
    const serialKey = `${pool.provider}:${pool.accountId}`;
    const previous = this.accountSerial.get(serialKey) || Promise.resolve();
    const run = previous.then(() => this.sendOnce(pool, keys));
    this.accountSerial.set(serialKey, run.catch(() => undefined));
    await run;
  }

  private async sendOnce(pool: PoolFact, keys: string[]): Promise<void> {
    if (this.stopped || this.deps.store.paused() || !this.deps.store.activating(pool.provider, pool.poolId)) return;
    if (pool.blockReason && pool.blockReason !== "idle_due") {
      this.deps.store.addEvent("warn", `${pool.poolId} 不发送：${pool.blockReason}`, pool.provider);
      return;
    }
    const targets = pool.windows.filter((window) => keys.includes(window.key));
    const claimed = this.deps.store.claim(pool, targets, this.deps.now());
    if (claimed.length === 0) return;
    const ids = claimed.map((row) => row.id);
    if (this.haltUnsent(ids)) return;
    const generation = this.deps.store.poolGeneration(pool.provider, pool.accountId, pool.poolId);
    const cancel = (status: TaskRow["status"], category: string, detail: string, retryAfterMs = 0) => {
      this.deps.store.updateTasks(ids, {
        status,
        error_category: category,
        detail,
        message_result: "not_sent",
        retry_after: retryAfterMs > 0 ? this.deps.now() + retryAfterMs : null,
      }, this.deps.now());
      this.deps.store.setPhase(ids, "claimed", this.deps.now());
    };
    if (this.stale(pool, keys, generation)) {
      cancel("deferred", "stale_authorization", "领取后已有更新的本地观测，请求未发出", 1_000);
      return;
    }
    if (!(await this.stillSafe(pool, ids))) return;
    if (this.haltUnsent(ids) || this.abandoned(ids)) return;
    if (this.stale(pool, keys, generation)) {
      cancel("deferred", "stale_authorization", "确认期间窗口、账号或费用状态已变化，请求未发出", 1_000);
      return;
    }
    if (!(await this.waitForSample(pool, keys, ids))) return;
    if (!(await this.stillSafe(pool, ids))) return;
    if (this.haltUnsent(ids) || this.abandoned(ids)) return;
    if (this.stale(pool, keys, generation)) {
      cancel("deferred", "stale_authorization", "采样等待期间窗口、账号或费用状态已变化，请求未发出", 1_000);
      return;
    }
    const fresh = await this.readShared(pool.provider);
    if (!fresh || isError(fresh)) {
      cancel("deferred", fresh && isError(fresh) ? fresh.category === "rate_limited" ? "rate_limited" : "refresh_failed" : "refresh_failed", "发送前复核失败，请求未发出", fresh && isError(fresh) ? fresh.retryAfterMs ?? 30_000 : 30_000);
      return;
    }
    if (fresh.accountId !== pool.accountId || fresh.appCliConsistent !== true) {
      cancel("blocked", "account_mismatch", "发送前账号或认证上下文已变化");
      return;
    }
    const freshPool = fresh.pools.find((item) => item.poolId === pool.poolId);
    if (!freshPool) {
      cancel("skipped", "pool_missing", "发送前已看不到目标池");
      return;
    }
    const judged = this.applyPriors(freshPool);
    const decision = decide(judged, this.deps.now());
    const block = freshPool.blockReason || (!freshPool.selectedModel ? "model_unknown" : "");
    if (decision.action !== "send" || freshPool.billingSafety !== "subscription_only" || block) {
      if (hasShortSample(judged, keys) && !block && freshPool.billingSafety === "subscription_only") {
        this.deferShortSample(pool, keys, ids, claimed);
        return;
      }
      if (!block && freshPool.billingSafety === "subscription_only") this.deps.store.savePool(judged, fresh.rawSummary);
      const category = block || decision.reason || "stale_snapshot";
      const temporary = isTemporaryUnsent(category);
      cancel(temporary ? "deferred" : "skipped", category, "最终复核不再允许发送，请求未发出", temporary ? 60_000 : 0);
      return;
    }
    if (!(await this.stillSafe(freshPool, ids))) return;
    if (this.haltUnsent(ids) || this.abandoned(ids)) return;
    if (this.stale(pool, keys, generation)) {
      cancel("deferred", "stale_authorization", "第二次核对期间已观察到新事实，旧授权作废", 1_000);
      return;
    }
    const work = path.join(this.deps.workDir, `${pool.provider}-${pool.poolId}-${this.deps.now()}`);
    fs.mkdirSync(work, { recursive: true });
    if (this.haltUnsent(ids)) return;
    this.deps.store.setPhase(ids, "spawning", this.deps.now());
    const sendStartedAt = this.deps.now();
    let result: SendResult;
    try {
      result = await this.deps.send(freshPool, work, this.stopController.signal);
    } catch (error) {
      result = { outcome: "unknown", sessionId: null, detail: error instanceof Error ? error.message : String(error), started: true };
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
    const at = this.deps.now();
    if (result.outcome === "not_sent" && result.started !== true) {
      if (result.errorCategory) {
        this.noteFailure(pool.provider, { provider: pool.provider, category: result.errorCategory, message: result.detail, retryAfterMs: result.retryAfterMs ?? null });
        const readId = this.deps.store.startRead(pool.provider, "verification", sendStartedAt);
        this.deps.store.finishRead(readId, result.errorCategory, redactText(result.detail), at);
      }
      cancel("deferred", this.stopped ? "shutdown" : result.errorCategory === "rate_limited" ? "rate_limited" : result.errorCategory ? "refresh_failed" : "model_unavailable", result.detail || "请求未发出", this.stopped ? 0 : Math.max(60_000, this.retryAt(pool.provider) - at));
      return;
    }
    this.deps.store.setPhase(ids, "spawned", at);
    if (result.outcome !== "accepted") {
      this.deps.store.updateTasks(ids, { status: "unknown_result", message_result: "unknown", session_id: result.sessionId, detail: result.detail, error_category: "unknown_result" }, at);
      return;
    }
    const target = freshPool.windows.find((item) => keys.includes(item.key));
    const evidence = `${result.detail}；模型=${freshPool.selectedModel || "-"}；发送时刻=${at}；旧边界=${target?.oldEndedAt ?? "-"}；当时reset=${target?.resetAt ?? "-"}`;
    this.deps.store.updateTasks(ids, { status: "verifying", message_result: "accepted", session_id: result.sessionId, detail: evidence }, at);
    this.deps.store.addEvent("info", `${pool.poolId} 消息已接受，等待窗口验证`, pool.provider, at);
  }

  private async stillSafe(pool: PoolFact, ids: number[]): Promise<boolean> {
    if (!this.deps.store.activating(pool.provider, pool.poolId)) {
      this.defer(ids, "paused", "该渠道自动读取或该额度池自动激活已关闭");
      return false;
    }
    if (this.deps.store.paused()) {
      this.defer(ids, "paused", "发送前已暂停");
      return false;
    }
    if (this.deps.confirmAccount && !await this.deps.confirmAccount(pool)) {
      this.deps.store.updateTasks(ids, { status: "blocked", error_category: "account_mismatch", detail: "发送前账号与快照不一致", message_result: "not_sent" }, this.deps.now());
      this.deps.store.setPhase(ids, "claimed", this.deps.now());
      return false;
    }
    if (this.deps.store.paused()) {
      this.defer(ids, "paused", "账号核对期间已暂停");
      return false;
    }
    return true;
  }

  private async waitForSample(pool: PoolFact, keys: string[], ids: number[]): Promise<boolean> {
    const rows = this.deps.store.windowsFor(pool.provider, pool.accountId, pool.poolId)
      .filter((row) => keys.includes(row.window_key)
        && row.activation_mode === "usage_started"
        && row.reset_at != null
        && /sampled_reset_slides_with_wall_clock|resampled_reset_still_slides/.test(row.evidence));
    if (rows.length === 0) return true;
    const latest = Math.max(...rows.map((row) => row.updated_at));
    const deficit = SAMPLE_MIN_MS - (this.deps.now() - latest);
    if (deficit <= 0) return true;
    try {
      await this.sleepFor(Math.min(deficit, SAMPLE_MIN_MS));
    } catch {
      if (this.haltUnsent(ids)) return false;
      if (this.deps.store.paused()) {
        this.defer(ids, "paused", "采样等待期间已暂停");
        return false;
      }
      this.defer(ids, "sample_pending", "采样等待被打断，请求未发出");
      return false;
    }
    if (this.haltUnsent(ids)) return false;
    if (this.deps.store.paused()) {
      this.defer(ids, "paused", "采样等待期间已暂停");
      return false;
    }
    return !this.abandoned(ids);
  }

  private async sleepFor(ms: number): Promise<void> {
    const sleep = this.deps.sleep ?? defaultSleep;
    let left = ms;
    while (left > 0) {
      if (this.stopped) throw new Error("stopped");
      if (this.deps.store.paused()) throw new Error("paused");
      const before = this.deps.now();
      const slice = Math.min(250, left);
      await sleep(slice, this.stopController.signal);
      if (this.stopped) throw new Error("stopped");
      if (this.deps.store.paused()) throw new Error("paused");
      const advanced = this.deps.now() - before;
      left -= advanced > 0 ? advanced : slice;
    }
  }

  private deferShortSample(pool: PoolFact, keys: string[], ids: number[], claimed: TaskRow[]): void {
    const attempts = Math.max(...claimed.map((row) => row.attempt_count));
    if (attempts >= 3) {
      this.deps.store.updateTasks(ids, {
        status: "blocked",
        error_category: "sample_pending",
        detail: "采样间隔不足，有限重试已用尽",
        message_result: "not_sent",
      }, this.deps.now());
      this.deps.store.setPhase(ids, "claimed", this.deps.now());
      return;
    }
    const rows = this.deps.store.windowsFor(pool.provider, pool.accountId, pool.poolId)
      .filter((row) => keys.includes(row.window_key));
    const latest = rows.length === 0 ? this.deps.now() : Math.max(...rows.map((row) => row.updated_at));
    const remain = Math.max(1_000, SAMPLE_MIN_MS - (this.deps.now() - latest));
    this.deps.store.updateTasks(ids, {
      status: "deferred",
      error_category: "sample_pending",
      detail: "采样间隔不足，稍后复核",
      message_result: "not_sent",
      retry_after: this.deps.now() + remain,
    }, this.deps.now());
    this.deps.store.setPhase(ids, "claimed", this.deps.now());
  }

  private defer(ids: number[], category: string, detail: string): void {
    this.deps.store.updateTasks(ids, {
      status: "deferred",
      error_category: category,
      detail,
      message_result: "not_sent",
      retry_after: this.deps.now(),
    }, this.deps.now());
    this.deps.store.setPhase(ids, "claimed", this.deps.now());
  }

  private haltUnsent(ids: number[]): boolean {
    if (!this.stopped) {
      const disabled = this.deps.store.tasksByStatus(["in_flight"]).some((task) => ids.includes(task.id) && !this.deps.store.activating(task.provider, task.pool_id));
      if (disabled) {
        this.defer(ids, "paused", "发送前用户已关闭该渠道或额度池");
        return true;
      }
    }
    if (!this.stopped) return false;
    this.deps.store.updateTasks(ids, {
      status: "deferred",
      error_category: "shutdown",
      detail: "退出中，请求未发出",
      message_result: "not_sent",
    }, this.deps.now());
    this.deps.store.setPhase(ids, "claimed", this.deps.now());
    return true;
  }

  private abandoned(ids: number[]): boolean {
    const live = new Set(this.deps.store.tasksByStatus(["in_flight"]).map((row) => row.id));
    return ids.some((id) => !live.has(id));
  }

  private stale(pool: PoolFact, keys: string[], generation: number): boolean {
    if (this.deps.store.getMeta(`account:${pool.provider}`) !== pool.accountId) return true;
    if (this.deps.store.poolGeneration(pool.provider, pool.accountId, pool.poolId) !== generation) return true;
    const windows = this.deps.store.windowsFor(pool.provider, pool.accountId, pool.poolId);
    return keys.some((key) => {
      const window = windows.find((item) => item.window_key === key);
      if (!window) return true;
      if (window.activation_mode === "auto_reset") return window.old_ended_at == null;
      return window.state !== "idle";
    });
  }

  private readShared(provider: ProviderId, reason = "verification"): Promise<ProviderSnapshot | ProviderReadError> {
    const now = this.deps.now();
    const allowedAt = this.retryAt(provider);
    if (now < allowedAt) {
      return Promise.resolve({
        provider,
        category: "rate_limited",
        message: "仍在退避窗口内",
        retryAfterMs: allowedAt - now,
      });
    }
    const existing = this.reads.get(provider);
    if (existing) return existing;
    const controller = new AbortController();
    const readId = this.deps.store.startRead(provider, reason, now);
    this.readControllers.add(controller);
    if (this.stopped) controller.abort();
    const timeoutMs = this.deps.readTimeoutMs ?? 25_000;
    let timer: NodeJS.Timeout;
    const job = new Promise<ProviderSnapshot | ProviderReadError>((resolve) => {
      let settled = false;
      const finish = (value: ProviderSnapshot | ProviderReadError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (isError(value)) this.noteFailure(provider, value);
        else {
          this.nextAllowed.set(provider, 0);
          this.deps.store.setMeta(`readRetryAt:${provider}`, "0");
          this.deps.store.setMeta(`fail:${provider}`, "0");
          this.deps.store.setMeta(`lastReadOk:${provider}`, String(now));
        }
        this.deps.store.finishRead(readId, isError(value) ? value.category : "ok", isError(value) ? redactText(value.message) : `读取成功，${value.pools.length} 个额度池`, this.deps.now());
        resolve(value);
      };
      timer = setTimeout(() => {
        controller.abort();
        finish({
          provider,
          category: "unavailable",
          message: "读取超时，已取消底层请求",
          retryAfterMs: 15_000,
        });
      }, timeoutMs);
      void this.deps.read(provider, controller.signal).then(finish, (error) => finish({
        provider,
        category: "unavailable",
        message: error instanceof Error ? error.message : String(error),
        retryAfterMs: 30_000,
      }));
    }).finally(() => {
      clearTimeout(timer);
      this.readControllers.delete(controller);
      if (this.reads.get(provider) === job) this.reads.delete(provider);
    });
    this.reads.set(provider, job);
    return job;
  }

  private blockingTask(pool: PoolFact, now: number): TaskRow | null {
    const rows = this.deps.store.activationTasks()
      .filter((row) => row.provider === pool.provider && row.account_id === pool.accountId && row.pool_id === pool.poolId);
    for (const row of rows) {
      const window = pool.windows.find((item) => item.key === row.window_key);
      if (blocksActivation(row, window, now)) return row;
    }
    return null;
  }

  private verifyPool(pool: PoolFact): void {
    const now = this.deps.now();
    const pending = this.deps.store.activationTasks()
      .filter((row) => row.provider === pool.provider && row.account_id === pool.accountId && row.pool_id === pool.poolId && row.status !== "in_flight" && row.status !== "skipped");
    for (const task of pending) {
      const window = pool.windows.find((item) => item.key === task.window_key);
      if (!window) continue;
      if (confirmsTask(task, window, now)) {
        const startedAt = (window.resetAt ?? now) - windowDurationMs(task.window_key);
        this.deps.store.updateTasks([task.id], { status: "confirmed", window_result: "active", detail: `目标窗口在发送后启动，sent=${task.claimed_at ?? task.updated_at}，started=${startedAt}，reset=${window.resetAt}` }, now);
        continue;
      }
      if (laterPeriodProven(task, window, now)) {
        this.deps.store.updateTasks([task.id], {
          status: "skipped",
          error_category: "period_unconfirmed",
          window_result: "unconfirmed",
          detail: window.state === "active"
            ? "已观测到后续活跃窗口，无法归因于旧请求；旧任务已收尾，不重发，后续新周期仍需证据确认。"
            : "旧周期已结束但未确认由该请求启动；旧任务已收尾，不重发，新周期可另行处理。",
        }, now);
        continue;
      }
      const age = now - (task.claimed_at || task.updated_at);
      if (task.status !== "stalled" && age >= VERIFY_STALL_MS) {
        const accepted = task.message_result === "accepted";
        this.deps.store.updateTasks([task.id], {
          status: "stalled",
          error_category: "verify_unresolved",
          detail: accepted
            ? "已接受但超过30分钟仍未确认窗口启动；保留防重发保护，继续核验，观测到后续窗口或周期结束证据后自动收尾。"
            : "发送结果未知且超过30分钟仍未确认；保留防重发保护，继续核验，观测到后续窗口或周期结束证据后自动收尾。",
          retry_after: now + 60_000,
        }, now);
      }
    }
  }

  private noteFailure(provider: ProviderId, error: ProviderReadError): void {
    const current = this.nextAllowed.get(provider) ?? 0;
    const count = Number(this.deps.store.getMeta(`fail:${provider}`) || "0") + 1;
    this.deps.store.setMeta(`fail:${provider}`, String(count));
    const fallback = error.category === "rate_limited" ? Math.min(1800_000, 300_000 * 2 ** Math.min(count - 1, 3)) : error.category === "unauthorized" ? 300_000 : BACKOFF[Math.min(count - 1, BACKOFF.length - 1)];
    const delay = error.category === "rate_limited" ? Math.max(error.retryAfterMs ?? 0, fallback) : error.retryAfterMs ?? fallback;
    const retryAt = Math.max(current, this.deps.now() + delay);
    this.nextAllowed.set(provider, retryAt);
    this.deps.store.setMeta(`readRetryAt:${provider}`, String(retryAt));
    if (error.category === "unauthorized") this.deps.store.setMeta(`auth:${provider}`, "unauthorized");
  }

  private retryAt(provider: ProviderId): number {
    return Math.max(this.nextAllowed.get(provider) ?? 0, Number(this.deps.store.getMeta(`readRetryAt:${provider}`) || "0"));
  }
}

function poolKey(pool: PoolFact): string {
  return `${pool.provider}:${pool.accountId}:${pool.poolId}`;
}

function hasShortSample(pool: PoolFact, keys: string[]): boolean {
  return pool.windows.some((window) => keys.includes(window.key) && window.evidence.includes("sample_interval_too_short"));
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function isTemporaryUnsent(category: string): boolean {
  return category === "model_unknown" || category === "model_unavailable" || /暂|unavailable|timeout/i.test(category);
}

function isError(value: ProviderSnapshot | ProviderReadError): value is ProviderReadError {
  return "category" in value;
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    work.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

export function emptyWork(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export { SHORT_PROMPT };
