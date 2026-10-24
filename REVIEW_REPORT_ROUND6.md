# AIQuota5h 第六轮复核

日期：2026-10-17。结论：第五轮两项修复有效，但退出期间仍可启动新的发送进程，建议先修复这一处再验收后台生命周期。Antigravity 真实自动激活仍未完成。

## 已验证的修复

- `npm test`：构建成功，60/60 通过。
- Grok 周期切换不再绕过费用检查：`src/decision.ts:42` 对未知/blocked 阻塞；`src/engine.ts:183` 最终复核统一要求 subscription_only。已有引擎回归覆盖未知和 blocked，不再断言未知费用可以发送。
- 静默子孙清理：父进程 close 不再撤销强杀，进程组所有权独立保留；已有测试覆盖不继承管道、忽略 SIGTERM、超时、取消、父进程先退出和不伤及无关进程，均通过。
- daemon 已改成等待 `killOwned()`，之后才释放锁、关数据库、退出。这解决了原先直接退出丢失终止定时器的问题，但还缺少停止接收新工作的步骤。

## 确认问题

### 1. [P2] 退出清理后仍能新增发送进程，新进程逃过清理

位置：`src/cli.ts:64–70`；`src/proc.ts:49–54`；`src/providers/codex.ts:323–334`。

`stop()` 的 stopped 只阻止下一次 tick，不能停止已经进行中的 Engine 调度、读取或发送器。`killOwned()` 仅对调用时的 owned/groups 做一次快照；等待期间后来 trackChild 的进程既不在终止集合，也不在等待集合。Codex 发送器完成 --help 后会直接启动实际发送，没有退出信号或停止检查。因此在服务停止/卸载时，仍可能启动请求；锁释放和主进程退出后，该 detached CLI 继续存在，失去超时和所有权管理。

独立离线复现使用真实编译后的 `sendCodex`、`runCommand`、`killOwned`，在隔离工作进程里执行与 daemon 相同的“等待清理，再 process.exit”顺序：

1. 假 CLI 的 --help 阶段写入 ready，并在 SIGTERM 时正常退出 0。
2. ready 后调用 killOwned，开始退出清理。
3. 假 --help 被终止后，sendCodex 继续启动假发送命令。
4. killOwned 等待旧集合完成，工作进程退出；新的 detached 假发送进程仍存活。

观测结果：

```json
{"probe":"shutdown-during-codex-preflight","workerExit":0,"sendStartedAfterShutdown":true,"detachedSenderAliveAfterExit":true,"stderr":""}
```

复现没有调用真实 Codex，没有读取认证或访问网络；最后已显式终止该临时进程组并删除临时文件。这是发送器与退出清理的组合验证，不是对真实 LaunchAgent 发终止信号。

现有退出测试只覆盖清理开始前已存在的进程，所以全部通过。最小修复应先关闭新任务/新进程入口，取消正在等待的读取和发送准备，再有界地排空已有任务与进程，最后释放锁、关闭存储和退出。取消前尚未启动的请求不能继续启动；可能已经发出的请求仍需保留 unknown 的保守恢复语义。不能只追加一轮 killOwned 或额外 sleep 掩盖竞态。

## 真实运行状态与未完成项

- LaunchAgent：running，PID 57794，runs=1，last exit code=(never exited)。
- 安装目录 app 的全部 JS 与本次 dist/src 相同；没有发现部署漂移。
- 只读状态库：任务数 0，暂停值 0。Codex 费用 subscription_only；Antigravity 三池仍因缺少调用级 plugins/MCP/hooks 隔离阻塞；Grok 费用 billing_safety_unknown。
- Antigravity 自动发送仍没有可用的真实隔离路径；不能把安全阻塞视为完成三平台目标。
- 未实测真实消息接受、新窗口启动、跨五小时/跨周及合盖唤醒。没有为了审查主动发送消息。
- Grok 周消息是否获用户另行授权，本轮没有新证据；实现报告引用的其他对话不能替代本聊天的人类指令。本轮没有据此调整行为，费用门槛修复的判断独立成立。

## 范围

复核源码、调用链、回归测试和本地进程故障场景；没有修改业务源码、运行配置或状态，没有停止真实服务，没有执行 Git 写操作。运行 npm test 会重新生成 dist。当前目录没有 .git，无法提供基于固定提交差异或 GitNexus 图索引的结论。本轮仅新增复核报告和修复提示词。
