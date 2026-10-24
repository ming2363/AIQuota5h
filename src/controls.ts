import crypto from "node:crypto";
import { PROVIDER_NAMES } from "./dashboard.js";
import type { Store } from "./store.js";

export function updateControl(store: Store, args: string[]): void {
  const [kind, provider, value, pool] = args;
  if (!Object.hasOwn(PROVIDER_NAMES, provider || "")) throw new Error("未知额度渠道");
  if (value !== "on" && value !== "off") throw new Error("开关只接受 on 或 off");
  if (kind === "monitor" && args.length === 3) {
    store.setMeta(`monitor:${provider}`, value === "on" ? "1" : "0");
  } else if (kind === "activate" && args.length === 4) {
    if (!store.snapshots().some((row) => row.provider === provider && row.pool_id === pool)) throw new Error("额度池尚不存在，请先读取额度");
    if (provider === "claude" && value === "on") throw new Error("Claude Code 目前为只读监控，尚未证明自动发送的隔离与费用条件");
    store.setMeta(`activate:${provider}:${pool}`, value === "on" ? "1" : "0");
  } else throw new Error("无效控制指令");
  store.addEvent("info", `用户${value === "on" ? "开启" : "关闭"}${kind === "monitor" ? "自动读取" : `自动激活 ${pool}`}`, provider);
}

export function requestRefresh(store: Store): void {
  store.setMeta("refreshRequested", crypto.randomUUID());
}
