import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { decide } from "../src/decision.js";
import { createProviderRead } from "../src/runtime.js";
import { Engine } from "../src/engine.js";
import { Store } from "../src/store.js";
import { GRACE_MS, type SendRequest } from "../src/types.js";
import { buildClaudeArgs, mapClaudeUsage, readClaude, sendClaude } from "../src/providers/claude.js";
import { claudeEnvironment, loadClaudeOAuth, saveClaudeOAuth } from "../src/providers/claude-auth.js";

const NOW = Date.now();
const PROFILE = { account: { uuid: "official-account", email: "test@example.com" }, organization: { organization_type: "claude_pro", has_extra_usage_enabled: false } };
const USAGE = { five_hour: { utilization: 0, resets_at: null }, seven_day: { utilization: 1, resets_at: new Date(NOW + 7 * 86400_000).toISOString() }, extra_usage: { is_enabled: false } };

function fixture(t: { after: (fn: () => void) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aiquota5h-claude-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  saveClaudeOAuth(dir, { accessToken: "fake-test-access", refreshToken: "fake-test-refresh", expiresAt: Date.now() + 3600_000, scopes: ["user:profile", "user:inference"], subscriptionType: "pro" });
  const request: SendRequest = { provider: "claude", accountId: "official-account", poolId: "claude-subscription", model: "sonnet", workDir: dir, prompt: "OK" };
  return { dir, request };
}

function fakeFetch(profile: unknown = PROFILE, usage: unknown = USAGE): typeof fetch {
  return (async (url: string | URL | Request) => new Response(JSON.stringify(String(url).endsWith("/profile") ? profile : usage), { status: 200 })) as typeof fetch;
}

test("Claude 沿用同账号同池已启动的旧边界，满 65 秒才激活，账号切换不借用边界", () => {
  const oldEnd = NOW - GRACE_MS;
  const prior = { accountId: "official-account", poolId: "claude-subscription", key: "5h", state: "active" as const, resetAt: oldEnd, preservedBoundary: null, windowId: "old", observedAt: oldEnd - 60_000 };
  const pool = mapClaudeUsage(USAGE, "official-account", "test", NOW, [prior]).pools[0];
  pool.billingSafety = "subscription_only";
  assert.equal(pool.windows[0].state, "idle");
  assert.equal(pool.windows[0].oldEndedAt, oldEnd);
  assert.equal(decide(pool, NOW - 1).action, "wait");
  assert.equal(decide(pool, NOW).action, "send");
  const changed = mapClaudeUsage(USAGE, "another-account", "test", NOW, [prior]).pools[0];
  assert.equal(changed.windows[0].state, "unknown");
  assert.equal(decide(changed, NOW).action, "block");
  const unproven = mapClaudeUsage(USAGE, "official-account", "test", NOW, [{ ...prior, state: "unknown" }]).pools[0];
  assert.equal(unproven.windows[0].state, "unknown");
  assert.equal(unproven.windows[0].oldEndedAt, null);
});

test("Claude 周额度固定恢复不额外发消息，周额度耗尽时也不发", () => {
  const pool = mapClaudeUsage({ ...USAGE, five_hour: { utilization: 2, resets_at: new Date(NOW + 3600_000).toISOString() } }, "official-account", "test", NOW).pools[0];
  pool.billingSafety = "subscription_only";
  pool.windows[1].oldEndedAt = NOW - 120_000;
  assert.equal(pool.windows[1].activationMode, "auto_reset");
  assert.equal(pool.windows[1].sharesRequest, false);
  assert.equal(decide(pool, NOW).action, "skip");
  pool.windows[0] = { ...pool.windows[0], state: "idle", oldEndedAt: NOW - 120_000 };
  pool.windows[1].allowance = "exhausted";
  assert.equal(decide(pool, NOW).reason, "allowance_exhausted");
});

test("生产读取工厂将 Claude 历史边界传给适配器", async () => {
  const priors = [{ accountId: "official-account", poolId: "claude-subscription", key: "5h", resetAt: NOW - 100_000, preservedBoundary: null, windowId: "old" }];
  let actual: unknown;
  const read = createProviderRead({ priorsFor: (provider) => { assert.equal(provider, "claude"); return priors; }, readClaude: async (options) => { actual = options?.priors; return mapClaudeUsage(USAGE, "official-account", "test", NOW); } });
  await read("claude");
  assert.deepEqual(actual, priors);
});

test("独立订阅读取核对官方套餐与额外付费，不泄漏令牌", async (t) => {
  const { dir } = fixture(t);
  for (const [profile, usage, expected] of [
    [PROFILE, USAGE, "subscription_only"],
    [{ ...PROFILE, organization: { organization_type: "claude_max" } }, { ...USAGE, extra_usage: undefined }, "billing_safety_unknown"],
    [PROFILE, { ...USAGE, extra_usage: { is_enabled: true } }, "blocked"],
    [{ ...PROFILE, organization: { organization_type: "api", has_extra_usage_enabled: false } }, USAGE, "blocked"],
  ] as const) {
    const result = await readClaude({ configDir: dir, fetcher: fakeFetch(profile, usage) });
    assert.ok("pools" in result);
    assert.equal(result.pools[0].billingSafety, expected);
    assert.equal(JSON.stringify(result).includes("fake-test-access"), false);
  }
  const missing = await readClaude({ configDir: dir, fetcher: fakeFetch(PROFILE, { five_hour: USAGE.five_hour }) });
  assert.ok("pools" in missing); assert.match(missing.pools[0].blockReason!, /周额度/);
  const limited = await readClaude({ configDir: dir, fetcher: (async () => new Response("", { status: 429 })) as typeof fetch });
  assert.ok("category" in limited); assert.equal(limited.category, "rate_limited");
  const delayed = await readClaude({ configDir: dir, fetcher: (async () => new Response("", { status: 429, headers: { "retry-after": "900" } })) as typeof fetch });
  assert.ok("category" in delayed); assert.equal(delayed.retryAfterMs, 900_000);
  const unavailable = await readClaude({ configDir: dir, fetcher: (async () => new Response("", { status: 503 })) as typeof fetch });
  assert.ok("category" in unavailable); assert.equal(unavailable.category, "unavailable");
});

test("Claude 独立会话剔除原有代理、API Key、SDK 和模型覆盖，隔离所有工具", () => {
  const env = claudeEnvironment("/isolated", "official-token", { HOME: "/user", PATH: "/bin", ANTHROPIC_API_KEY: "secret", ANTHROPIC_BASE_URL: "https://proxy.invalid", CLAUDE_CONFIG_DIR: "/original", CLAUDE_CODE_OAUTH_TOKEN: "wrong-token", CLAUDE_CODE_USE_BEDROCK: "1", NODE_OPTIONS: "--require=unsafe", CLAUDE_CODE_SDK_MCP_SERVERS: "unsafe" });
  assert.deepEqual(Object.keys(env).sort(), ["HOME", "PATH", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "NO_COLOR", "CLAUDE_CODE_OAUTH_TOKEN"].sort());
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "official-token");
  const args = buildClaudeArgs({ model: "sonnet", prompt: "OK" } as SendRequest);
  assert.equal(args[args.indexOf("--tools") + 1], "");
  assert.equal(args[args.indexOf("--setting-sources") + 1], "");
  assert.deepEqual(JSON.parse(args[args.indexOf("--mcp-config") + 1]), { mcpServers: {} });
  assert.equal(JSON.parse(args[args.indexOf("--settings") + 1]).disableAllHooks, true);
  assert.equal(args.includes("--dangerously-skip-permissions"), false);
});

