import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "./config.js";
import { Engine } from "./engine.js";
import { InstanceLock } from "./lock.js";
import { createProviderRead } from "./runtime.js";
import { LAUNCH_LABEL, launchAgentPath, logDir, runtimePaths, supportDir } from "./paths.js";
import { beginShutdown, killOwned } from "./proc.js";
import { confirmAgyAccount, sendAntigravity } from "./providers/antigravity.js";
import { readCodexAccountId, sendCodex } from "./providers/codex.js";
import { readGrokIdentity, sendGrok } from "./providers/grok.js";
import { maskEmail, maskId, redactText } from "./redact.js";
import { Store } from "./store.js";
import type { PoolFact, SendResult, WindowFact } from "./types.js";
import { blocksActivation } from "./verify.js";
import { dashboard, readHistory, taskHistory } from "./dashboard.js";
import { requestRefresh, updateControl } from "./controls.js";

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const command = argv[0] || "status";
  if (command === "daemon") return daemon();
  if (["dashboard", "history", "reads", "control", "refresh"].includes(command)) {
    const paths = runtimePaths();
    const store = new Store(paths.db);
    try {
      if (command === "control") { updateControl(store, argv.slice(1)); console.log('{"ok":true}'); }
      else if (command === "refresh") {
        if (!await new InstanceLock(paths.lock).ping()) throw new Error("后台未运行，无法刷新。请先启动后台服务。");
        requestRefresh(store); console.log('{"ok":true}');
      }
      else if (command === "dashboard") console.log(JSON.stringify(dashboard(store, await new InstanceLock(paths.lock).ping())));
      else {
        const offset = Number(argv[1] || 0);
        if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("历史记录偏移量无效");
        console.log(JSON.stringify(command === "reads" ? readHistory(store, offset) : taskHistory(store, offset)));
      }
    } finally { store.close(); }
    return 0;
  }
  if (command === "status") return await status();
  if (command === "doctor") return doctor();
  if (command === "pause") return setPaused(true);
  if (command === "resume") return setPaused(false);
  if (command === "install") return install();
  if (command === "uninstall") return uninstall(argv.includes("--purge-data"));
  console.log("用法: aiquota5h <daemon|status|dashboard|history|reads|refresh|control|doctor|pause|resume|install|uninstall>");
  return 2;
}

async function daemon(): Promise<number> {
  const paths = runtimePaths();
  fs.mkdirSync(paths.home, { recursive: true });
  fs.mkdirSync(paths.work, { recursive: true });
  fs.mkdirSync(logDir(), { recursive: true });
  const lock = new InstanceLock(paths.lock);
  if (await lock.acquire() === "busy") {
    console.log("已有 AIQuota5h 实例在运行");
    return 0;
  }
  const store = new Store(paths.db);
  const log = createLogger(logDir());
  const engine = new Engine({
    store,
    now: () => Date.now(),
    workDir: paths.work,
    log: (level, message, provider) => log.write(level, message, provider),
    read: createProviderRead({ priorsFor: (provider) => store.windowPriors(provider) }),
    send: (pool, workDir, signal) => sendPool(pool, workDir, signal),
    confirmAccount: async (pool) => {
      try {
        if (pool.provider === "codex") return readCodexAccountId().accountId === pool.accountId;
        if (pool.provider === "grok") return readGrokIdentity().userId === pool.accountId;
        const agy = loadConfig().cli.agy;
        if (!agy) return false;
        return confirmAgyAccount(agy, pool.accountId);
      } catch {
        return false;
      }
    },
  });
  engine.recover();
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    clearInterval(watchdog);
    clearInterval(refresh);
    clearInterval(due);
    beginShutdown();
    engine.stop();
    await engine.drain();
    await killOwned();
    await lock.release();
    store.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop());
  process.on("SIGINT", () => void stop());
  let lastWall = Date.now();
  const tick = async (reason: string) => {
    if (stopped) return;
    try { await engine.review(reason); } catch (error) {
      log.write("error", error instanceof Error ? error.message : String(error));
    }
  };
  void tick("startup");
  const watchdog = setInterval(() => {
    const now = Date.now();
    if (now - lastWall > 20_000 || now + 2_000 < lastWall) void tick(now + 2_000 < lastWall ? "clock" : "wake");
    lastWall = now;
  }, 10_000);
  const refresh = setInterval(() => void tick("refresh"), loadConfig().refreshIntervalMs || 60_000);
  let manualRequest: string | null = null;
  const due = setInterval(() => {
    const requested = store.getMeta("refreshRequested");
    if (requested && requested !== store.getMeta("refreshAcknowledged") && !manualRequest) {
      manualRequest = requested;
      void tick("manual").finally(() => {
        if (!stopped) store.setMeta("refreshAcknowledged", requested);
        manualRequest = null;
      });
    }
    if (engine.shouldProbeDue()) void tick("due");
  }, 1_000);
  await new Promise(() => undefined);
  return 0;
}

