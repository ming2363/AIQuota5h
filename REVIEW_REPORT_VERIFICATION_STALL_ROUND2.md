# Codex 验证关联修复再次复核

日期：2026-10-19。结论：上轮两项复现通过，本轮未发现新增可复现缺陷。77/77 测试通过，构建成功、安装产物一致。结论限于代码与本地验证，修复后的新一轮真实自动激活和跨周期恢复仍未再次验收。

## 修复核查

- laterPeriodProven 不再依赖 windowId 改变或旧边界轻微增加。新结束时间必须在请求领取之后，推算的已结束周期起点不能早于请求（允许有限精度差）；缺少请求时间不自动放行。
- confirmsTask 对启动时间增加请求时间下界，排除请求前五分钟已经启动的窗口；对已知 unknown 发送结果不标 confirmed，保留启动时间上界。
- Engine 验证与 Store 领取继续共享周期判据，保留同周期未决请求不重发，以及被证明结束后新周期可处理的正向路径。
- ACCEPTANCE_REPORT.md 已更新为 77 项及真实历史限制，没有继续把旧 confirmed 作为昨晚请求启动成功的证据。

## 验证结果

运行 npm test，77/77 通过，包括实际 Engine/Store 的一秒和数秒边界校正、重命名窗口、重复快照及重启不重发，发送前启动不确认，真正新周期能够处理。

独立调用编译后生产判据得到：

```json
{"probe":"old-defects-recheck","oneSecondCorrectionReleases":false,"windowBeforeRequestConfirmed":false}
{"probe":"positive-cycle-and-confirmation","newPeriodReleases":true,"validNewWindowConfirms":true,"unknownMessageConfirms":false}
```

该验证只使用本地假数据，没有访问真实认证、网络或模型。构建后再次比较安装 app 全部 JS 与 dist/src，无差异。

## 实际后台状态

约 13:07 +08 的只读检查：

- LaunchAgent running，PID 46798，runs=1，last exit code=(never exited)，暂停值 0。
- Codex 最新快照 13:07:01，费用 subscription_only，无 block_reason。五小时和周窗口均 active；五小时 reset=2026-10-19 17:37:10 +08，周 reset=2026-10-25 09:22:43 +08。
- 任务总记录仍为原两条，均保留历史 confirmed；当前 in_flight/verifying/unknown_result/stalled 数量为 0，没有旧验证任务正在阻塞。
- 任务 2 的旧 confirmed 更新时间仍是 12:38:28，detail 是旧式“窗口已变为 active”，没有被本轮修改。这个字段不能证明 10 月 18 日 19:38 的请求导致 10 月 19 日 12:37 的窗口启动；验收报告对此已如实审计并保留原记录。

## 仍待真实验收

当前 active 窗口不是本轮新验证器的真实验收。需要在以后真实符合到期、两分钟宽限、身份/套餐余量/费用安全和未启动证据的情况下，检查新任务发送、模型完成、对应窗口确认及后续周期恢复。没有为补证据主动发送消息。

合盖/离线跨周期和其他平台能力限制仍未在本轮解决或实测。本轮没有新增已确认代码缺陷，因此不新增业务修复提示词；也没有未经授权更改旧任务的历史结论。

仅新增本报告，未修改业务源码、运行配置或任务，未重启服务、发送真实消息或执行 Git 写操作。npm test 重建 dist。目录没有 .git，本轮是源码/调用链与本地验证复核，不是基于固定提交差异的审查。
