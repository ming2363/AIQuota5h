import { loadConfig, type AppConfig } from "./config.js";
import { readAntigravity } from "./providers/antigravity.js";
import { readCodex } from "./providers/codex.js";
import { readGrok } from "./providers/grok.js";
import { readClaude } from "./providers/claude.js";
import type { PriorWindow } from "./decision.js";
import type { ProviderId, ProviderReadError, ProviderSnapshot } from "./types.js";

export interface ProviderReadFactory {
  now?: () => number;
  loadConfig?: () => Pick<AppConfig, "cli">;
  readCodex?: typeof readCodex;
  readAntigravity?: typeof readAntigravity;
  readGrok?: typeof readGrok;
  readClaude?: typeof readClaude;
  priorsFor?: (provider: ProviderId) => PriorWindow[];
}

export function createProviderRead(options: ProviderReadFactory = {}): (
  provider: ProviderId,
  signal?: AbortSignal,
) => Promise<ProviderSnapshot | ProviderReadError> {
  const now = options.now ?? (() => Date.now());
  const config = options.loadConfig ?? loadConfig;
  const readCodexImpl = options.readCodex ?? readCodex;
  const readAntigravityImpl = options.readAntigravity ?? readAntigravity;
  const readGrokImpl = options.readGrok ?? readGrok;
  return (provider, signal) => {
    if (signal?.aborted) {
      return Promise.resolve({ provider, category: "unavailable", message: "读取已取消", retryAfterMs: 15_000 });
    }
    const cli = config().cli;
    if (provider === "claude") return (options.readClaude ?? readClaude)({ now: now(), signal, priors: options.priorsFor?.("claude") || [] });
    if (provider === "codex") {
      return readCodexImpl({
        command: cli.codex || "codex",
        now: now(),
        signal,
        priors: options.priorsFor?.("codex") || [],
      });
    }
    if (provider === "antigravity") return readAntigravityImpl({ agy: cli.agy, now: now(), signal });
    return readGrokImpl(now(), signal);
  };
}
