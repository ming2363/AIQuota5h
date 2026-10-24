# AIQuota5h 第三轮复核

日期：2026-10-17。结论：**前轮多项已修，但仍不能通过完整验收。**

## 已验证的进展

- `npm test`：38/38 通过，构建成功。
- 后台 LaunchAgent 处于 running，PID 96841、runs=1；运行中的 JavaScript 与重新构建的 dist/src 一致。
- 第二次账号检查后已检查池代次，上轮“观察到 active 还继续发送”的原复现路径已阻止。
- 最终复核与普通刷新共享读取，原先重复读取和普通 Retry-After 绕过的路径已修。
- 暂停、最终读取断网等已增加 deferred 和恢复逻辑，正常测试路径可恢复。
- Antigravity 的 Remaining 24/76/0/100 解析已更正，身份未知阻塞、三类隔离开关精确匹配及实际 CLI 身份复核已加入。
- Antigravity 增加了短暂启动自有 language_server 获取精确额度的尝试；未退出用户 App 做真实验证。
- 锁回收增加门闩与旧令牌重查，上轮特定的“读出旧死锁后误删新活锁”复现路径已阻止。

本轮检查使用源码阅读、测试、内存 SQLite、假发送、临时假 CLI 与临时锁路径。没有发送真实消息，没有改运行中的状态、配置或业务代码。当前仍无 Git 仓库及对应 GitNexus 索引，没有提交 diff、图谱或 taint 覆盖。

## 1. [P1] 可能已送达的消息被当成未发送，随后自动重试

位置：[codex.ts:342](src/providers/codex.ts#L342)、[antigravity.ts:339](src/providers/antigravity.ts#L339)、[engine.ts:195](src/engine.ts#L195)。

Codex 在进程非零退出、没有 stdout 时返回 `not_sent, started:true`；Antigravity 在没有解析到 conversationId 的错误退出时也如此。没有 stdout/会话 ID 不证明服务端没有接收请求。

本轮 engine 将任何 not_sent 都改成 deferred，并把 phase 退回 claimed，所以后续可以再次派发。

验证：临时假 CLI 对 --help 返回成功；真正运行时先写本地“已收到请求”标记，再输出连接失败到 stderr、空 stdout 并退出 1，发送器返回 not_sent+started:true。另以假发送串联 engine，60 秒后再次观察同一 idle 窗口，得到 `possibleDeliveries=2,status=deferred,phase=claimed`。

这违反“结果不明先核实，不盲重发”。应仅在明确实际消息进程未启动，或有可靠证据证明请求前拒绝时允许 not_sent；可能已提交则记 unknown_result，保留阶段/会话信息，先核实，不能降级回 claimed。

现有测试覆盖 outcome=unknown，却没有覆盖真实发送器把不确定错误错误归为 not_sent 的组合。

## 2. [P1] 相同的正常刷新也能让待发送任务永久卡住

位置：[engine.ts:180](src/engine.ts#L180)、[store.ts:418](src/store.ts#L418)，关联 store.ts:249–251。

代次检查安全取消时使用 deferred+stale_authorization，但可恢复类别列表没有 stale_authorization。与此同时，每次保存池快照都增加代次，即使窗口、账号和费用事实完全没变。

验证：第二次账号检查等待期间 observe 同一个到期 idle 快照，然后放行。任务未发送，变成 stale_authorization。一分钟后再次观察同一可发送状态，仍然 `sends=0,status=deferred,error=stale_authorization,attempts=1`。

应区分影响发送授权的语义变化与普通观测时间变化。明确未发送的授权失效任务，要能重新核实后安全领取；不能永久卡住，也不能简单加入白名单后不停撤销、重领。

## 3. [P1] 超时取消未接通，平台读取可能永久占住

位置：[cli.ts:47](src/cli.ts#L47)、[cli.ts:97](src/cli.ts#L97)、[engine.ts:260](src/engine.ts#L260)、[grok.ts:137](src/providers/grok.ts#L137)。

- Engine 会传 signal，但真实装配仍是 `(provider) => readProvider(provider)`，信号被丢弃。readProvider 对 Codex/Antigravity 也未传递信号，相关适配器/RPC/子进程未接通取消。
- Grok 在 fetch 返回响应头时就清掉内部超时并解绑外部 abort，再 await arrayBuffer。响应体停滞时，外部和内部截止时间都不能终止读取。
- readShared 已移除原来的完成期限，只调用 abort；底层不结束就永远保留 reads/inflight。

验证：读取期限设 10ms，40ms 后 `aborted=true,settled=false,reads=1`，wake 仍复用这个未完成任务。另用本地 fetch/auth stub 验证 Grok：headers 已返回、body 停滞，再 abort 外部信号，底层信号仍未取消，结果持续 pending。没有使用真实凭据或网络。

应把取消贯穿真实装配、适配器、RPC/子进程及完整响应体读取，确认所属 I/O 已终止后释放槽位，并有可靠完成期限。不能只 Promise.race 返回，再允许旧操作与新查询重叠。

## 4. [P2] 锁初始化和回收门闩自身仍有故障窗口

位置：[lock.ts:21](src/lock.ts#L21)、[lock.ts:28](src/lock.ts#L28)、[lock.ts:71](src/lock.ts#L71)、[lock.ts:94](src/lock.ts#L94)。

新建锁 open(wx) 成功到写入 PID/令牌之间，文件是空的。另一个进程将其解析为 pid=0 的死锁，回收后也获得锁。临时双进程交错验证：创建空文件后暂停，另一进程回收，最后 `fast=acquired,slow=acquired`。

此外，回收进程在创建 .reclaim 后崩溃会留下没有 PID/恢复协议的门闩。后续回收一直 open(wx) 失败，即使主锁属主已死亡，也持续返回 busy。预置旧死锁及遗留门闩即可复现。

需要覆盖初始化尚未完成、回收进程崩溃、所有权释放整个生命周期。不能用延时或不断增加另一个同样无法恢复的锁来替代可靠互斥。

## 尚未完成的产品能力

Antigravity 在本机仍被 `agy 帮助缺少调用级隔离参数：plugins、mcp、hooks` 阻止发送。这个事实在运行状态库和验收报告中一致。安全阻止是合理的，但自动激活仍然未完成。

Codex、Antigravity 都没有“符合条件的真实短消息被接受 → 新窗口验证成功”的端到端证据。合盖恢复与真实跨周也尚未观察。无需为了测试而越过窗口/费用/隔离条件发消息；应将这些明确列为未验证，不能用38项测试或 running PID 代替。

Grok 已证明固定日程自动恢复的池继续只监控，不列为缺陷。

建议下一轮先集中修复第1–4项，再单独解决 Antigravity 的最小可行发送路径；如果需要用户额外授权，提出具体事项，不再仅以“测试通过、后台运行”交付。执行提示词见 [REPAIR_PROMPT_ROUND3.md](REPAIR_PROMPT_ROUND3.md)。