async function sendPool(pool: PoolFact, workDir: string, signal?: AbortSignal): Promise<SendResult> {
  const config = loadConfig();
  const request = {
    provider: pool.provider,
    accountId: pool.accountId,
    poolId: pool.poolId,
    model: pool.selectedModel || "",
    prompt: "只回复 OK，不调用工具，不读取或修改文件",
    workDir,
  };
  if (pool.provider === "codex" && config.cli.codex) return sendCodex(request, config.cli.codex, signal);
  if (pool.provider === "antigravity" && config.cli.agy) return sendAntigravity(request, config.cli.agy, signal);
  if (pool.provider === "grok" && config.cli.grok) return sendGrok(request, config.cli.grok, signal);
  return { outcome: "not_sent", sessionId: null, detail: "CLI 路径缺失", started: false };
}

async function status(): Promise<number> {
  const paths = runtimePaths();
  const alive = await new InstanceLock(paths.lock).ping();
  const store = fs.existsSync(paths.db) ? new Store(paths.db) : null;
  if (!store) {
    console.log(`进程: ${alive ? "运行中" : "未运行"}（只表示进程，不表示已自动激活）\n暂停: 未知\n读取: 尚无额度快照\n发送: 未开始`);
    return 0;
  }
  printStatus(store, [`进程: ${alive ? "运行中" : "未运行"}`]);
  store.close();
  return 0;
}

export function printStatus(store: Store, header: string[]): void {
  const snapshots = store.snapshots();
  const windows = store.allWindows();
  const tasks = store.recentTasks(10);
  const now = Date.now();
  const blocking = store.activationTasks().filter((task) => {
    const currentAccount = store.getMeta(`account:${task.provider}`);
    if (currentAccount && currentAccount !== task.account_id) return false;
    const window = windows.find((item) => item.provider === task.provider && item.account_id === task.account_id && item.pool_id === task.pool_id && item.window_key === task.window_key);
    return blocksActivation(task, window ? {
      key: window.window_key, state: window.state as WindowFact["state"], activationMode: window.activation_mode as WindowFact["activationMode"],
      oldEndedAt: window.old_ended_at, resetAt: window.reset_at,
    } : undefined, now);
  });
  const body = [header[0].includes("进程") ? `${header[0]}（只表示进程，不表示已自动激活）` : header[0], `暂停: ${store.paused() ? "是（跨重启有效）" : "否"}`];
  const auth = ["codex", "claude", "antigravity", "grok"].map((provider) => `${provider}=${store.getMeta(`auth:${provider}`) || "-"}`);
  body.push(`认证: ${auth.join(" ")}`);
  if (snapshots.length === 0) body.push("尚无额度快照");
  for (const snapshot of snapshots) {
    const provider = String(snapshot.provider);
    const rawAccount = String(snapshot.account_id);
    const account = rawAccount.includes("@") ? maskEmail(rawAccount) : maskId(rawAccount);
    const label = String(snapshot.account_label || "").includes("@") ? maskEmail(String(snapshot.account_label)) : account;
    body.push(`\n[${provider}] ${String(snapshot.pool_id)} 账号 ${label} (${account})`);
    body.push(`  观测: ${iso(Number(snapshot.observed_at))} 模型: ${snapshot.selected_model || "-"} 费用: ${snapshot.billing_safety}`);
    const related = windows.filter((item) => item.provider === provider && item.pool_id === snapshot.pool_id && item.account_id === snapshot.account_id);
    const idleDue = related.some((item) => item.state === "idle" && item.activation_mode === "usage_started");
    const sendable = !snapshot.block_reason && snapshot.billing_safety === "subscription_only";
    const taskBlocked = blocking.some((task) => task.provider === provider && task.account_id === snapshot.account_id && task.pool_id === snapshot.pool_id);
    const sendText = !sendable
      ? "阻塞"
      : taskBlocked
        ? "历史请求待核验，同周期不会重发"
        : provider === "grok"
          ? "费用已证明套餐内；周窗口切换满 120 秒后才可能发一条"
          : idleDue
            ? "有待激活窗口，到期复核后才可能发送"
            : "链路未阻塞，当前没有待激活窗口";
    body.push(`  读取: 正常  发送能力: ${sendText}  原因: ${snapshot.block_reason || snapshot.billing_safety}`);
    for (const window of windows.filter((item) => item.provider === provider && item.pool_id === snapshot.pool_id && item.account_id === snapshot.account_id)) {
      body.push(`  窗口 ${window.window_key}: ${window.state}/${window.activation_mode} 额度 ${window.allowance}`);
      body.push(`    旧边界: ${iso(window.old_ended_at)} 计划: ${iso(window.due_at)} reset: ${iso(window.reset_at)}`);
      body.push(`    证据: ${window.evidence}`);
    }
  }
  body.push("\n最近任务:");
  if (tasks.length === 0) body.push("  无");
  for (const task of tasks) {
    const label = task.status === "skipped" && task.error_category === "period_unconfirmed" ? "历史未确认（已收尾）" : task.status;
    body.push(`  #${task.id} ${task.provider}/${task.pool_id}/${task.window_key} ${label} 消息=${task.message_result || "-"} 窗口=${task.window_result || "-"} ${task.detail || ""}`);
  }
  if (blocking.length > 0) {
    body.push("\n防重发保护（历史请求待核验，不代表当前窗口未启动）:");
    for (const task of blocking) {
      const age = Date.now() - (task.claimed_at || task.updated_at);
      body.push(`  #${task.id} ${task.status} 已持续 ${ageText(age)} 窗口确认=${task.window_result || "无"}`);
      body.push(`  原因: ${task.error_category || task.status} ${task.detail || ""}`);
      body.push("  下一步: 继续核验额度；观测到后续活跃窗口或周期结束证据后自动收尾。仅超时不会重发，重启也保留发送记录。");
    }
  }
  console.log(body.join("\n"));
}

