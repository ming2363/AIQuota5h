# AIQuota5h 第四轮复核

日期：2026-10-17。结论：**上轮主要问题已有实质修复，但仍不能通过完整验收。**

## 已通过的检查

- `npm test`：51/51 通过，TypeScript 构建成功。
- LaunchAgent `com.zhangming.aiquota5h` 处于 running，PID 8261，runs=1；本轮只读核对时，安装目录的 JavaScript 与 `dist/src` 一致。
- Codex、Antigravity 已启动进程后的不确定错误改为 unknown；引擎只允许明确未启动的 not_sent 回到可重试状态。原先可能重复发送的复现路径已修。
- 相同额度事实不再无意义增加代次；明确未发送的 stale_authorization 可恢复；真实 active、身份或费用变化仍会作废旧授权。
- 生产读取工厂已贯穿 AbortSignal，Codex RPC、Antigravity CLI/language server、Grok 完整响应体均已接通取消。原先丢信号和只约束响应头的问题已修。
- 主锁元数据通过完整临时文件加 hard link 原子公开，原先空文件初始化窗口已修；死门闩可以顺序恢复。

本轮使用源码阅读、现有测试、内存 SQLite、假发送、临时进程和临时锁目录；没有发送真实消息，没有更改业务源码、运行配置或运行状态库。目录没有 Git 仓库和对应 GitNexus 索引，因此本轮是源码与运行行为复核，没有提交 diff 或图谱覆盖。

## 1. [P1] 最终复核暂时缺少模型列表，会永久跳过本周期

位置：[engine.ts:173](/Users/zhangming/Documents/workspace/personal/AIQuota5h/src/engine.ts:173)、[store.ts:423](/Users/zhangming/Documents/workspace/personal/AIQuota5h/src/store.ts:423)、[store.ts:441](/Users/zhangming/Documents/workspace/personal/AIQuota5h/src/store.ts:441)。

真实 Codex 读取在 model/list 失败时会保留额度事实，返回 selectedModel=null、blockReason=model_unknown。此时额度决策仍可能是 send/idle_due。最终复核判断临时故障时主要读取 decision.reason，而 model_unknown 也不匹配 blockReason 的临时错误正则，于是保存为 skipped/idle_due。

同一窗口已有唯一任务；后续模型列表恢复，领取逻辑只接受 pending 或符合条件的 deferred，不能重新领取这个 skipped。即使只将它改成 deferred，也还需修正错误类别和可恢复类别之间的对应关系。

本轮通过真实 Engine/Store、内存 SQLite 和假读取/发送独立复现：

```text
模型列表暂时失败：sends=0,status=skipped,error=idle_due
60秒后同窗口模型恢复：sends=0,status=skipped,attempts=1
```

应优先记录实际阻塞原因，为已确定未发送的暂时模型目录失败保留有界恢复路径。恢复后必须重新确认窗口、账号、费用和模型；不能把所有 skipped 或 unknown_result 一概变为可重试。

## 2. [P2] 强制终止只杀父进程，顽固子孙进程仍能占住读取

位置：[proc.ts:147](/Users/zhangming/Documents/workspace/personal/AIQuota5h/src/proc.ts:147)。

killTree 首先向所属进程组发 SIGTERM，但 1.5 秒后的 SIGKILL 仅发给 child 本身。子孙进程如果忽略 SIGTERM 并持有继承的 stdout/stderr，父进程退出后仍会阻止 close，runCommand 继续等待，读取槽和临时进程无法按截止时间清理。

本轮纯本地进程复现：命令期限 300ms，子孙进程忽略 SIGTERM、持有输出管道，直到约 2.5 秒才自行退出；runCommand 约 2598ms 才结束。该子孙进程若不自行退出，就没有可靠完成期限。现有测试覆盖配合退出的进程，没有覆盖这一情形。

应让升级强杀覆盖本次调用拥有的进程组，并验证超时、外部取消时都没有残留进程或管道持有者；处理好退出和清理竞争，不能误伤无关进程，也不能只让上层 Promise 提前返回而遗留 I/O。

## 3. [P2] 并发回收死门闩，仍可能让两个实例同时持有主锁

位置：[lock.ts:107](/Users/zhangming/Documents/workspace/personal/AIQuota5h/src/lock.ts:107)。

recoverDeadGate 读出死门闩属主后直接 rename 路径，不能保证路径仍然指向刚才观察到的记录。另一进程可能已经恢复门闩并持有新活门闩，随后被这个旧回收者移走。主锁的回收又依赖门闩互斥，因而其正确性仍会被破坏。

确定的双进程交错复现：预置死主锁和死门闩；A 读死门闩后暂停；B 回收并持新门闩，在重新读死主锁后暂停；A 恢复执行，移走 B 的活门闩并取得自己的门闩；两者最终都取得主锁。

```text
results=[{mode:"A",result:"acquired"},{mode:"B",result:"acquired"}]
```

这是并发恢复死门闩的问题，区别于已经修复的空主锁发布和普通主锁替换交错。需要具有可靠跨进程所有权和崩溃恢复语义的方案，不能继续把同一个 read→rename 竞争挪到下一层门闩。测试必须覆盖上述可控交错及回收者异常退出。

## 仍未完成或未实测的产品能力

- Antigravity 三个池在实际状态库中仍全部被 `agy 帮助缺少调用级隔离参数：plugins、mcp、hooks` 阻止发送。安全阻止合理，但真实自动激活仍未完成，不能以增加 mock 测试替代。
- 本轮只读查询任务总数为 0；没有 Codex/Antigravity 在符合条件时“短消息被接受→新窗口确认”的真实证据。合盖唤醒补执行和真实跨周也未实测。不得为了补验收证据越过窗口、账号、费用或隔离条件。
- Grok 已确认按固定周日程自动恢复的池继续只监控，不列为缺陷。

下一轮执行正文见 [REPAIR_PROMPT_ROUND4.md](/Users/zhangming/Documents/workspace/personal/AIQuota5h/REPAIR_PROMPT_ROUND4.md)。
