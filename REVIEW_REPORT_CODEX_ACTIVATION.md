# Codex 自动激活专项复核

日期：2026-10-18。结论：需要继续修复两处窗口判断问题。67/67 测试通过、构建成功、部署一致，但新增测试把尚未充分证明的窗口转为 idle，因此测试通过不能证明自动激活条件正确。

## 已完成的改进

- daemon 已通过 createProviderRead.priorsFor 接入 Store.windowPriors，readCodex 按账号过滤历史。
- 旧边界增加了跨未知快照的保留处理；同一 reset 曾被证明 active 时，后续 0% 不再直接抹掉 active。
- 周额度 0% 作为明确余量保留，不再一律否决另一个已满足激活条件的目标。周额度耗尽或字段确实缺失仍阻塞。
- 原有退出、监听器、费用检查等回归仍通过。

## 需要修复

### 1. [P2] 仅凭旧候选 reset 过去和新 reset 后移，就把未知窗口判为 idle

位置：`src/decision.ts:225–231`；`src/engine.ts:137–141`。

classifyWindow 直接把 prior.resetAt<=now 作为旧边界，不要求这个 prior 曾经被证明 active。新 reset 在未来、没有正用量且边界存在时就返回 idle。Engine 也有将 unknown 加 resetMoved 转成 idle 的补充分支。这把“旧窗口的结束证据”与“新窗口尚未启动的证据”混在了一起。

两种输入都能走入该路径：

- 初始只有 0% 和未来候选 reset，初始分类为 unknown，从未证明旧窗口启动过。候选时间过去后再次返回 0% 和更晚 reset，被当成有真实旧边界的 idle 并发送。
- 旧窗口确实 active 且到期，但用户已经手动启动新窗口，新窗口初始用量仍取整/延迟为 0%。同样的“新 future reset＋0%”仍被判 idle。保存的旧边界不能单独排除这个情况。same_reset_prior_active 的修复只覆盖新窗口先有正用量、后归零，不能覆盖新窗口第一次观测就为 0%。

独立本地验证走实际 createProviderRead → mapCodexPools → Engine → Store，使用内存数据库、本地临时工作目录、假账号与假发送，没有网络或真实模型调用：

```json
{"probe":"never-proven-active-boundary","initialState":"unknown","finalState":"idle","oldEndedAt":1800000060000,"sends":1,"status":"verifying"}
{"probe":"manual-new-window-rounded-zero","initialState":"active","finalState":"idle","oldEndedAt":1800000060000,"sends":1,"status":"verifying"}
```

第二项验证的是与“手动启动但取整为零”兼容的配额快照输入，不是对真实服务端做了手动启动实验。核心确定事实是：程序没有取得区分两种情况的证据，就已经发送。新增成功测试同样只给一次 reset 后移和 0%，把该输入直接当作安全 idle，所以没有发现这个问题。

修复应保留可信历史，同时另行取得新窗口未启动的证据，例如经过验证的时钟连续采样/可靠使用记录。对来源不明的候选 reset 不应提升为已知旧窗口边界。两个位置都要修复；仅要求 prior.state=active 仍不能解决第二种情况。

### 2. [P2] 历史记录缺少 poolId，Codex 多池会相互借用旧边界

位置：`src/store.ts:287–302`；`src/providers/codex.ts:222`；`src/decision.ts:PriorWindow`。

windowPriors 把同 provider 的全部历史窗口返回为 key/accountId/reset 等字段，却丢掉 poolId。readCodex 只过滤账号；mapCodexPools 在每个 limitId 里都仅 find(key===5h/weekly)。因此同账号有多个池时，都取到列表中第一个池的历史。

独立验证先使用真实映射在同一历史时刻产生两个 active 池：codex 的旧窗口稍后到期，codex_other 的窗口仍在运行。当前 codex_other 返回同一个 reset、用量取整为 0：

```json
{"probe":"cross-pool-mapped-history","historical":[{"pool":"codex","state":"active"},{"pool":"codex_other","state":"active"}],"otherWithMixedPriors":"idle","otherWithOwnPrior":"active","borrowedOldEnd":1799999820000}
```

两个历史 active 都由 mapCodexPools 在 reset 尚未到期时生成，没有直接改写映射结果。只保留 codex_other 自身历史就保持 active；生产形式的混合历史却把它判 idle，证明池隔离缺失。当前真实账号只读到一个 Codex 池，本轮没有观察到真实跨池误发；问题作用于代码已支持的 rateLimitsByLimitId 多池分支。

修复应把 provider/account/pool/window 作为历史匹配维度，不应依赖返回顺序。新增同账号两个池、相同 window key、不同边界以及输入顺序反转的回归。

## 部署与真实能力

- `npm test`：67/67 通过。安装 app 全部 JS 与本次 dist/src 一致。
- LaunchAgent running，PID 19670，runs=1，last exit code=(never exited)。
- 本轮约 09:57 +08 的 Codex 快照：五小时、周窗口均 active，费用 subscription_only，无 block_reason；五小时 reset 仍为 2026-10-18 14:22:43 +08，周 reset 为 2026-10-25 09:22:43 +08。任务数 0，不能归功于本工具自动激活。
- Antigravity 仍缺少调用级隔离，Grok 仍费用未知。没有真实新窗口自动启动或合盖/跨周期验收证据。

本轮仅新增审查报告和修复提示词，没有修改业务源码、运行状态或配置，没有重启真实服务，没有发送真实消息或执行 Git 写操作。独立验证的临时目录和内存数据库已清理。npm test 会重建 dist。目录没有 .git，结论来自源码/调用链和本地验证，不是固定提交差异或图索引审查。
