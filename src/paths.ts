import os from "node:os";
import path from "node:path";

export function supportDir(home = os.homedir()): string {
  return path.join(home, "Library", "Application Support", "AIQuota5h");
}

export function logDir(home = os.homedir()): string {
  return path.join(home, "Library", "Logs", "AIQuota5h");
}

export function launchAgentPath(home = os.homedir()): string {
  return path.join(home, "Library", "LaunchAgents", "com.zhangming.aiquota5h.plist");
}

export const LAUNCH_LABEL = "com.zhangming.aiquota5h";

export function runtimePaths(home = process.env.AIQUOTA5H_HOME || supportDir()) {
  return {
    home,
    db: path.join(home, "state.sqlite"),
    config: path.join(home, "config.json"),
    work: path.join(home, "work"),
    lock: path.join(home, "daemon.lock"),
    app: path.join(home, "app"),
  };
}
