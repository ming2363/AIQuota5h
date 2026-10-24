# Codex 验证阻塞修复专项复核

日期：2026-10-19。结论：75/75 测试通过、构建成功、部署一致；已有卡住状态、完成事件区分和跨周期处理，但周期关联判据仍有两处已复现缺陷，需要修复后再验收。

## 实际状态

- 约 12:55 +08，LaunchAgent running，PID 41657，runs=1，持续读取 Codex 额度。
- Codex 五小时和周窗口 active，费用 subscription_only，无 block_reason。五小时 reset 为 2026-10-19 17:37:10 +08，即该窗口约在当天 12:37 开始。
- 旧任务 2（10 月 18 日 19:38 发送）在 10 月 19 日 12:38:28 被写为 confirmed，detail 仍为“窗口已变为 active”。因此当前已经没有那个 verifying 阻塞，但不能据此证明昨晚请求启动成功：这个当前窗口比旧请求晚约 17 小时。现有 confirmed 是历史记录，不会被新验证器重新审查；本轮没有修改它。
- 验收文档仍是上一轮 72 项测试及旧状态，未更新本次 75 项测试与验证逻辑，不能用作本次交付证据。

## 改进已生效

- 只有 thread.started 不再直接标 accepted；发送器区分模型完成及用量摘要。
- 长期未确认可标 stalled/verify_unresolved，状态和日志显示阻塞任务，避免把决策输出伪装成已发送。
- 增加确认窗口的时间检查及新周期解除旧占用的路径，保留未知请求不盲重发的意图。

## 需要修复

### 1. [P2] 边界校正 1 秒就释放未知请求，导致同周期重复发送

位置：`src/verify.ts:10–19`；调用者 `Engine.verifyPool`、`Engine.blockingTask`、`Store.blocksClaim`。

laterPeriodProven 只检查新 oldEndedAt 比旧值大、windowId 不同且时间已过，没有要求这个边界对应请求之后的真实新周期。服务端时间修正、秒精度差异就可能被提升为跨周期证明。状态随即变成 stalled/period_unconfirmed 并永久解除池占用。

独立验证贯穿 mapCodexPools、Engine、内存 Store 与假发送：先对明确过去的 reset 派发一个 outcome=unknown 请求；30 秒后只把同一过去 reset 校正 1000 ms。这个“新结束时间”仍比首次发送早近 3 分钟，却被判 laterPeriodProven=true，Engine 随即再次派发。

```json
{"probe":"one-second-boundary-correction","oldBoundary":1799999820000,"claimedAt":1800000000000,"correctedBoundary":1799999821000,"boundaryStillBeforeSend":true,"laterPeriodProven":true}
{"probe":"same-period-unresolved-resend","sends":2,"tasks":[{"status":"stalled","error":"period_unconfirmed","oldEnd":1799999820000},{"status":"unknown_result","error":"unknown_result","oldEnd":1799999821000}]}
```

不存在实际新周期的输入就能触发重复，是释放条件缺陷；没有真实模型调用。现有跨周期测试把边界直接推进五小时，漏掉小幅校正和发生在请求前的边界。

应基于可信的周期身份/生命周期及发送时间关联证明新周期，不能用时间单调增加或 windowId 改变替代。Engine 和 Store 必须共享同一严格判据；保留真正新周期能继续运行的正向路径。

### 2. [P2] 确认检查缺少发送时间下界，可把发送前已启动的窗口算作该请求成功

位置：`src/verify.ts:22–33`；`src/engine.ts:461–464`。

confirmsTask 只要求 startedAt 不早于旧结束时间太多、且不晚于 claimedAt 后 30 分钟，没有排除 startedAt 早于请求。窗口在旧边界后、请求发出前已经启动，仍可返回 true。

独立调用生产 confirmsTask：旧边界=1800000000000；窗口 startedAt=1800000300000；请求 claimedAt=1800000600000，即窗口提前 5 分钟启动，结果 confirmsTask=true。这不能证明目标窗口在本次发送后启动。现有负向测试只覆盖发送后两小时的手动窗口，漏掉请求之前的窗口和更近时间范围内的无关启动。

修复应记录/使用足够精确的实际发送及完成时间、发送前后窗口身份与已知状态，约束必要的双向时间关系。只能证明“看到了 active”而不能关联原请求时，不应宣称本次请求已确认成功。历史上已被旧逻辑写为 confirmed 的不相符记录也应只读审计，提出有依据的处置方案；不要未经确认直接清理或改写运行数据。

## 验证范围

本轮运行 npm test（75 项通过），并独立使用假账号、内存数据库、临时目录和假发送验证上述缺陷。临时资源已清理，没有真实认证或网络调用。安装文件在构建后再次核对一致。

仅新增本报告与修复提示词，没有修改业务源码、运行配置或任务，没有重启服务、发送真实消息或执行 Git 写操作。npm test 重建 dist。当前记录被标 confirmed 不等于本轮完成了真实自动激活验收；后续周期、睡眠恢复和其他平台能力仍须分别验证。