test("到期凭证单次续期并原子保存旋转令牌，失败不覆盖原凭证", async (t) => {
  const { dir } = fixture(t);
  saveClaudeOAuth(dir, { accessToken: "old", refreshToken: "refresh-old", expiresAt: Date.now() - 1, scopes: ["user:profile", "user:inference"] });
  let refreshes = 0;
  const fetcher = (async (url: string, options: RequestInit) => {
    refreshes++;
    assert.equal(url, "https://platform.claude.com/v1/oauth/token");
    assert.equal(JSON.parse(String(options.body)).refresh_token, "refresh-old");
    assert.equal(JSON.parse(String(options.body)).scope, "user:profile user:inference");
    return new Response(JSON.stringify({ access_token: "new", refresh_token: "refresh-new", expires_in: 3600 }), { status: 200 });
  }) as typeof fetch;
  const [a, b] = await Promise.all([loadClaudeOAuth(dir, undefined, fetcher), loadClaudeOAuth(dir, undefined, fetcher)]);
  assert.equal(refreshes, 1); assert.equal(a.accessToken, "new"); assert.equal(b.refreshToken, "refresh-new");
  const file = path.join(dir, ".credentials.json");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  saveClaudeOAuth(dir, { ...a, expiresAt: Date.now() - 1 });
  const previous = fs.readFileSync(file, "utf8");
  await assert.rejects(loadClaudeOAuth(dir, undefined, (async () => new Response("", { status: 401 })) as typeof fetch), /续期失败/);
  assert.equal(fs.readFileSync(file, "utf8"), previous);
});

