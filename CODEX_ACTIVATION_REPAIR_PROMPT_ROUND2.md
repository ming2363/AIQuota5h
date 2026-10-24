# Codex 自动激活第二轮修复提示词

请将以下正文交给执行 AI，同时提供 REVIEW_REPORT_CODEX_ACTIVATION.md。

---

继续修复 `/Users/zhangming/Documents/workspace/personal/AIQuota5h`，先读 REVIEW_REPORT_CODEX_ACTIVATION.md、既定需求和 AGENTS 规则。当前 67 项测试通过、部署一致，生产历史已接入且周 0% 余量处理已改进，但仍有两处误判。先修复再报告验收，不扩展其他平台行为。

禁止 Git 初始化、git add/commit/push/merge/rebase、标签、PR 等 Git 写操作，保持业务改动未暂存。使用子代理时明确重复此禁令。不确定的需求、费用、配置和范围先确认；可以继续独立的只读调查。

## 一、不能把保存旧边界等同于证明新窗口没启动

decision.ts:225–231 只要 prior.resetAt 已过、新 reset 后移、用量没有正值，就返回 idle；即使 prior.state=unknown、旧窗口从未被证明启动过也会如此。engine.ts:137–141 同样会把 unknown+resetMoved 转 idle。

本地真实生产链路已复现：初始 0%+未来 reset 被正确判 unknown；这个候选时间过去后给另一个 0%+未来 reset，最终 idle、sends=1、verifying。程序从 unknown 的候选时间制造了可信旧边界。

另一个必须覆盖的输入：旧窗口确实 active 并到期，用户已经启动新窗口，但新窗口第一次可见用量因取整/延迟仍为 0%，reset 已变到未来。当前也会 idle 并发送。same_reset_prior_active 只覆盖“新窗口先观察到 active，后来变 0%”，不能覆盖第一次新窗口观测就为零。因此仅补 prior.state=active 不是完整修复。

请分开保留可信旧窗口结束证据与判定新窗口未启动的证据，调查实际接口的时钟/使用证据，用连续观测或其他同账号可靠记录验证。不能只凭 future reset+0%（即使存在旧边界）宣布 idle，也不能为了让测试成功删除 unknown 保护。证据不足时保留历史并继续核实；不伪造过去边界、不改时钟或运行数据库。需要新策略/配置/用户授权时先提出具体问题。

修复 classifyWindow 和 Engine 的补充分支，确保后者不会再次将前者有意保留的 unknown 强制升级为 idle。调整已有成功测试：真正可发的场景必须提供有效的未启动证据，而不只是重新断言一次后移时间等于 idle。

## 二、历史必须按账号和额度池隔离

Store.windowPriors 丢掉 poolId；readCodex 只过滤账号；mapCodexPools 在每个 limitId 中都只按 key 找历史。两个池都有 5h/weekly 时，后一个池会使用前一个池的 reset/state。

独立映射复现：过去两个池 codex、codex_other 均 active；主池的旧边界现在已过，other 的边界仍在未来。other 当前相同 reset、用量取整为 0，使用自身 prior 应保持 active；使用生产混合 priors 却得到 idle 并借用了主池旧边界。

请在历史类型、Store、读取工厂/适配器和映射匹配中保留并使用 provider/account/pool/window 身份。不要靠数组顺序或仅 key/account 关联。保证账号切换与池增删时也不串用历史。

## 验证和交付

- 使用生产读取工厂/映射、真实 Store 与 Engine，加本地假 CLI/假发送验证，不只手工拼一个理想 WindowFact。
- 覆盖：从未证明 active 的零用量候选时间过去后不误发；用户新窗口初始 0% 且 reset 稳定时不误发；真正证明未启动的窗口旧边界满 120 秒后只发一次；119 秒不发；同账号多池不同边界与顺序反转不串历史；未知/耗尽额度和未知费用仍不发。
- 保留历史跨 unknown/重启/合盖/断网、同 reset 的取整、未知发送结果不重发、暂停/退出/监听器/进程组清理和单实例锁的已有修复。
- 全部故障验证使用假账号、临时状态、临时进程，不输出真实密钥，不发送真实消息；fixture 在 finally 清理。不要改写当前状态来制造成功。
- 构建并运行适当回归。部署保留配置、暂停、任务与状态，核对实际文件一致和单实例。真实接受/新窗口确认只有在既定条件满足的真实机会出现时验收；当前 active 窗口再发一句不能证明自动启动新周期。
- 更新验收记录，明确已修什么、哪些只是本地模拟、是否真正自动启动新窗口。不要以测试数或 running PID 宣称完整产品已经可用。
