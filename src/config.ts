import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runtimePaths } from "./paths.js";
import { GRACE_MS } from "./types.js";

export interface AppConfig {
  nodePath: string;
  cli: { codex?: string; claude?: string; grok?: string; agy?: string };
  refreshIntervalMs: number;
  graceMs: number;
}

export function loadConfig(): AppConfig {
  const file = runtimePaths().config;
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8")) as AppConfig;
  return {
    nodePath: process.execPath,
    cli: {
      codex: "/opt/homebrew/bin/codex",
      claude: "/opt/homebrew/bin/claude",
      grok: path.join(os.homedir(), ".local", "bin", "grok"),
      agy: path.join(os.homedir(), ".local", "bin", "agy"),
    },
    refreshIntervalMs: 60_000,
    graceMs: GRACE_MS,
  };
}
