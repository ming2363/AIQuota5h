# Codex 自动激活实际未工作的修复提示词

请继续修复 `/Users/zhangming/Documents/workspace/personal/AIQuota5h` 的 Codex 自动激活。先读本文件、既定需求和 AGENTS 规则。本次目标是解决真实后台持续读取但没有派发激活任务，不能只继续处理进程和测试数量。

禁止 Git 初始化、git add/commit/push/merge/rebase、标签或 PR 等 Git 写操作。若使用子代理，任务里重复禁止 Git 写操作。需求、费用、配置或操作范围不确定时先确认；可先做不依赖答案的调查。不要清空状态、伪造边界、篡改服务器时间或关闭费用/身份保护。

## 已核查的事实

2026-10-18，LaunchAgent 正常运行且未暂停，读取持续更新，状态库里的 Codex 任务累计为 0。

09:26 左右的快照：primary 与 secondary 均 usedPercent=0；五小时 reset 为 2026-10-18 14:22:43 +08:00，周 reset 为 2026-10-25 09:22:43 +08:00。09:27 的五小时使用率变为 2%，被判 active；周使用率仍为 0%，被判 unknown，整池仍 block:window_state_unknown。没有程序发送记录，不能将这个 active 归功于本工具。

所以不是没有读到周额度。secondary 的 usedPercent、windowDurationMins=10080、resetsAt 都已返回。程序混淆了“额度数据已知/可用”和“窗口是否已被首次请求启动”。0% 不能被当作字段缺失；也不能反过来仅凭 0% 或未来 reset 就认定已经启动或尚未启动。

## 参考源码与实际差异

参考项目当前源码（实现前重新核实版本，复用时保留许可）：

- https://github.com/Javis603/token-monitor/blob/main/src/shared/providers/codex/limits.js
- https://github.com/Javis603/token-monitor/blob/main/src/shared/limits/core.js

token-monitor 的 mapCodexRateLimitsToProvider 将 primary/secondary 的使用率、窗口分钟数、重置时间映射为配额窗口；codexWindowKind 将 secondary/周时长映射为 weekly。它有订阅 OAuth usage 读取、字段归一化及有条件的 app-server RPC 回退。该映射本身不要求证明“已首次使用”才能输出周额度。

本工具已通过 app-server account/rateLimits/read 读到同类字段。换一个 HTTP 入口可能改善读取兼容性，但不能自动修复本工具的错误决策，不能声称换接口就证明了窗口状态。

## 需要修复的链路

1. **分开处理数据有效性、套餐剩余额度、激活目标和时钟证据。** 周额度明确有剩余，不等于周窗口启动状态已确定。五小时目标满足条件时，应按同请求实际影响的窗口判断是否可发，不能笼统地把“周使用率 0%”当成整个 Codex 池的数据缺失；也不能为了放行直接删除所有 unknown 检查。周池自身需要激活时仍应遵守旧窗口结束满 120 秒、新窗口未被用户启动的约束。查清 API 与历史证据能证明什么；必要证据仍不足就准确报告具体缺口。
2. **接通生产历史观测并保留可信旧边界。** runtime.ts 的 createProviderRead 没有把 Store priors 传入 readCodex，readCodex 最终使用空 priors；Engine.applyPriors 只对 idle 补旧边界，unknown 分支无法保留，随后 savePool 覆盖记录。按 provider/account/pool/window 正确关联观测，不能跨池或跨账号借用边界。观察到新的正使用量且锚定新周期时，再按证据归档/清理旧边界。检查暂停、断网、合盖、重启和未知快照时历史是否仍有效。
3. **用连续观测验证时钟语义。** 确认 resetsAt 是稳定锚定时间、未使用时随墙钟移动的候选时间，还是信息不足；必要时使用间隔读取及同账号会话的可靠使用记录进行交叉验证，说明证据与来源。不能仅凭 0%、100% 剩余、reset 在未来或本地减去 5 小时推断 idle/active。历史已丢失时不要补造过去边界；保留当前可信观测，为后续到期提供证据。
4. **保留严格发送约束。** 只使用当前登录订阅账号、套餐额度，旧目标窗口结束满 120 秒再核实，用户已启动则跳过；额度耗尽等待恢复；未知费用、额外余额/API key、充值、重置券均不可放行。真实发送前重新核对账号、额度、模型和任务是否仍有效。同一窗口只发一次；结果不明先核实，不盲目重发。

独立离线复现已贯穿真实 mapCodexPools → Engine → Store：先记录 usedPercent=25、reset 尚未到期的 active；推进到旧 reset 后 180 秒，下一次读到 usedPercent=0、future reset。因为生产形式的 priors=[]，最终 state=unknown、oldEndedAt=null、preservedBoundary=null、tasks=0、sends=0。这证明旧边界被丢失，不证明这一个零用量快照单独足以安全发送。修复和测试必须区分这两件事。

## 验证要求

- 保留现有 63 项回归；新增测试必须贯穿实际生产读取工厂/映射、历史存储、决策及发送前复核，不能只手工构造一个理想 idle WindowFact。
- 覆盖真实形状的五小时/周窗口组合：周 0% 有明确余量、周已耗尽、周字段确实缺失、用户刚使用但取整为 0%、旧窗口到期前后、连续 reset 滑动与固定、新窗口已被用户启动。每个是否发送的预期都说明证据，不把未知伪装为已知。
- 覆盖旧边界跨 unknown 观测、重启、合盖/断网后的保留，账号切换后不得复用旧账号边界。覆盖 119 秒不发、120 秒后重新核实才可能发送，及请求结果未知不重复。
- 先用假账号、临时状态、本地假 CLI 验证，不读取/输出真实密钥，不用多次真实消息跑测试。真实端到端只能在原有授权条件同时满足时进行：记录发送前状态、服务接受结果、发送后新窗口时钟证据；当前 active 窗口随便发一句不能证明“启动新窗口”。
- 构建并适当部署，保留配置、暂停和任务状态，核对安装产物一致、单实例、后台日志更新与无残留进程。不要为了展示成功改写运行数据库。

最终准确报告：已修复什么、读到哪些额度、为什么允许/阻止发送、是否真实接受、是否确认新窗口。没有真实到期机会时明确未验证，不将测试通过或 daemon running 当作自动激活成功。本轮聚焦 Codex，不顺带改变 Antigravity/Grok 行为或全局配置。
