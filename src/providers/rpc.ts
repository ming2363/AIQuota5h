import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { isShuttingDown, killTree, safeEnv, shutdownSignal, trackChild } from "../proc.js";

export interface RpcClient {
  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  close(): void;
  child: ChildProcess;
}

export function openRpc(command: string, args: string[], timeoutMs = 20_000, env?: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<RpcClient> {
  if (signal?.aborted || isShuttingDown()) return Promise.reject(new Error("rpc 已取消"));
  const child = spawn(command, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: env ?? safeEnv(),
    detached: process.platform !== "win32",
  });
  trackChild(child);
  let buffer = "";
  let nextId = 1;
  let closed = false;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();

  const fail = (error: Error) => {
    if (closed) return;
    closed = true;
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    pending.clear();
  };

  child.stdout?.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) {
        try {
          const message = JSON.parse(line) as { id?: number; result?: unknown; error?: { message?: string } };
          if (message.id != null && pending.has(message.id)) {
            const item = pending.get(message.id)!;
            clearTimeout(item.timer);
            pending.delete(message.id);
            if (message.error) item.reject(new Error(message.error.message || "rpc error"));
            else item.resolve(message.result);
          }
        } catch { /* 忽略非 JSON */ }
      }
      index = buffer.indexOf("\n");
    }
  });
  const onAbort = () => {
    release();
    fail(new Error("rpc 已取消"));
    killTree(child);
  };
  const release = () => {
    signal?.removeEventListener("abort", onAbort);
    shutdownSignal().removeEventListener("abort", onAbort);
  };
  signal?.addEventListener("abort", onAbort);
  shutdownSignal().addEventListener("abort", onAbort);
  child.once("error", (error) => {
    release();
    fail(error);
    killTree(child);
  });
  child.once("close", (code) => {
    release();
    fail(new Error(`rpc exited ${code}`));
  });

  const client: RpcClient = {
    child,
    request(method, params, requestTimeout = timeoutMs) {
      if (closed) return Promise.reject(new Error("rpc closed"));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} timed out`));
        }, requestTimeout);
        pending.set(id, { resolve, reject, timer });
        child.stdin?.write(`${JSON.stringify(params === undefined ? { method, id } : { method, id, params })}\n`);
      });
    },
    notify(method, params) {
      child.stdin?.write(`${JSON.stringify(params === undefined ? { method } : { method, params })}\n`);
    },
    close() {
      release();
      fail(new Error("rpc closed"));
      killTree(child);
    },
  };
  return Promise.resolve(client);
}
