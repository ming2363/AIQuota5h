# 第五轮修复提示词

请将以下正文完整交给执行AI，并提供REVIEW_REPORT_ROUND5.md。

---

请继续修复AIQuota5h，先读REVIEW_REPORT_ROUND5.md和既有需求。项目：`/Users/zhangming/Documents/workspace/personal/AIQuota5h`。

本轮实际57项测试通过、部署一致；第四轮模型目录恢复和锁修复有效。但仍有两项确定缺陷：新增auto_reset发送绕过费用门槛；子孙不继承管道时清理仍会遗漏。Antigravity真实自动激活仍未完成。不要重写项目，不以增加mock测试或running PID代替目标功能。

禁止Git初始化、git add/commit/push/merge/rebase、标签及PR等写操作，保持改动未暂存；若使用子代理，明确重复禁止Git写操作。

保持既定约束：只监控当前登录账号、所有可激活独立额度池；旧窗口结束满120秒且新窗口未被用户启动才发；额度耗尽等待恢复。同池只发一次代表请求；仅套餐内使用，不使用付费API、充值、余额、自动加购或重置券。费用、身份、额度未知就不发；结果不明先核实。一个轻便后台进程，不依赖GUI或终端，不改电源、不强制唤醒、不亮屏，唤醒联网后重新核实补当前任务。

## 一、优先恢复不能绕过的费用检查

decision.ts:38–44对auto_reset周期切换直接返回send/auto_reset_due，billingBlocksSend硬写false；engine.ts:183又用`billingSafety === subscription_only || reason === auto_reset_due`放行。Grok实际读取一直返回billing_safety_unknown，现在却清掉了blockReason。

独立复现已经贯穿真实Engine/Store和假发送：旧周期结束180秒后观察新周期，即使billing_safety_unknown或blocked，两种情况都sends=1、status=verifying。没有调用真实模型。这违反套餐安全门槛；不能以“新周期还有额度”或“用户接受一条额度消耗”代替费用安全证明。

请使所有发送统一要求billingSafety=subscription_only，决策与最终复核都不能按provider、auto_reset或周消息豁免。耗尽、unknown、blocked不得发送，保留请求前身份和状态复核。

第四轮明确要求固定日程自动恢复池继续只监控。现在README仍写不发，验收报告、适配记录和状态文案却写用户已接受每周一条。本对话没有明确新增这一例外；请不要把实现文档里的声明当授权。按已确认方案保留只监控；若你确有用户明确新指令，说明出处并对齐文档，但费用门槛仍不能豁免。有不确定点先问用户，再执行依赖答案的行为变更，其余独立修复继续。

现有test/decision.test.ts及test/round4.test.ts反而断言billing_safety_unknown时周消息应成功，这正是漏检。请改成符合已确认约束的回归，并加入billing=blocked也不能被放行的引擎级测试；不要仅替换错误名称或改报告。若保留任何获授权的周期消息模式，也必须覆盖blocked、unknown、exhausted、合法套餐、用户已使用/自动恢复无需激活等情况。

## 二、修复静默子孙残留与完整清理生命周期

proc.ts:161–164在父ChildProcess的close事件里清除进程组SIGKILL定时器。close不证明整个进程组不存在：子孙stdio=ignore或已经关闭管道时，父进程SIGTERM后立即close；忽略SIGTERM的子孙仍在，却不再收到400ms后的SIGKILL。trackChild也在close删除所有权记录。

确定复现：父进程创建stdio=ignore的子进程，子进程忽略SIGTERM并循环；runCommand timeout=500ms；结束后再等待900ms，子进程仍活。现有测试使用继承管道，无法覆盖此问题。

请根据本次调用拥有的进程组/资源完成情况管理终止升级，不能把父进程close等同于所有子孙退出。保证有界清理、不误杀无关进程、不在进程号复用后盲发信号。daemon退出也要等待必要的有限清理，不应killOwned后立刻process.exit而丢掉仍需执行的升级终止。

新增纯本地fixture回归：父先退出、子孙不继承输出且忽略SIGTERM；分别验证超时、外部取消及退出清理，超过允许宽限后无残留，其他进程不受影响。测试自身也必须用finally清理，失败不能遗留进程。保留原来继承管道的测试和生产读取槽恢复测试。

## 三、Antigravity仍未完成，单独处理

当前三个池都因agy 1.4.0没有已验证的plugins/MCP/hooks调用级隔离而blocked。不要删guard、编造开关、全权限绕过、自动修改用户全局配置，或以mock和blocked宣称自动激活已完成。

查明同账号、套餐内、无需GUI的最小可行发送路径并验证实际隔离。如果需要专用配置或其他额外授权，准备具体方案、改动范围与影响后向用户确认，等待期间继续其他独立修复。如果确实没有可行路径，明确该功能未完成、具体阻塞条件及下一步，不继续以测试数代替功能交付。

## 验证与交付

- 保留已修的unknown发送分类、同事实代次稳定、stale_authorization恢复、模型目录恢复、生产取消链路、SQLite单实例锁、参数/cwd、共享读取和Retry-After。
- 故障验证使用假账号、临时CLI、临时状态，不读真实密钥、不发送真实消息。真实最小验收仍须满足窗口、身份、费用和隔离条件。
- 构建并运行适当回归，部署时保留配置、暂停和任务状态；核对安装文件一致、单实例、资源占用、无遗留子进程。不要增加常驻GUI、Web服务或多个常驻CLI。
- 更新ACCEPTANCE_REPORT.md、README及适配记录，使真实行为一致；分别报告读取、可用发送路径、请求接受、新窗口确认。合盖/跨窗口/跨周没有真实机会就如实写未验证。
- 先完成这两项缺陷及对应回归，不扩大功能或弱化安全门槛；有需用户确认的具体事项再提问。禁止任何Git写操作。
