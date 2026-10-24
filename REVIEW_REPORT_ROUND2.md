# AIQuota5h 第二轮复核

日期：2026-10-17。结论：**已有实质修复，但仍未达到自动激活工具的完整验收条件。**

## 本轮验证范围

- 重新阅读实现、回归测试及修复后 ACCEPTANCE_REPORT.md。
- `npm test`：34/34 通过，构建成功。
- 只读检查 LaunchAgent：running，PID 83514，runs=1；当时任务表为空，Antigravity 仍被隔离能力检查阻止发送。
- 重新构建后的 dist/src JavaScript 与部署 app 文件一致。
- 通过内存 SQLite、假账号、假发送、纯文本 fixture 和临时锁路径验证问题；未调用真实模型消息，未改变运行中的状态或配置。
- 当前没有 Git 仓库及对应 GitNexus 索引，未声称有提交差异、图谱或 taint 覆盖。
- 本轮未修改业务代码，仅新增第二轮报告及修复提示词。

## 上轮问题的修复情况

| 上轮项目 | 本轮结论 |
| --- | --- |
| Codex 的 -a 参数位置错误 | 已修；使用实际构造的 argv 加 --help，本机解析退出 0 |
| 实际发送 cwd 未创建 | 已修；创建的独立目录已传给 sendPool/发送器 |
| Antigravity 固定禁止发送 | 改为能力检查，但本机 CLI 仍未具备已验证的完整发送路径，功能仍未完成 |
| Antigravity 依赖 App 才能读取 | 增加 CLI 回退；可以读取展示，但不足以在 App 退出后完成自动激活判断，见第 3 项 |
| 暂停/手动激活后的发送复核 | 第一段检查已修；第二次异步账号检查后的旧快照问题仍在，见第 2 项 |
| Codex 缺失 credits 被当余额零 | 已修；缺失、null、无效数值及不明认证被阻止 |
| 恢复任务锁住整个账号 | 已改成冻结关联池，其他独立池可继续；但新增了暂时失败无法恢复的问题，见第 1 项 |
| 普通 due 绕过 Retry-After | 普通 enqueue 已修；最终 reload 仍绕过统一控制，见第 7 项 |
| 普通双实例同时启动 | 使用 wx 修复了新锁争抢；并发回收失效锁仍不安全，见第 6 项 |

## 剩余发现

### 1. [P1] 暂时断网或暂停，会使本周期任务永久无法补执行

