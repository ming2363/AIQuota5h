# 第六轮修复提示词

请将以下正文交给执行 AI，并提供 REVIEW_REPORT_ROUND6.md。

---

继续处理 `/Users/zhangming/Documents/workspace/personal/AIQuota5h`，先阅读 REVIEW_REPORT_ROUND6.md、既定需求、AGENTS 规则和当前代码。第五轮费用绕过与静默子孙清理已经修复，60 项测试通过，部署一致。请保留这些修复，本轮集中修复退出期间仍可新增发送进程的竞态，避免重写或扩大功能。

禁止 Git 初始化、git add、commit、push、merge、rebase、标签、PR 等写操作。若使用子代理，必须在任务里明确重复禁止这些 Git 操作。需求、配置、费用或操作范围不确定时先向用户确认；可继续做不依赖答案的调查和修复。

## 已确认问题

daemon 的 stop 仅设置 stopped、await killOwned、释放锁、关闭 Store、process.exit。stopped 只影响后续 tick，不影响正在执行的 Engine/读取/发送器。killOwned 快照只包括开始清理时的子进程与组，等待期间新启动的进程逃过终止和等待。

独立离线复现使用真实 sendCodex/runCommand/killOwned：临时假 CLI 的 --help 等待，SIGTERM 后正常退出 0；ready 后开始 killOwned；sendCodex 在 help 结束后继续启动假发送；旧集合排空后工作进程 process.exit，新 detached 发送进程仍存活。结果 sendStartedAfterShutdown=true、detachedSenderAliveAfterExit=true。复现已清理，未使用真实账号、网络或模型。

对应位置：src/cli.ts:64–70、src/proc.ts:49–54、src/providers/codex.ts:323–334。其他多阶段发送器、串行池任务与仍在等待的读取也要检查同一退出约束。

## 需要达到的行为

1. 开始退出时先禁止新调度和新推理请求，取消正在等待的读取、账号检查、发送准备，避免其后续 continuation 继续 spawn。停止状态必须到达真实运行链路；仅在 tick 入口加检查不足以解决。
2. 正在进行的任务与本实例拥有的进程组应有界退出；最后才释放单实例锁、关闭 Store 和 process.exit。清理过程中不可产生逃逸的新 owned 进程，也不可有异步任务再访问已经关闭的 Store。不要无限等待、误杀用户进程或增加常驻进程。
3. 保持正确的发送结果语义：从未启动发送的取消任务可以恢复；已经启动且无法证明结果的请求按 unknown 保守处理，不能因取消就标记 not_sent 并重发。读取取消、help、模型列表、实际发送要区分。
4. 保留父进程 close 后静默子孙的强杀、进程号复用防护、不误杀无关进程、SQLite 锁、费用门槛与既有有限重试。只重复调用 killOwned 或加固定 sleep 不算修复。

## 回归验证

- 使用假账号、临时状态和本地假 CLI，禁止发送真实消息。
- 覆盖停止发生在 help/preflight 阶段且子命令正常退出 0：停止后不得启动实际发送，daemon/隔离退出协调器结束后无残留。
- 覆盖退出时排队的池任务和晚完成的读取不能启动请求；已经启动的请求在退出/恢复后不会盲目重发。
- 继续覆盖已存在的静默/继承管道子孙被有界清理、无关进程存活。测试需 finally 清理全部 fixture，失败也不能残留。
- 运行构建和适当回归；若部署，保留用户配置、暂停状态和任务，核对实际文件一致及单实例。不要用真实服务停启反复触发模型消息。

## 交付边界

Antigravity 三池仍因 agy 1.4.0 缺少已验证的调用级 plugins/MCP/hooks 隔离而不能真实激活。继续如实列出能力缺口；若有安全可行路径先调查，若需要新的用户配置或授权，准备具体改动范围后询问，不删 guard，不编造参数，不改全局配置。

Grok 费用未知或 blocked 时必须继续禁止发送，任何周期消息授权都不构成额外计费授权；行为范围不清先确认，不把实现文档当用户指令。

更新准确的验收记录，分别报告测试、部署、真实读取、可用发送、请求接受和新窗口确认。没有真实验证的合盖、跨五小时和跨周仍写未验证。完成修复和本地验证后保留所有业务改动未暂存。