function doctor(): number {
  const config = loadConfig();
  const paths = runtimePaths();
  const lines = [
    `Node: ${process.execPath} ${process.version}`,
    `sqlite: node:sqlite`,
    `配置: ${fs.existsSync(paths.config) ? paths.config : "未安装，使用内置路径"}`,
    `Codex: ${exists(config.cli.codex)}`,
    `Grok: ${exists(config.cli.grok)}`,
    `agy: ${exists(config.cli.agy)}`,
    `LaunchAgent: ${fs.existsSync(launchAgentPath()) ? launchAgentPath() : "未安装"}`,
    `状态库: ${fs.existsSync(paths.db) ? paths.db : "无"}`,
  ];
  try {
    const uid = execFileSync("/usr/bin/id", ["-u"], { encoding: "utf8" }).trim();
    const printed = execFileSync("/bin/launchctl", ["print", `gui/${uid}/${LAUNCH_LABEL}`], { encoding: "utf8" });
    lines.push(`launchctl: ${printed.includes("state = running") ? "running" : "已加载"}`);
  } catch {
    lines.push("launchctl: 未加载");
  }
  lines.push("doctor 不会发送消息，也不会启动第二个 daemon");
  console.log(lines.join("\n"));
  return 0;
}

function setPaused(paused: boolean): number {
  const store = new Store(runtimePaths().db);
  store.setPaused(paused);
  store.addEvent("info", paused ? "用户暂停" : "用户恢复");
  store.close();
  console.log(paused ? "已暂停，重启后仍然有效" : "已恢复");
  return 0;
}