位置：[engine.ts:146](src/engine.ts#L146)、[engine.ts:190](src/engine.ts#L190)、[store.ts:303](src/store.ts#L303)。

发送前最终读取失败被置为 blocked；暂停被置为 skipped。任务唯一键仍占据同一旧窗口，而 claim 现在只接受 pending。恢复网络或执行 resume 后，仍然符合条件的同一窗口无法重新领取。这个失败发生在明确尚未发送的阶段，不需要用永久结束来避免重复发送。

独立验证输出：

- `network-recovery: sendCount=0, status=blocked, error=refresh_failed`
- `pause-resume: sendCount=0, status=skipped, error=paused`

修复方向：区分暂时阻塞、用户暂停、永久失效和结果不明。对已证明未发送的任务，在新鲜复核与退避后允许有界恢复；不把所有 blocked/skipped 一概重新发送。

### 2. [P1] 第二次账号检查期间已观察到手动激活，仍会发送旧快照

位置：[engine.ts:164](src/engine.ts#L164)，关联 190–203 行及 170 行。

reload 得到 freshPool 后，还会 await 第二次 stillSafe/confirmAccount。该等待期间若 observe 已保存用户手动开启的新窗口，返回后只检查暂停，仍使用旧 freshPool 启动发送。

独立验证：挂起第二次账号检查，调用 observe(active)，再放行，输出 `checks=2, lastObserved=active, sendCount=1`。

这不是外部服务不可避免的微小竞态：本进程已经保存了更新事实，却没有让旧授权失效。需要对账号/池快照代次或窗口标识进行最终一致性验证；已有新证据就丢弃旧任务并重新决策。

### 3. [P1，未完成] Antigravity 在 App 退出后仍无法承担自动激活目标

位置：[antigravity.ts:327](src/providers/antigravity.ts#L327)，关联 43–60、173–177、341–350 行。

CLI 回退只取一次已取整的 /usage，不提供旧窗口及首次使用所需的可靠时钟证据。0%/100% 又丢掉了剩余额度；其他百分比被人工生成的使用描述当作已经使用。对已知旧边界且 100% Remaining 的候选窗口，即使费用/隔离条件另行满足，仍 allowance_unknown；非端点百分比在旧边界过去后也不能判成可激活。周门槛还可能一直 activation_mode_unknown。

因此，“可读到三个池”没有证明关闭 App 后能自动激活。当前本机 agy 1.4.0 仍缺少已验证的完整调用级隔离，真实发送也未进行。原报告如实承认了这一点，不能将功能标成已经完成。

修复方向：取得非图形环境的精确额度与窗口证据，并解决完整隔离及同账号发送。如果确有额外配置/授权需求，提出具体选项和影响，不用移除保护或打开 GUI 来凑功能。

### 4. [P2] Antigravity 的 Remaining 百分比被算反，测试固化了错误

位置：[antigravity.ts:58](src/providers/antigravity.ts#L58)、[repair.test.ts:202](test/repair.test.ts#L202)。

标签为 Weekly Limit Remaining 的 24% 应是 remainingFraction=0.24；实现却计算 (100-percent)/100，得到 0.76。独立 fixture 输出：24→0.76、76→0.24、0/100→null。

测试还断言 24% 应为 0.76，所以测试通过不能证明正确。0% 的耗尽事实、100% 的显示精度与窗口是否开始应分别表示，不能为了避免把百分比当窗口证据就丢弃额度信息。

### 5. [P1，启用发送前必须修] Antigravity 的能力与账号放行条件不足

位置：[antigravity.ts:31](src/providers/antigravity.ts#L31)、[antigravity.ts:193](src/providers/antigravity.ts#L193)，关联 [cli.ts:53](src/cli.ts#L53) 和 engine 的一致性检查。

- assessAgyIsolation 发现任意 --disable-mcp 就返回 ok=true，不能证明 plugins/hooks 也关闭。输入 --no-plugins 还会输出并未出现的单数 --no-plugin。纯 fixture 已复现。
- consistent=null 且 credits=0 被标为 subscription_only；engine 只拒绝 false，最终 Antigravity 账号检查仅看 App 邮箱是否含 @。CLI 邮箱提取失败时，账号未知仍可能被放行。

当前本机缺少隔离参数，尚未发生这类真实发送；但一旦启用/识别到相关能力，这些路径可达。应逐项证明隔离语义、精确匹配参数，并将未知账号视为不能发送，在实际执行前重新核对 CLI 使用的身份。

### 6. [P2] 并发回收失效锁时，仍可能启动两个实例

位置：[lock.ts:60](src/lock.ts#L60)、[lock.ts:65](src/lock.ts#L65)。

wx 只保护了新建文件；回收逻辑先读死 PID，再无条件 rename 当前路径。慢进程读到旧失效锁后暂停，快进程已回收并持有新锁，慢进程继续执行就会移动快进程的新活锁，然后也获得锁。

临时双进程验证：`fast=acquired, slow=acquired`。现有测试仅覆盖新建争抢和顺序恢复，没有覆盖同时回收。需要回收协议本身具备跨进程互斥及所有权校验。

### 7. [P2] 最终 reload 仍绕过每平台 single-flight 和退避

位置：[engine.ts:206](src/engine.ts#L206)。

普通读取通过 enqueue 合并和退避，最终复核却直接调用 deps.read。挂起最终读取再触发 refresh，独立复现 `readCount=2,maxConcurrent=2`。其错误也没有进入 noteFailure，所以最终读取返回的 Retry-After 不会统一作用于后续读取。

所有查询路径应共享平台级在途控制、限流和新鲜度语义。最终读取必须足够新，但不能据此跳过服务端退避；不能让代码自己等待自己造成死锁。

## 其他尚需实际验收的事项

- 尚未发送套餐内短消息，没有发送后真实窗口启动证据。
- 未观察合盖恢复及真实跨周切换。
- Codex 旧 reset 过去但使用率仍为正时保持 unknown 是当前保守策略，仍需真实跨窗口证据，不能用本地时间或手写 fixture 宣布平台行为已验证。
- 普通子进程已加入 trackChild；整体查询超时后是否真正取消底层工作，以及最终读取与启动时的取消逻辑仍需覆盖，不应仅用 Promise 超时当成外部进程已结束。

Grok 已证明固定周恢复的池继续只监控，不列为缺陷。没有理由为了“三家都发”伪造滚动窗口行为。

下一轮请执行 [REPAIR_PROMPT_ROUND2.md](REPAIR_PROMPT_ROUND2.md)，修复并更新验收报告。既要验证旧问题已修，也要验证恢复路径与保护条件没有产生新问题。