test("Claude 发送结果只认已完成回合；空输出和错误结果都不重发", async (t) => {
  const { dir, request } = fixture(t);
  const marker = path.join(dir, "invocations");
  const script = path.join(dir, "fake-claude");
  const help = buildClaudeArgs(request).filter((s) => s.startsWith("--")).join(" ");
  for (const [output, outcome] of [
    [{ type: "result", subtype: "success", is_error: false, session_id: "test-session" }, "accepted"],
    [{ type: "result", subtype: "error_max_turns", is_error: true }, "unknown"],
    [null, "unknown"],
  ] as const) {
    fs.writeFileSync(script, `#!${process.execPath}\nconst fs=require('node:fs'); if(process.argv.includes('--help')){console.log(${JSON.stringify(help)});process.exit(0)};fs.appendFileSync(${JSON.stringify(marker)},'1');${output ? `console.log(${JSON.stringify(JSON.stringify(output))})` : ""}\n`);
    fs.chmodSync(script, 0o755);
    const result = await sendClaude(request, script, undefined, { configDir: dir, fetcher: fakeFetch() });
    assert.equal(result.outcome, outcome); assert.equal(result.started, true);
    assert.equal(result.acceptance, outcome === "accepted" ? "turn_completed" : "none");
  }
  assert.equal(fs.readFileSync(marker, "utf8"), "111");
  const wrong = await sendClaude({ ...request, accountId: "wrong-account" }, script, undefined, { configDir: dir, fetcher: fakeFetch() });
  assert.equal(wrong.started, false);
  const active = await sendClaude(request, script, undefined, { configDir: dir, fetcher: fakeFetch(PROFILE, { ...USAGE, five_hour: { utilization: 1, resets_at: new Date(Date.now() + 3600_000).toISOString() } }) });
  assert.equal(active.started, false);
  const paid = await sendClaude(request, script, undefined, { configDir: dir, fetcher: fakeFetch(PROFILE, { ...USAGE, extra_usage: { is_enabled: true } }) });
  assert.equal(paid.started, false);
  const aborted = new AbortController(); aborted.abort();
  const cancelled = await sendClaude(request, script, aborted.signal, { configDir: dir, fetcher: fakeFetch() });
  assert.equal(cancelled.started, false);
  assert.equal(fs.readFileSync(marker, "utf8"), "111");
});

test("Claude 隔离参数缺失时不能开始实际调用", async (t) => {
  const { dir, request } = fixture(t);
  const script = path.join(dir, "old-claude");
  const marker = path.join(dir, "sent");
  fs.writeFileSync(script, `#!${process.execPath}\nif(process.argv.includes('--help'))process.exit(0);require('node:fs').writeFileSync(${JSON.stringify(marker)},'sent');\n`);
  fs.chmodSync(script, 0o755);
  const result = await sendClaude(request, script, undefined, { configDir: dir, fetcher: fakeFetch() });
  assert.equal(result.started, false); assert.equal(fs.existsSync(marker), false);
});

test("Claude 贯穿调度器后每个旧边界最多发送一次，结果未知与重启都不补发", async (t) => {
  const { dir } = fixture(t);
  const store = new Store(path.join(dir, "state.sqlite"));
  t.after(() => store.close());
  let now = NOW, sends = 0;
  const oldEnd = NOW + 10_000;
  const active = mapClaudeUsage({ ...USAGE, five_hour: { utilization: 10, resets_at: new Date(oldEnd).toISOString() } }, "official-account", "test", now);
  const read = () => {
    const snapshot = mapClaudeUsage(USAGE, "official-account", "test", now, store.windowPriors("claude"));
    snapshot.pools[0].billingSafety = "subscription_only";
    return snapshot;
  };
  const deps = { store, now: () => now, read: async () => read(), log: () => {}, workDir: dir,
    confirmAccount: async () => true, send: async () => { sends++; return { outcome: "unknown" as const, started: true, sessionId: null, detail: "test unknown" }; } };
  let engine = new Engine(deps);
  engine.observe(active);
  now = oldEnd + GRACE_MS;
  engine.observe(read()); await engine.drain();
  assert.equal(sends, 1);
  engine.observe(read()); await engine.drain();
  engine.stop(); engine = new Engine(deps); engine.recover();
  engine.observe(read()); await engine.drain(); engine.stop();
  assert.equal(sends, 1);
});

