# AIQuota5h 首轮验收审查

日期：2026-10-16。结论：**未通过验收，需要修复后再检查。**

后台进程和额度读取已经运行，但 Codex 的真实发送路径有两个确定阻断，Antigravity 的真实发送被永久关闭。不能把“后台进程正在运行、24 项测试通过”当作自动激活功能已经完成。

## 检查范围与结果

- 阅读当前 src、test、README、ADAPTERS 和 ACCEPTANCE_REPORT，对照原实现方案与执行提示词检查。
- 运行 `npm test`：构建成功，24/24 通过。
- 只读检查本用户 LaunchAgent 和运行状态库：服务处于 running，PID 64586、父进程 1；当时没有任何发送任务记录，Antigravity 所有池为 execution_isolation_incomplete。
- 比较重新构建后的 dist/src 与部署目录 app：JavaScript 文件一致。
- 用内存 SQLite、假账号、假发送函数和临时 Unix socket 做额外验证，未触发真实模型消息，未修改运行中的数据库、登录配置或 LaunchAgent。
- 当前目录不是 Git 仓库，也没有对应 GitNexus 索引，因此没有 SHA/diff、图谱及 PDG/taint 覆盖；结论依据实际源码、调用链和下述本地复现。
- 未修改业务源代码。新增的仅为本审查文档及 REPAIR_PROMPT.md。

## 必须修复

### 1. [P1] Codex 发送命令无法通过本机 CLI 参数解析

