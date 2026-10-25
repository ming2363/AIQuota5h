import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { InstanceLock } from "./lock.js";
import { LAUNCH_LABEL, launchAgentPath, runtimePaths } from "./paths.js";

type CommandResult = { code: number; stdout: string; stderr: string };
interface ServiceOptions {
  run?: (args: string[]) => CommandResult;
  isRunning?: () => Promise<boolean>;
  installed?: () => boolean;
  sleep?: () => Promise<void>;
  attempts?: number;
}

export async function controlService(action: "start" | "stop", options: ServiceOptions = {}): Promise<void> {
  const target = `gui/${process.getuid?.() ?? 0}/${LAUNCH_LABEL}`;
  const run = options.run ?? ((args: string[]): CommandResult => {
    const result = spawnSync("/bin/launchctl", args, { encoding: "utf8", timeout: 8_000, maxBuffer: 64_000 });
    return { code: result.status ?? -1, stdout: result.stdout || "", stderr: result.error?.message || result.stderr || "" };
  });
  const isRunning = options.isRunning ?? (() => new InstanceLock(runtimePaths().lock).ping());
  const sleep = options.sleep ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 100)));
  const missing = (result: CommandResult) => result.code === 113 && /Could not find service/i.test(result.stderr + result.stdout);
  const checked = (args: string[]) => {
    const result = run(args);
    if (result.code !== 0) throw new Error(`后台${action === "start" ? "启动" : "停止"}失败：${(result.stderr || result.stdout).trim().slice(0, 500)}`);
  };

  if (action === "start" && await isRunning()) return;
  if (action === "start" && !(options.installed ?? (() => fs.existsSync(launchAgentPath())))()) {
    throw new Error("后台服务尚未安装，请先运行安装命令");
  }
  const current = run(["print", target]);
  if (current.code !== 0 && !missing(current)) throw new Error(`无法检查后台服务：${current.stderr.trim().slice(0, 500)}`);
  if (action === "stop") {
    // Unload KeepAlive before waiting for the daemon to release its process lock.
    if (current.code === 0) checked(["bootout", target]);
  } else {
    if (missing(current)) checked(["bootstrap", `gui/${process.getuid?.() ?? 0}`, launchAgentPath()]);
    checked(["kickstart", target]);
  }
  let unloaded = false;
  for (let attempt = 0; attempt < (options.attempts ?? 80); attempt++) {
    if (action === "stop" && !unloaded) {
      // bootout may return while launchd is still removing the service.
      const remaining = run(["print", target]);
      unloaded = missing(remaining);
      if (remaining.code !== 0 && !unloaded) throw new Error(`无法确认后台卸载：${remaining.stderr.trim().slice(0, 500)}`);
    }
    if ((action === "start" || unloaded) && await isRunning() === (action === "start")) return;
    await sleep();
  }
  throw new Error(action === "stop" ? "后台进程尚未停止，管理界面将保持打开，请稍后重试" : "后台启动尚未确认，请稍后重试");
}
