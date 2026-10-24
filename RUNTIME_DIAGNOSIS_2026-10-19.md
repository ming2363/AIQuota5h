# 2026-10-19 后台运行与 Codex 激活阻塞调查

检查时间：2026-10-19 12:37–12:40，Asia/Kuala_Lumpur（UTC+08）。结论：后台进程正常运行、持续读取额度；Codex 后续激活被一个长期 verifying 任务挡住，不是服务没有启动。

## 真实运行证据

- LaunchAgent running，PID 55688，父进程 1，runs=1，last exit code=(never exited)。进程已存在约 25 小时，未暂停。
- Codex 最近一次读取为 2026-10-19 12:36:26 +08，日志持续更新；launchd stderr/stdout 均为空。
- 当前五小时窗口 idle、套餐额度 allowed、费用 subscription_only；可信旧边界为 2026-10-18 19:24:56 +08，计划时间为当日 19:26:56 +08。当前 reset 随查询移动，证据 resampled_reset_still_slides。周窗口 active、有剩余。
- 日志反复输出 codex send:idle_due，但这个日志在领取任务前输出，不代表真的发送。

## 两次真实任务记录

| 任务 | 领取时间（+08） | 当前结果 |
| --- | --- | --- |
| 1 | 10 月 18 日 14:24:45 | message_result=accepted；14:32:16 更新为 confirmed，window_result=active |
| 2 | 10 月 18 日 19:38:35 | 19:38:50 更新为 accepted/verifying，phase=spawned；之后约 17 小时未更新，window_result 为空 |

第一次已有程序发送及后续 active 的真实记录，不能再沿用前一天“任务为 0、未发送”的旧结论。第二次已被发送器标记接受，但窗口启动效果没有确认。

## 根因与证据边界

Store.claim 对同 provider/account/pool 查询 in_flight、verifying、unknown_result，任一个存在就直接返回空。Engine.verifyOutstanding 只在对应窗口 state=active 时改为 confirmed；没有处理长期未确认、整个周期可能在睡眠/离线期间过去、或验证证据不足时的后续状态与诊断。因此任务 2 一直占据整个 Codex 池，新候选任务无法领取。重启仍会保留可能已发出的任务，不能作为解除阻塞的修复。

当前不能判定第二条消息一定没有启动过窗口：零用量可能取整、状态读取有间隔，窗口也可能在观察间隔内启动并结束。日志在发送后曾出现 activation_unproven，数小时后恢复 idle_due；现有记录不足以恢复完整时钟过程。

任务只保留 sessionId 与“Codex 接受了本次短消息”等概括信息，没有保留可核验的完成事件/用量证据。按这两个 sessionId 只读查询本机 Codex threads/logs，没有找到对应条目，因而不能从本地会话补证；该缺失本身也不能证明请求失败。sendCodex 当前将 turn.completed 或 thread.started 加退出码 0 都算 accepted，不能把这个状态等同于模型确实完成且目标窗口启动。

另外，当前 verifier 只检查任意最新 active，不验证它与原任务的周期/时间关联；用户之后手动启动也可能使旧任务被笼统标 confirmed。修复应记录足够的脱敏生命周期证据并核实关联。

## 修复方向

应修复发送结果证据和验证状态机：显示卡住任务及原因，区分会话创建、模型完成、额度时钟启动；为已接受但未确认的请求提供有界核查和跨周期处理。没有证据时不得简单把任务改成 not_sent 重发，也不能让旧任务无期限冻结后续独立且被证明安全的新周期。若现有证据不足以安全处理当前任务，先向用户说明具体可选动作及重复发送风险，再确认操作。

本轮仅检查进程、只读 SQLite、日志和源码，并新增调查文档与修复提示词。未修改业务源码、运行配置或任务，未重启服务、未发送消息、未执行 Git 写操作。没有重新运行 npm test；本次结论来自真实运行记录与代码路径，不以旧模拟测试替代真实验收。
