# AIQuota5h 第七轮复核

日期：2026-10-17。本轮 62/62 测试通过、构建成功、安装文件一致。第六轮退出竞态已修复；新增退出监听器存在长期保留问题，需要补充清理。三平台完整自动激活仍未验收完成。

## 上轮修复检查

- daemon 退出先关闭任务入口，调用 engine.stop/drain，再清理进程、释放锁和关闭数据库。
- runCommand、RPC、发送器已接入停止状态；Codex help 被 SIGTERM 后退出 0，也不会继续启动发送。已有回归通过。
- 晚完成读取、排队任务不能在停止后派发；已启动但结果未知的请求保持 unknown。已有回归通过。
- 费用未知/blocked 禁发、静默子孙清理与其他既有回归仍通过。

## 确认问题

### 1. [P2] 完成的读取与关闭的 RPC 没有移除退出监听器

位置：`src/engine.ts:311,337–340`；`src/providers/rpc.ts:56–63,82–85`。

Engine 每次 readShared 新建读取时，向整个引擎生命周期共用的 stopController.signal 注册匿名 abort 回调；finally 只删除 readControllers/reads，没有删除回调。once 只会在真正退出触发 abort 时移除，不能在读取完成后移除。

openRpc 每个客户端又向整个进程共用的 shutdownSignal 注册 onAbort。close 只移除调用方 signal 上的回调，没有移除全局退出信号上的回调；进程自然退出、启动错误等终止路径同样缺少对应清理。全局信号因而继续持有已退出的 ChildProcess、RPC 闭包和数据对象。

独立本地验证使用真实编译后的 Engine/Store/openRpc/proc，内存数据库、假快照和本地 Node 假 RPC，不访问网络或认证，不发送模型消息：

```json
{"probe":"completed-engine-reads","reads":20,"activeReadControllers":0,"retainedStopListeners":20}
{"probe":"closed-rpc-clients","completed":12,"baselineListeners":0,"retainedShutdownListeners":12}
```

第二项统计前已逐个等待 RPC 子进程 close，并等待 killOwned 完成，排除了仍在清理的正常存活对象。临时子进程已全部退出，内存状态已关闭。

影响：正常定时刷新就会持续增加保留对象，长时间运行时内存无法回到稳定基线；退出时还会遍历并执行已关闭 RPC 的历史终止回调。这与用户要求轻量长期后台运行不符。本轮没有测量长期 RSS 增量，也没有复现进程号复用后的误杀，不能将这些表述为已发生。

建议最小修复：读取结束时移除具名退出回调，或删除与 readControllers 集合功能重复的注册；RPC 在统一终止清理中移除本次注册的全局和调用方监听器，覆盖 close、自然退出、error、取消等路径。保留真正存活任务的取消能力和进程组清理。新增连续完成多轮后监听器数量回到基线的回归，不能用提高监听器上限、重置全局信号或关闭警告来掩盖保留。

## 实际部署与能力边界

- 只读核对 LaunchAgent running，PID 15007，runs=1，last exit code=(never exited)。安装 app 全部 JS 与本次 dist/src 相同。
- 只读状态库任务数 0。本次 Codex 快照为 subscription_only，但 block_reason=window_state_unknown；Grok 为 billing_safety_unknown、allowance_unknown。状态可能随服务端变化，不把此前验收报告的 active 描述当作当前事实，也没有修改状态强行触发。
- Antigravity 三池仍因 agy 缺少调用级 plugins/MCP/hooks 隔离而阻塞，真实自动激活未完成。Grok 当前仍不能证明费用安全。
- 未实测真实请求接受、新窗口启动、合盖唤醒、跨五小时或跨周。不能据 62 项离线测试声称完整产品目标完成。

本轮仅新增复核文档，没有修改业务源码、运行配置或状态，没有停止真实服务，没有发送真实消息，也没有执行 Git 写操作。npm test 重新生成了 dist。目录没有 .git，本轮结论来自源码/调用链、测试和独立本地验证，不是固定提交差异或 GitNexus 图索引审查。