function install(): number {
  const home = supportDir();
  const app = path.join(home, "app");
  fs.mkdirSync(app, { recursive: true });
  fs.mkdirSync(path.join(home, "work"), { recursive: true });
  fs.mkdirSync(logDir(), { recursive: true });
  const source = path.resolve("dist/src");
  if (!fs.existsSync(path.join(source, "index.js"))) {
    console.error("请先 npm run build");
    return 1;
  }
  copyDir(source, app);
  fs.writeFileSync(path.join(app, "package.json"), '{"type":"module","private":true}\n');
  const existing = fs.existsSync(path.join(home, "config.json")) ? loadConfig() : null;
  const config = existing || {
    nodePath: process.execPath,
    cli: {
      codex: whichAbs("codex") || "/opt/homebrew/bin/codex",
      grok: whichAbs("grok") || path.join(os.homedir(), ".local", "bin", "grok"),
      agy: whichAbs("agy") || path.join(os.homedir(), ".local", "bin", "agy"),
    },
    refreshIntervalMs: 60_000,
    graceMs: 120_000,
  };
  fs.writeFileSync(path.join(home, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
  const plist = renderPlist(config.nodePath, path.join(app, "index.js"), home);
  fs.mkdirSync(path.dirname(launchAgentPath()), { recursive: true });
  fs.writeFileSync(launchAgentPath(), plist);
  const uid = execFileSync("/usr/bin/id", ["-u"], { encoding: "utf8" }).trim();
  const target = `gui/${uid}/${LAUNCH_LABEL}`;
  try { execFileSync("/bin/launchctl", ["bootout", target], { stdio: "ignore" }); } catch { /* 未加载 */ }
  execFileSync("/bin/sleep", ["1"]);
  let bootstrapped = false;
  for (let attempt = 0; attempt < 3 && !bootstrapped; attempt += 1) {
    try {
      execFileSync("/bin/launchctl", ["bootstrap", `gui/${uid}`, launchAgentPath()], { stdio: "ignore" });
      bootstrapped = true;
    } catch {
      execFileSync("/bin/sleep", ["1"]);
    }
  }
  if (!bootstrapped) {
    console.error("LaunchAgent 加载失败");
    return 1;
  }
  execFileSync("/bin/launchctl", ["enable", target]);
  try { execFileSync("/bin/launchctl", ["kickstart", target], { stdio: "ignore" }); } catch { /* 已在运行 */ }
  console.log(`已安装 ${LAUNCH_LABEL}`);
  return 0;
}

function uninstall(purge: boolean): number {
  const uid = execFileSync("/usr/bin/id", ["-u"], { encoding: "utf8" }).trim();
  const target = `gui/${uid}/${LAUNCH_LABEL}`;
  try { execFileSync("/bin/launchctl", ["bootout", target]); } catch { /* 未加载 */ }
  try { fs.unlinkSync(launchAgentPath()); } catch { /* 无 plist */ }
  if (purge) {
    fs.rmSync(supportDir(), { recursive: true, force: true });
    fs.rmSync(logDir(), { recursive: true, force: true });
    console.log("已卸载并删除本工具状态与日志");
  } else {
    console.log("已卸载 LaunchAgent，保留状态与日志");
  }
  return 0;
}

function renderPlist(nodePath: string, script: string, home: string): string {
  const env = ["HOME", "NO_PROXY", "no_proxy"].flatMap((key) => {
    const value = process.env[key];
    return value ? [`    <key>${key}</key>`, `    <string>${escapeXml(value)}</string>`] : [];
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(nodePath)}</string>
    <string>${escapeXml(script)}</string>
    <string>daemon</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(home)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${escapeXml(path.join(logDir(), "launchd.out.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(path.join(logDir(), "launchd.err.log"))}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>AIQUOTA5H_HOME</key>
    <string>${escapeXml(home)}</string>
    <key>PATH</key>
    <string>${escapeXml(`${path.dirname(nodePath)}:${path.join(os.homedir(), ".local", "bin")}:/usr/bin:/bin:/usr/sbin:/sbin`)}</string>
${env.join("\n")}
  </dict>
</dict>
</plist>
`;
}

function createLogger(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "aiquota5h.log");
  return {
    write(level: string, message: string, provider?: string) {
      const line = `${new Date().toISOString()} ${level} ${provider || "-"} ${redactText(message)}\n`;
      rotate(file);
      fs.appendFileSync(file, line);
    },
  };
}

function rotate(file: string): void {
  try {
    if (!fs.existsSync(file) || fs.statSync(file).size < 2_000_000) return;
    for (let index = 4; index >= 1; index -= 1) {
      const from = index === 1 ? file : `${file}.${index - 1}`;
      const to = `${file}.${index}`;
      if (fs.existsSync(from)) fs.renameSync(from, to);
    }
  } catch { /* 轮转失败不阻塞 */ }
}

function copyDir(from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(source, target);
    else fs.copyFileSync(source, target);
  }
}

function whichAbs(name: string): string | null {
  try {
    return execFileSync("/usr/bin/which", [name], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

function exists(file?: string): string {
  if (!file) return "未配置";
  return fs.existsSync(file) ? file : `缺失 ${file}`;
}

function ageText(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes}分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}小时${minutes % 60}分钟`;
  return `${Math.floor(hours / 24)}天${hours % 24}小时`;
}

function iso(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "-";
  return new Date(value).toISOString();
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