位置：[src/providers/codex.ts:220](src/providers/codex.ts#L220)。

代码把 `-a never` 放在 `exec` 子命令后。本机使用相同参数并追加 `--help` 做无推理验证，立即得到 `unexpected argument '-a' found`，退出码 2。因此即使窗口条件正确，消息也发不出去。

最小修复：根据本机 CLI 正确设置顶层批准策略，验证完整 argv 的解析；不能仅在 help 里搜索两个参数就认定整条命令可用。保留只读沙箱和调用级隔离。

现有测试只 mock send，没有覆盖真实发送器 argv。

### 2. [P1] 实际发送工作目录从未创建

位置：[src/cli.ts:114](src/cli.ts#L114)，关联 [src/engine.ts:125](src/engine.ts#L125)。

engine 创建的是 `work/<provider>-<pool>-<time>`，但没有把目录交给 send；CLI 实际使用另一个 `work/send`。检查本机该目录确实不存在。第一次启动真实发送子进程时，cwd 不存在会导致 ENOENT，消息不会发出。

最小修复：由一处创建每次发送的独立空目录，将同一个绝对路径贯穿 engine → sendPool → provider；测试必须从全新、没有任何 work 子目录的环境开始。

### 3. [P1] Antigravity 的激活功能实际未完成

位置：[src/providers/antigravity.ts:159](src/providers/antigravity.ts#L159)，关联 199–233 行及 [src/engine.ts:99](src/engine.ts#L99)。

每个池无条件带有 `execution_isolation_incomplete`，engine 总是跳过。即使未来 CLI 支持对应能力，硬编码的 blockReason 仍不会解除；发送器能力检查通过后也没有真正加入检查到的禁用参数，并固定返回 unknown。

安全拦截本身合理，问题是核心功能没有实现，不能作为完成交付。应调查可行的调用级隔离/非图形发送途径，完整实现并验证；不能简单删除拦截、跳过权限或修改用户全局配置来制造成功。确实需要用户额外授权时必须列明具体修改，保持该功能未完成的真实状态。

### 4. [P1] Antigravity 监控依赖图形 App 的 language server

位置：[src/providers/antigravity.ts:37](src/providers/antigravity.ts#L37)，关联 242–252 行。

找不到已经运行的 language_server 就直接返回 unavailable，没有 CLI/OAuth 查询回退。App 和相应 language server 都退出后，后台进程无法继续监控，违背不依赖 GUI 常驻的要求。这是源码中明确缺少路径，并非只需在报告里写“尚未验证”。

最小修复：补齐复用当前账号的非图形额度读取路径，退出 App 后验证。不得通过自动打开 App、常驻浏览器或强制唤醒替代。

### 5. [P1] 发送前使用旧快照，暂停或手动激活仍可能发送

位置：[src/engine.ts:120](src/engine.ts#L120)，关联 97–112 行。

实际发送前只异步核对账号，没有在等待之后重新检查暂停和最新窗口/额度/费用状态。任务进入同账号串行队列后也可能继续使用过时快照。

内存验证输出：

- 在 confirmAccount 等待期间暂停：`paused=true, sendCount=1`。
- 同期间观察到用户已经启动新窗口：`sendCount=1`。

最小修复：在真正启动消息进程前，对暂停、账号及快照代次、目标窗口、所有相关套餐门槛、模型和费用策略做最终复核；作废过期任务。保留应用侧去重，并诚实说明外部使用与最终网络提交之间无法完全消除的竞态。

### 6. [P1] 费用字段缺失被当成余额为零，错误放行

位置：[src/providers/codex.ts:140](src/providers/codex.ts#L140)。

`snapshot.credits || {}` 和 `Number(credits.balance ?? "0")` 将没有返回的字段补成 0，再将其判定为 subscription_only。于是接口未提供完整费用事实时，代码仍声称能保证只使用套餐。

纯函数验证：合法订阅身份但 limits 不带 credits，输出 `billingSafety=subscription_only`。

最小修复：区分“已明确证明余额/回退策略安全”与“字段缺失或无法解析”。未知、null、NaN、缺失认证或不明计费策略应阻止真实发送。不能以未发生实际扣费为由忽略该判定错误。

### 7. [P1] 一次进程中断可能永久锁住整个账号

位置：[src/store.ts:264](src/store.ts#L264)，关联 358–365 行及 [src/engine.ts:146](src/engine.ts#L146)。

恢复时遗留 in_flight 全部变 verifying；任务只有观察到 active 才能退出 verifying。claim 看到账号里任何 verifying 就拒绝其他任务。如果进程在领取后、实际发送前退出，窗口一直 idle，原任务没有出口，同账号其他独立额度池也永久无法发送。

内存验证：恢复后任务为 `verifying`，一天后另一独立池 `newClaims=0`。

最小修复：真实发送阶段按账号串行，但不确定结果只能冻结实际关联池，不能锁住所有独立池。引入明确的执行阶段/核实信息与恢复出口。能证明未发送时才可有限重试；无法确认时保持相关任务可诊断、可处理，不能超时后盲目重发。

## 还需修复

### 8. [P2] 到期调度绕过 Retry-After，反复查询还可重叠

位置：[src/engine.ts:46](src/engine.ts#L46)，关联 [src/cli.ts:87](src/cli.ts#L87)。

只要库里有已过期的 idle 窗口，due 定时器就持续触发。engine 每五秒放行一次，而且 due 明确绕过失败退避。verifying 或被阻塞的旧窗口也继续触发所有平台查询；耗时查询没有 single-flight，可能叠加。

本地验证：适配器返回 `retryAfterMs=300000`，只过 5 秒就发生第二次读取，输出 `readsAfter5Seconds=2`。

最小修复：统一按平台调度并尊重 Retry-After/退避；每平台只允许一项读取在途。到期、普通刷新、唤醒共享调度入口，对已领取/阻塞任务采用明确下次核实时间，不能每五秒全平台重查。

### 9. [P2] 单实例锁可以同时放行两个实例

位置：[src/lock.ts:9](src/lock.ts#L9)。

ping → unlink → listen 不是原子操作。两个 acquire 都看到无活实例后，一个可能删除另一个刚绑定的 socket，再成功绑定同一路径。

临时 socket 并发验证：`Promise.all([a.acquire(),b.acquire()])` 返回 `["acquired","acquired"]`。

最小修复：采用可靠的原子占有及存活/失效恢复机制，释放时验证所有权。测试同时启动和失效恢复，确保恰好一个实例取得执行权；不能只补一段进程内互斥来掩盖跨进程问题。

## 应补充验证的边界，不当作已发生的生产事故

- **Codex 真实窗口过渡**：服务端若在旧 resetAt 过去后仍返回旧正使用率，当前分类器得到 unknown；旧使用率为 100 时仍为 exhausted。纯函数可复现，但尚未观察实际服务是否持续返回此形态。需要记录一次脱敏的真实跨窗口结果，不能直接删除保护，也不能用手写 idle 快照冒充真实适配验收。
- **非默认认证目录**：Codex 身份固定读取 `~/.codex/auth.json`，safeEnv 却可能保留 CODEX_HOME 等认证来源。需要统一读取与执行的有效认证上下文，并覆盖测试；当前已安装 LaunchAgent 没有证据表明实际发生错账号。
- **后台子进程退出**：daemon 的 children 集合没有传给发送器/RPC，退出清理逻辑不能证明覆盖实际创建的子进程；超时的进程组清理也应测试，不要终止用户已有会话。
- **启动时单平台挂起**：Grok fetch 未设置应用级截止时间；daemon 在 startup review 返回后才安装周期定时器。需要有限超时和“一个平台卡住时其他平台继续刷新”的测试。
- **测试缺口**：目前没有发送器 argv/cwd、真实适配器 fixtures、双实例竞争、暂停在最终检查中生效、Retry-After、生存期恢复等回归测试。现有 24 项通过只证明已覆盖的纯决策与模拟流程。

## 不列为缺陷的部分

Grok 周额度按固定日程自动重置有[官方 FAQ](https://docs.x.ai/grok/faq)支持，范围包含 Build。对确实无需首次使用启动的池，只监控而不发送无意义消息是合理行为。应保留事实说明，不能为了做到“三家都发”伪造触发效果。

真正无法确认窗口或费用时暂停发送符合原方案；应解决适配能力或如实报告未完成，不应移除安全门槛凑成功。

## 下一轮验收要求

先修上述确定问题，再运行带故障注入的回归测试、受控套餐内端到端验证和重新部署检查。给执行 AI 的完整要求见 [REPAIR_PROMPT.md](REPAIR_PROMPT.md)。

最终必须分别提供“读取正常”“发送链路可执行”“实际新窗口验证成功”三层证据。后台进程存在和测试数量不能替代真实功能完成。
