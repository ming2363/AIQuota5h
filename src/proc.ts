import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";

const SECRET_ENV = [
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "XAI_API_KEY",
  "GROK_BEARER_TOKEN",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "ANTHROPIC_API_KEY",
];

export interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  started: boolean;
  spawnError: string | null;
  pid: number | null;
  maxRssKb: number | null;
}

const owned = new Set<ChildProcess>();

interface OwnedGroup {
  pgid: number;
  startedAt: string;
  timer: NodeJS.Timeout | null;
  done: boolean;
  resolve: () => void;
  settled: Promise<void>;
}

const groups = new Map<number, OwnedGroup>();
let workGate = { open: true, controller: new AbortController() };

export function beginShutdown(): void {
  workGate.open = false;
  if (!workGate.controller.signal.aborted) workGate.controller.abort();
}

export function isShuttingDown(): boolean {
  return !workGate.open || workGate.controller.signal.aborted;
}

export function shutdownSignal(): AbortSignal {
  return workGate.controller.signal;
}

export function resetShutdownForTests(): void {
  workGate = { open: true, controller: new AbortController() };
}

export function trackChild(child: ChildProcess): void {
  owned.add(child);
  const pid = child.pid;
  if (pid && pid > 1) rememberGroup(pid);
  child.once("close", () => {
    owned.delete(child);
    if (!pid || pid <= 1) return;
    scheduleEscalation(pid);
  });
}

export function killOwned(): Promise<void> {
  for (const child of [...owned]) killTree(child);
  for (const group of [...groups.values()]) scheduleEscalation(group.pgid);
  const pending = [...groups.values()].map((group) => group.settled);
  if (pending.length === 0) return Promise.resolve();
  return Promise.all(pending).then(() => undefined);
}

export function safeEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (SECRET_ENV.includes(key)) continue;
    if (value != null) env[key] = value;
  }
  env.NO_COLOR = "1";
  return env;
}

export function runCommand(options: {
  command: string;
  args: string[];
  cwd?: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  input?: string;
  maxOutput?: number;
  children?: Set<ChildProcess>;
  signal?: AbortSignal;
}): Promise<SpawnResult> {
  const maxOutput = options.maxOutput ?? 200_000;
  return new Promise((resolve) => {
    if (isShuttingDown() || options.signal?.aborted) {
      resolve({ code: null, stdout: "", stderr: "", timedOut: false, started: false, spawnError: "已取消", pid: null, maxRssKb: null });
      return;
    }
    let child: ChildProcess;
    try {
      child = spawn(options.command, options.args, {
        cwd: options.cwd,
        env: options.env ?? safeEnv(),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        detached: process.platform !== "win32",
      });
    } catch (error) {
      resolve({
        code: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        started: false,
        spawnError: error instanceof Error ? error.message : String(error),
        pid: null,
        maxRssKb: null,
      });
      return;
    }
    options.children?.add(child);
    trackChild(child);
    const onAbort = () => killTree(child);
    shutdownSignal().addEventListener("abort", onAbort);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let maxRssKb: number | null = null;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, options.timeoutMs);
    const sample = setInterval(() => {
      if (!child.pid) return;
      const rss = readRssKb(child.pid);
      if (rss != null) maxRssKb = Math.max(maxRssKb ?? 0, rss);
    }, 400);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > maxOutput) stdout = stdout.slice(-maxOutput);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > maxOutput) stderr = stderr.slice(-maxOutput);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      clearInterval(sample);
      shutdownSignal().removeEventListener("abort", onAbort);
      options.signal?.removeEventListener("abort", onAbort);
      options.children?.delete(child);
      resolve({
        code: null,
        stdout,
        stderr,
        timedOut,
        started: false,
        spawnError: error.message,
        pid: child.pid ?? null,
        maxRssKb,
      });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      clearInterval(sample);
      shutdownSignal().removeEventListener("abort", onAbort);
      options.signal?.removeEventListener("abort", onAbort);
      options.children?.delete(child);
      resolve({
        code,
        stdout,
        stderr,
        timedOut,
        started: true,
        spawnError: null,
        pid: child.pid ?? null,
        maxRssKb,
      });
    });
    if (options.input != null) child.stdin?.end(options.input);
    else child.stdin?.end();
  });
}

const KILL_GRACE_MS = 400;

export function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid || pid <= 1) return;
  const group = rememberGroup(pid);
  if (!group || group.done) return;
  if (leaderReused(group)) {
    finishGroup(pid);
    return;
  }
  signalOwned(group, "SIGTERM");
  scheduleEscalation(pid);
}

function rememberGroup(pid: number): OwnedGroup | null {
  if (pid <= 1) return null;
  const existing = groups.get(pid);
  if (existing) {
    if (!existing.startedAt) existing.startedAt = readStart(pid);
    return existing;
  }
  let resolve: () => void = () => undefined;
  const settled = new Promise<void>((done) => { resolve = done; });
  const group: OwnedGroup = { pgid: pid, startedAt: readStart(pid), timer: null, done: false, resolve, settled };
  groups.set(pid, group);
  return group;
}

function scheduleEscalation(pid: number): void {
  const group = groups.get(pid);
  if (!group || group.done || group.timer) return;
  group.timer = setTimeout(() => {
    group.timer = null;
    if (!group.done && groupStillOurs(group)) signalOwned(group, "SIGKILL");
    setTimeout(() => finishGroup(pid), 200);
  }, KILL_GRACE_MS);
}

function finishGroup(pid: number): void {
  const group = groups.get(pid);
  if (!group || group.done) return;
  group.done = true;
  if (group.timer) clearTimeout(group.timer);
  group.timer = null;
  groups.delete(pid);
  group.resolve();
}

function signalOwned(group: OwnedGroup, signal: NodeJS.Signals): void {
  if (leaderReused(group)) return;
  if (signal === "SIGKILL" && !groupStillOurs(group)) return;
  try { process.kill(-group.pgid, signal); } catch { /* 组已空或不是进程组 */ }
  if (leaderStillOurs(group)) {
    try { process.kill(group.pgid, signal); } catch { /* 组长已退出 */ }
  }
}

function groupStillOurs(group: OwnedGroup): boolean {
  if (leaderReused(group)) return false;
  return groupMembers(group.pgid).length > 0;
}

function leaderStillOurs(group: OwnedGroup): boolean {
  const start = readStart(group.pgid);
  if (!start) return false;
  if (!group.startedAt) group.startedAt = start;
  return start === group.startedAt;
}

function leaderReused(group: OwnedGroup): boolean {
  const start = readStart(group.pgid);
  return Boolean(group.startedAt && start && start !== group.startedAt);
}

function groupMembers(pgid: number): number[] {
  try {
    const text = execFileSync("/bin/ps", ["-ax", "-o", "pid=,pgid="], { encoding: "utf8" });
    return text.split("\n").flatMap((line) => {
      const [pidText, pgidText] = line.trim().split(/\s+/);
      const pid = Number(pidText);
      return Number(pgidText) === pgid && pid > 1 ? [pid] : [];
    });
  } catch {
    return [];
  }
}

function readStart(pid: number): string {
  try {
    return execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

export function readRssKb(pid: number): number | null {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/status`, "utf8");
    const match = raw.match(/VmRSS:\s+(\d+)/);
    if (match) return Number(match[1]);
  } catch {
    try {
      const text = execFileSync("/bin/ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim();
      const value = Number(text);
      return Number.isFinite(value) ? value : null;
    } catch {
      return null;
    }
  }
  return null;
}
