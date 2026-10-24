# Codex 自动激活第四次专项复核

日期：2026-10-18。结论：70/70 测试通过、构建成功、部署一致，但上一轮 idle 最终复核修复仍缺少短采样间隔的保护，不能完全验收通过。

## 已修复部分

不再无条件沿用历史 idle；滑动判定会保留 reset 样本，最终读取增加时间差比较。10 秒间隔且 reset 不再移动的负向回归通过。此前跨池历史隔离、首次零用量不强行判 idle、可信旧边界保留及其他回归没有发现回退。

## [P2] 采样间隔不大于误差容限时，静止时钟仍会被证明为滑动

位置：`src/decision.ts:244–249`。prior idle 的复核使用 `wall>=0 && abs(resetDelta-wall)<=2000` 判滑动，没有最小时间间隔，也没有要求 resetDelta>0。若两次读取相隔不超过 2 秒，即使 resetDelta=0，条件仍为真。

因此用户在已证明 idle 之后启动新窗口、用量暂时为 0%，最终读取很快返回同一个固定 reset 时，程序会给出 resampled_reset_still_slides 并发送。实际最终读取可能很快，代码没有保证等待足够间隔。这里应判“样本不足/不能证明仍滑动”，不能把容差内的静止当成肯定的滑动证据。

独立验证贯穿实际 createProviderRead、mapCodexPools、Engine、内存 Store 与假发送：先记录 active，旧窗口到期后第一次零用量为 unknown，再用间隔样本证明 idle；账号复核阶段模拟新窗口时钟已固定且暂为 0%，分别给定不同复核时间差。结果如下：

| 采样间隔 | reset 增量 | 最终分类 | 假发送次数 |
| --- | --- | --- | --- |
| 0 ms | 0 ms | idle / resampled_reset_still_slides | 1 |
| 1000 ms | 0 ms | idle / resampled_reset_still_slides | 1 |
| 2000 ms | 0 ms | idle / resampled_reset_still_slides | 1 |
| 3000 ms | 0 ms | unknown / resampled_reset_no_longer_slides | 0 |
| 10000 ms | 0 ms | unknown / resampled_reset_no_longer_slides | 0 |

这验证的是配额快照输入及交错时序，不是对真实服务端进行了用户启动实验。没有访问真实认证、网络或模型。临时目录和内存库已清理。

现有新增负向测试在账号检查时将模拟时间推进 10000 ms，所以只能覆盖表格最后一项。正向测试的最终读取没有推进模拟时间，却把零间隔当成可以发送，掩盖了真实样本不足的情况。

建议统一采用与精度相容的最小采样间隔和正增量检查（现有 clockFromSamples 已有最少 5000 ms 的约束），同时让生产最终复核有足够间隔的真实样本。不能只改成 unknown 而使正常未启动的窗口永远过不了最终复核；应有界等待/延后复核，并保留未发送任务可恢复的状态。

## 实际运行与限制

- LaunchAgent running，PID 32288，runs=1，last exit code=(never exited)。安装 app 全部 JS 与本次 dist/src 相同。
- 本轮约 10:51 +08 的快照：Codex 五小时和周窗口 active，费用 subscription_only，无阻塞原因。五小时 reset 为 2026-10-18 14:22:43 +08，周 reset 为 2026-10-25 09:22:43 +08。发送任务数仍为 0。
- 尚无真实消息接受、自动新窗口启动、跨周期或合盖恢复的验收证据；其他平台既有限制仍在。

本轮仅新增审查报告及修复提示词；未改业务源码、运行配置或状态，未重启真实服务、未发送真实消息、未执行 Git 写操作。npm test 重新生成 dist。结论限于源码、70 项回归、独立本地验证及只读部署检查。