test("Claude 日常轮询降频，窗口到期仍独立触发复核", async (t) => {
  const { dir } = fixture(t);
  const store = new Store(path.join(dir, "state.sqlite")); t.after(() => store.close());
  let now = NOW, reads = 0;
  const reset = now + 150_000;
  const engine = new Engine({ store, now: () => now, workDir: dir, log: () => {},
    read: async () => { reads++; now += 200; return mapClaudeUsage({ ...USAGE, five_hour: { utilization: 10, resets_at: new Date(reset).toISOString() } }, "official-account", "test", now); },
    send: async () => { throw Error("must not send"); } });
  await engine.enqueue("claude", "startup"); assert.equal(reads, 1);
  now = NOW + 60_000; await engine.enqueue("claude", "refresh"); assert.equal(reads, 1);
  now = NOW + 120_000; await engine.enqueue("claude", "refresh"); assert.equal(reads, 2);
  now = reset + GRACE_MS - 1; assert.equal(engine.shouldProbeDue(), false);
  now++; assert.equal(engine.shouldProbeDue(), true);
  await engine.enqueue("claude", "due"); assert.equal(reads, 3);
  engine.stop();
});

test("Claude 限流退避跨后台重启保留，成功恢复后清零", async (t) => {
  const { dir } = fixture(t);
  const store = new Store(path.join(dir, "state.sqlite")); t.after(() => store.close());
  let now = NOW, reads = 0, fail = true;
  const deps = { store, now: () => now, workDir: dir, log: () => {}, read: async () => {
    reads++;
    return fail ? { provider: "claude" as const, category: "rate_limited" as const, message: "429", retryAfterMs: 900_000 }
      : mapClaudeUsage({ ...USAGE, five_hour: { utilization: 10, resets_at: new Date(now + 3600_000).toISOString() } }, "official-account", "test", now);
  }, send: async () => { throw Error("must not send"); } };
  let engine = new Engine(deps);
  await engine.enqueue("claude", "startup"); assert.equal(reads, 1);
  assert.equal(Number(store.getMeta("readRetryAt:claude")), now + 900_000);
  engine.stop(); engine = new Engine(deps); engine.recover();
  now += 300_000;
  await engine.enqueue("claude", "startup"); await engine.enqueue("claude", "manual"); assert.equal(reads, 1);
  now += 600_000; fail = false;
  await engine.enqueue("claude", "refresh"); assert.equal(reads, 2);
  assert.equal(store.getMeta("readRetryAt:claude"), "0"); assert.equal(store.getMeta("fail:claude"), "0");
  engine.stop();
});

test("Claude 发送前额度核对限流会暂缓，不误判账号变更或消耗模型重试次数", async (t) => {
  const { dir, request } = fixture(t);
  const limited = await sendClaude(request, "/not-invoked", undefined, { configDir: dir, fetcher: (async () => new Response("", { status: 429, headers: { "retry-after": "600" } })) as typeof fetch });
  assert.equal(limited.started, false); assert.equal(limited.errorCategory, "rate_limited"); assert.equal(limited.retryAfterMs, 600_000);
  const store = new Store(path.join(dir, "state.sqlite")); t.after(() => store.close());
  const prior = { accountId: "official-account", poolId: "claude-subscription", key: "5h", state: "active" as const, resetAt: NOW - GRACE_MS, preservedBoundary: null, windowId: "old", observedAt: NOW - GRACE_MS - 60_000 };
  const snap = mapClaudeUsage(USAGE, "official-account", "test", NOW, [prior]); snap.pools[0].billingSafety = "subscription_only";
  const engine = new Engine({ store, now: () => NOW, workDir: dir, log: () => {}, read: async () => snap, confirmAccount: async () => true, send: async () => limited });
  engine.observe(snap); await engine.drain();
  const task = store.recentTasks()[0];
  assert.equal(task.status, "deferred"); assert.equal(task.error_category, "rate_limited"); assert.equal(task.message_result, "not_sent");
  assert.equal(task.retry_after, NOW + 600_000);
  assert.equal(store.db.prepare("SELECT status FROM provider_reads ORDER BY id DESC LIMIT 1").get()?.status, "rate_limited");
  engine.stop();
});
