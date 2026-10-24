# 第七轮修复提示词

请将以下正文交给执行 AI，并提供 REVIEW_REPORT_ROUND7.md。

---

请继续处理 `/Users/zhangming/Documents/workspace/personal/AIQuota5h`，先阅读 REVIEW_REPORT_ROUND7.md、需求与 AGENTS 规则。当前 62 项测试通过、部署一致；第六轮退出竞态已经修复。本轮集中补齐退出监听器的资源生命周期，不重写项目、不扩大产品行为。

禁止 Git 初始化、git add/commit/push/merge/rebase、标签和 PR 等写操作，保持业务改动未暂存。若使用子代理，任务中必须明确重复禁止 Git 写操作。不确定的需求、配置、费用和范围先向用户确认；可先做不依赖答案的调查。

## 已确认缺陷

1. src/engine.ts:311 每次 readShared 都向整个引擎共用的 stopController.signal 增加匿名 abort 监听器。finally 只删除 reads/readControllers，没有移除监听器。once 不能在读取完成时自动清理。
2. src/providers/rpc.ts:61 每个 RPC 都向全局 shutdownSignal 注册 onAbort；close 仅移除调用方 signal 的监听器，全局监听器一直保留已退出的 ChildProcess 与 RPC 闭包；自然 close/error 路径也没有统一释放。

这两个位置属于同一类生命周期缺陷。独立离线验证：20 次 Engine 读取全部完成，activeReadControllers=0，但 retainedStopListeners=20；12 个假 RPC 逐个正常关闭并等待 killOwned 完成后，shutdownSignal 的 abort 监听器从 0 增到 12。无真实账号、网络或模型调用。

## 修复要求

- Engine 结束读取后释放本次注册的退出监听器；也可以删除与现有 readControllers 集合重复的注册。仍要能取消所有真正进行中的读取，并保持共享读取、超时和清理顺序正确。
- RPC 为本次注册建立对称、幂等的终止清理，解除全局退出信号和调用方 signal 的监听器，覆盖显式 close、自然退出、启动 error、外部取消及 daemon 退出。清理不能使仍存活的子进程逃过终止/强杀，也不能把已发出但结果未知的请求当成未发送。
- 保留 beginShutdown 对新任务/新 spawn 的封锁、Engine stop/drain、SQLite 锁、静默子孙清理和不误杀无关进程、费用门槛、unknown 结果与有限重试。
- 不要通过 setMaxListeners、关闭警告、周期性重启或重置全局 AbortController 隐藏问题。不要增加常驻进程、Web 服务、GUI 或额外依赖来修复监听器释放。

## 验证与交付

- 使用真实生产函数与本地假快照/RPC，验证连续多次正常读取/关闭后监听器回到基线；数量不随已完成调用线性增长。可使用 node:events 的 getEventListeners。
- 覆盖异常终止/取消的清理，并验证仍在进行的读取/RPC 在 shutdown 时能及时结束；保留退出 preflight 后不再发送、已启动结果未知不重发的回归。
- 使用内存/临时状态、假 CLI，禁止为了测试发送真实消息。所有 fixture 必须 finally 清理。
- 运行构建和适当回归。若部署，保留用户配置、暂停和任务状态，核对安装文件与构建一致、单实例。准确更新验收报告。

Antigravity 真实自动激活仍因缺少已验证的调用级插件/MCP/hooks 隔离而未完成；Grok 当前费用未知，继续禁止发送。Codex 当前窗口未知时也不能强行触发。不要删 guard、编造参数、修改全局配置或用 mock 宣称真实功能完成。若另有安全可行路径可只读调查；需要新的配置或授权时先提出具体范围与影响并向用户确认。

最终分别报告本轮修复、测试、部署和真实能力缺口。真实消息接受、新窗口确认、合盖及跨周期没有实测就继续如实注明。
