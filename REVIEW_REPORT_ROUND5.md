# AIQuota5h 第五轮复核

日期：2026-10-17。结论：**第四轮多项修复有效，仍有两项确定缺陷；Antigravity真实自动激活尚未完成。**

## 验证结果

- 本轮实际运行 `npm test`：57/57通过，TypeScript构建成功。ACCEPTANCE_REPORT.md目前写55项，早于本次测试结果。
- LaunchAgent运行中，PID 24694，runs=1，未退出；安装目录JavaScript与重新构建的`dist/src`一致。
- 运行状态库只读检查：任务总数0；Codex无阻塞；Antigravity三池均因缺少plugins/MCP/hooks调用级隔离参数而阻塞；Grok费用为billing_safety_unknown且block_reason为空。
- 第四轮模型目录短暂失败：已改为deferred/model_unknown，恢复可重新核实发送，现有回归通过。
- 第四轮继承输出管道的顽固子孙进程：已增加进程组SIGKILL，现有超时/取消回归通过；仍有下述不继承管道的遗漏。
- 文件锁及回收门闩已替换为SQLite事务锁，不再有原先read→rename回收路径；跨进程竞争和崩溃恢复回归通过。

本轮只读检查源码与部署，并使用内存SQLite、假发送和临时本地进程验证；临时进程和文件已清理。没有调用真实模型、读取真实密钥、修改业务源码或运行配置/状态。目录仍没有Git仓库及对应GitNexus索引，因此没有提交diff或图谱覆盖。

## 1. [P1] 新增周消息路径绕过所有费用安全限制

位置：[decision.ts:38](/Users/zhangming/Documents/workspace/personal/AIQuota5h/src/decision.ts:38)、[engine.ts:183](/Users/zhangming/Documents/workspace/personal/AIQuota5h/src/engine.ts:183)。实际来源：[grok.ts:73](/Users/zhangming/Documents/workspace/personal/AIQuota5h/src/providers/grok.ts:73)。

auto_reset窗口发生切换且旧边界满120秒时，decide直接返回send/auto_reset_due，并把billingBlocksSend写成false；没有检查该池的billingSafety。引擎最终复核也将auto_reset_due作为subscription_only的替代条件。实际Grok读取明确返回billing_safety_unknown，且记录“未读到Auto Top Up开关”，现在却去掉了发送阻塞。

本轮经真实Engine/Store、假账号、内存SQLite和假发送验证：先观察旧周期结束，再观察新周期，得到：

```text
billing=billing_safety_unknown,sends=1,status=verifying
billing=blocked,sends=1,status=verifying
```

因此该路径不仅接受未知费用，还绕过明确blocked。此缺陷不以“已经产生账单”为前提；它确定违反“不能保证套餐内就不发送”的门槛，存在触发额外费用的风险。现有round4.test及decision.test反而把费用未知时发送写成成功预期，所以57项通过不能证明费用约束仍成立。

另一个需要对齐的范围变化：第四轮提示词明确让固定周恢复池继续只监控，而新实现改为每周发送；README仍写“不发送激活消息”，验收报告、状态文案及适配记录却写用户已接受。当前本对话没有明确新增这一例外。即使另有对周消息的授权，接受一条套餐内消耗也不等于接受未知费用或绕过blocked。

最小修复：所有实际发送统一强制要求subscription_only，decision与最终复核都不能按窗口类型豁免。固定自动恢复池按已确认方案继续只监控；若确有新的明确授权，再实现相应行为，并仍保留费用检查。测试应覆盖unknown、blocked、exhausted及安全套餐状态，不能用放宽断言代替验证。

## 2. [P2] 父进程close后取消强杀，仍可能留下静默子孙进程

位置：[proc.ts:161](/Users/zhangming/Documents/workspace/personal/AIQuota5h/src/proc.ts:161)，关联[proc.ts:27](/Users/zhangming/Documents/workspace/personal/AIQuota5h/src/proc.ts:27)。

killTree新增了400ms后的进程组SIGKILL，但child触发close就清除此定时器。close只证明该ChildProcess及其标准输出管道已关闭，不证明它的整个进程组为空。子孙使用stdio=ignore或自己关闭输出管道时，父进程被SIGTERM结束后即可close；忽略SIGTERM的子孙仍存活，却失去了后续SIGKILL。trackChild也在close时删除该父进程，后续killOwned不再知道这个组。

本轮临时fixture：父进程创建stdio=ignore的子进程；子进程忽略SIGTERM并循环。runCommand设置500ms超时；调用结束后再等900ms，超过400ms宽限，结果：

```text
probe=silent-grandchild-after-grace,timedOut=true,alive=true
```

复现后已主动清理这个临时子进程，没有遗留。现有回归让子孙继承输出管道，close被延迟到子孙死亡，因而未覆盖此分支。

最小修复：以本次调用拥有的进程组是否清理完毕为依据管理升级终止，不能仅因父进程close取消。防止误伤无关进程；超时、取消和daemon退出都应等待有限清理完成，不能让退出丢弃尚未执行的清理定时器。新增不继承管道、父先退出、顽固子孙的回归，并核对没有残留进程。

## 仍未完成与未实测项

- Antigravity三个池仍被`agy 帮助缺少调用级隔离参数：plugins、mcp、hooks`阻止。当前没有可用的真实自动发送路径，仍不能验收这一目标。
- Codex/Antigravity没有“符合条件的真实短消息被接受→新窗口确认”的端到端证据；真实合盖唤醒、跨五小时及跨周仍未观察。无需为补证据绕过发送条件或消耗额度。

交给执行AI的正文：[REPAIR_PROMPT_ROUND5.md](/Users/zhangming/Documents/workspace/personal/AIQuota5h/REPAIR_PROMPT_ROUND5.md)。
