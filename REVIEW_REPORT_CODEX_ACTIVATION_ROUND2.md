# Codex 自动激活第三次专项复核

日期：2026-10-18。结论：69/69 测试通过、构建成功、部署一致；上次的跨池历史串用与单次零用量快照误判已修复。但发送前仍会无条件沿用历史 idle，存在一处已复现的误发路径，需要继续修复。

## 已验证的修复

- Store 历史增加 accountId/poolId/observedAt，映射按账号、池和窗口匹配。原多池案例现在保持 codex_other=active，没有借用主池边界。
- 旧 active 到期后的第一次 future reset+0% 现在保持 unknown，并独立保留可信旧结束时间，不再立即发送。
- 从未证明 active 的候选时间不再因一次时间后移就成为可信旧边界。
- 新增滑动时钟采样和对应正/负向回归；已有退出、监听器、费用保护等回归仍通过。

独立重跑上轮映射案例的输出：主池 unknown/oldEndedAt=null/preservedBoundary=1799999820000；另一池 active/oldEndedAt=null/preservedBoundary=null。

## [P2] 最终复核无条件继承 idle，漏掉用户在采样后启动新窗口

位置：`src/decision.ts:243–246`。相关链路：滑动分支 `src/decision.ts:248–253`、Store.windowPriors、Engine.sendOnce 的最终读取。

只要 prior.state=idle 且有 trustedEnd，这个分支立即返回 idle，证据写为 prior_idle_uncontradicted，位于 newWindowClock 的采样判断之前。上一次证明未启动，不代表发送前仍未启动。用户可以在两者之间发消息，新窗口用量仍取整/延迟为 0%；最终读取虽然拿到新的 reset，却不再判断时钟有没有变为锚定。

另外，首次滑动识别返回的 resetAt 为 null，随后存储覆盖 reset_at，原始采样时间值丢失。简单删除上述提前返回，可能又导致正常最终读取无法比较样本、持续 unknown 而永远不发送。应把可信旧边界、原始时钟样本和当前启动状态分开维护，做到真正重新核实，而非缓存 idle 或永久阻塞。

独立离线复现走实际 createProviderRead → mapCodexPools → Engine → Store，内存库、假账号、假发送：

1. 先记录正使用量且 reset 在未来的 active。
2. 旧 reset 后 30 秒，零用量新 reset 的首次观测为 unknown，保留旧结束时间。
3. 旧 reset 后 180 秒，再次观测 reset 随墙钟移动，正确判 idle，开始发送流程。
4. 第一次账号复核期间模拟用户已启动：推进本地模拟时间 10 秒，将新窗口 reset 固定为启动时刻后五小时，用量暂为 0%。
5. 最终实际读取返回 state=idle、证据 prior_idle_uncontradicted，假发送仍被调用，任务进入 verifying。

关键输出：`{"probe":"manual-start-after-proven-idle","sends":1,"taskStatus":"verifying"}`。最后一次读的 manual=true、state=idle，evidence 包含 used_percent_zero_not_proof、remaining_full_not_proof、prior_idle_uncontradicted。manual 是 fixture 的场景标记，不是服务器字段；这是对相应配额输入及交错时序的本地验证，没有真实手动调用模型。

现有测试覆盖“采样前用户已启动且零用量时间稳定”和“发送后用量变正”，没有覆盖“已采样 idle、最终复核前用户启动且暂时为 0%”。需要补上该交错回归，同时保留真正仍未启动时可以发送的正向验证。

## 实际运行与验收范围

- LaunchAgent running，PID 27996，runs=1，last exit code=(never exited)。安装 app 全部 JS 与本次 dist/src 一致。
- 本轮约 10:11 +08 快照：Codex 五小时和周窗口均 active，费用 subscription_only，无 block_reason。五小时 reset 为 2026-10-18 14:22:43 +08，周 reset 为 2026-10-25 09:22:43 +08。Codex 任务数 0，仍无程序自动激活成功记录。
- 未实测真实发送接受、自动启动新窗口、跨周期及合盖恢复；Antigravity/Grok 的既有能力限制没有因这次修复解决。

本轮仅新增报告和提示词，未改业务源码、运行配置或状态，未重启真实服务、未发送真实消息、未执行 Git 写操作。临时目录及内存数据库已清理。npm test 重新生成 dist。结论来自本地源码/调用链、回归和独立模拟，不等同于真实服务端验收。
