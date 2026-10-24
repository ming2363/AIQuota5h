import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { killOwned, runCommand, trackChild } from "../src/proc.js";

function writeSilent(dir: string): { parent: string; grandchild: string; pidFile: string } {
  const grandchild = path.join(dir, "silent-grand.mjs");
  const parent = path.join(dir, "silent-parent.mjs");
  const pidFile = path.join(dir, "grand.pid");
  fs.writeFileSync(grandchild, "process.on('SIGTERM', () => {});\nsetInterval(() => {}, 1000);\n");
  fs.writeFileSync(parent, `
    import { spawn } from "node:child_process";
    import fs from "node:fs";
    const child = spawn(process.execPath, [process.argv[2]], { stdio: "ignore" });
    fs.writeFileSync(process.argv[3], String(child.pid));
    child.unref();
    setInterval(() => {}, 1000);
  `);
  return { parent, grandchild, pidFile };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("等待超时");
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

test("不继承管道的子孙在超时和取消后不会留下", async () => {
  const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  unrelated.unref();
  const leftovers: number[] = [];
  try {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "aiquota5h-silent-"));
    const fixture = writeSilent(root);
    await runCommand({
      command: process.execPath,
      args: [fixture.parent, fixture.grandchild, fixture.pidFile],
      timeoutMs: 500,
    });
    await new Promise((resolve) => setTimeout(resolve, 900));
    const pid = Number(fs.readFileSync(fixture.pidFile, "utf8"));
    leftovers.push(pid);
    assert.equal(alive(pid), false);
    assert.equal(alive(unrelated.pid!), true);

    const abortRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aiquota5h-silent-abort-"));
    const abortFixture = writeSilent(abortRoot);
    const controller = new AbortController();
    const pending = runCommand({
      command: process.execPath,
      args: [abortFixture.parent, abortFixture.grandchild, abortFixture.pidFile],
      timeoutMs: 30_000,
      signal: controller.signal,
    });
    await waitFor(() => fs.existsSync(abortFixture.pidFile));
    controller.abort();
    await pending;
    await new Promise((resolve) => setTimeout(resolve, 900));
    const abortPid = Number(fs.readFileSync(abortFixture.pidFile, "utf8"));
    leftovers.push(abortPid);
    assert.equal(alive(abortPid), false);
    assert.equal(alive(unrelated.pid!), true);
  } finally {
    for (const pid of leftovers) {
      try { process.kill(-pid, "SIGKILL"); } catch { /* 不是组长 */ }
      try { process.kill(pid, "SIGKILL"); } catch { /* 已退出 */ }
    }
    if (unrelated.pid) {
      try { process.kill(unrelated.pid, "SIGKILL"); } catch { /* 已退出 */ }
    }
    await killOwned();
  }
});

test("父进程退出后，清理会等强杀静默子孙", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aiquota5h-owned-"));
  const fixture = writeSilent(root);
  const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  unrelated.unref();
  const child = spawn(process.execPath, [fixture.parent, fixture.grandchild, fixture.pidFile], { detached: true, stdio: "ignore" });
  trackChild(child);
  let grand = 0;
  try {
    await waitFor(() => fs.existsSync(fixture.pidFile));
    grand = Number(fs.readFileSync(fixture.pidFile, "utf8"));
    process.kill(child.pid!, "SIGTERM");
    await new Promise((resolve) => child.once("close", resolve));
    assert.equal(alive(grand), true);
    await killOwned();
    assert.equal(alive(grand), false);
    assert.equal(alive(unrelated.pid!), true);
  } finally {
    if (grand) {
      try { process.kill(grand, "SIGKILL"); } catch { /* 已退出 */ }
    }
    if (unrelated.pid) {
      try { process.kill(unrelated.pid, "SIGKILL"); } catch { /* 已退出 */ }
    }
    await killOwned();
  }
});
