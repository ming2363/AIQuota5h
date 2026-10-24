# Codex 自动激活第五次专项复核

日期：2026-10-18。结论：上轮短间隔误判修复通过本轮代码及本地运行复核，未发现新增可复现缺陷。不能将此结论扩大为真实自动激活已成功；该端到端验收仍缺少实际证据。

## 修复与回归

- prior idle 分支统一调用 clockFromSamples，不再绕过最小采样要求。间隔至少 5000 ms，reset 有同向正增量且与墙钟增量相符，才证明仍在滑动。
- 最终复核前检查样本年龄，必要时使用可取消的有界等待；不足样本使用 sample_pending 的可恢复处理并限制重试。
- 等待期间暂停、退出及账号变化不发送，退出时未发送任务的恢复回归通过。
- 旧边界保留、池隔离、费用保护、未知发送结果不重发、监听器和进程清理等既有回归仍通过。
- `npm test`：构建成功，72/72 通过。包含 0/1/2 秒固定 reset 不证明滑动、足够间隔固定时钟不发，以及正常滑动等待后可发的正向链路。

## 独立真实墙钟等待验证

使用实际 createProviderRead、mapCodexPools、Engine、内存 Store 和默认 sleep；没有注入推进模拟时间的 sleep。配额与账号为假数据，发送器只记录本地计数，不使用真实 CLI、认证、网络或模型。

两个流程都先记录旧 active，旧窗口结束后建立零用量样本，再以连续滑动证明 idle；发送前分别保持滑动或固定 reset。使用真实墙钟等待，结果：

```json
{"probe":"real-wall-clock-final-sampling","clock":"sliding","elapsedMs":5006,"sends":1,"finalState":"idle","finalEvidence":"resampled_reset_still_slides","status":"verifying"}
{"probe":"real-wall-clock-final-sampling","clock":"fixed","elapsedMs":5010,"sends":0,"finalState":"unknown","finalEvidence":"resampled_reset_no_longer_slides","status":"skipped"}
```

这确认正常路径能在实际等待约五秒后继续，而非永久 unknown；固定时钟也不会因短间隔容差被放行。此处 verifying 只是本地假发送接受后的任务状态，不是真实服务端接受证据。临时目录及内存数据库已清理。

## 部署与当前真实状态

- LaunchAgent running，PID 55688，runs=1，last exit code=(never exited)。本轮未停止或重启真实服务。
- 安装 app 全部 JS 与本次 dist/src 一致。
- 本轮约 11:38 +08 快照：Codex subscription_only，无 block_reason，五小时和周窗口均 active。五小时 reset 为 2026-10-18 14:22:43 +08，周 reset 为 2026-10-25 09:22:43 +08。Codex 任务数仍为 0，没有程序真实自动发送记录。

## 仍待验收

必须在真实旧窗口到期、旧边界满 120 秒、当前仍未启动、身份/套餐余量/费用安全均成立时，观察实际任务领取、消息被接受，以及新窗口启动的服务端证据。当前窗口 active 或本地假发送成功不能替代这些证据。

真实合盖恢复、跨五小时、跨周和长期资源稳定性没有在本轮实测。Antigravity 缺少调用级隔离、Grok 费用未知的既有限制仍未解决，因此三平台完整目标尚未验收完成。

本轮仅新增本报告，没有新的已确认代码缺陷，因此不新增业务修复提示词。未修改业务源码、运行配置或状态，未发送真实消息、未执行 Git 写操作；npm test 会重新生成 dist。结论限于本轮源码/调用链、72 项回归、独立本地等待验证及只读部署检查。
