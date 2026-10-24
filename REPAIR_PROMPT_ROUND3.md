# 第三轮修复提示词

请完整复制以下正文给执行 AI，并同时提供 REVIEW_REPORT_ROUND3.md。

---

AIQuota5h 第三轮复核仍未通过。38项测试通过、后台文件与构建一致，但出现4类确定问题；Antigravity真实自动发送仍未完成。请基于现有实现修复核心问题，不重写项目，不以继续增加测试数量或更新报告代替真实功能。

项目：`/Users/zhangming/Documents/workspace/personal/AIQuota5h`。先读最新 REVIEW_REPORT_ROUND3.md 和既有需求。禁止 Git 初始化、git add/commit/push/merge/rebase、标签和PR；对子代理重复禁令。保持业务改动未暂存。

不变的规则：当前账号、所有可激活独立池、旧窗口结束满120秒且新窗口未启动才发、手动使用已激活则跳过、仅用套餐、睡眠不主动唤醒、唤醒联网后补当前任务、一个轻便后台进程、不依赖GUI或终端。

## 一、首先修复可能重复发消息的分类错误

codex.ts:342–343 将已启动的CLI非零退出且stdout为空判为 not_sent；AG:339对无会话ID的错误退出也如此。engine.ts:195–196 再把任何not_sent变成可重试deferred并退回claimed。没有输出不证明请求未到服务端。

审查已用临时假CLI证明：先记录“请求已收到”，随后空stdout、stderr连接失败、退出1，发送器仍返回not_sent+started:true。engine下一轮能再次派发，同一窗口possibleDeliveries=2。

请修正发送结果契约：只在明确实际消息进程没有启动，或有可验证的请求前拒绝证据时归not_sent；可能提交的错误、断连或缺失输出必须unknown_result并先核实。engine也不能把已可能提交的状态退回claimed。保留原始阶段/会话证据，不猜测。

测试必须贯穿假CLI→真实发送器→engine→恢复/重试，而非只mock outcome=unknown。覆盖空stdout+非零退出、无法解析会话ID、已提交后错误、真正spawn失败、明确请求前参数拒绝。可能送达时同一窗口只尝试一次，明确未发送时才有界恢复。

## 二、修复stale_authorization永久卡住与无意义代次失效

engine.ts:149/154/180 产生deferred+stale_authorization，但store.ts:418的可恢复列表没有该类别。savePool:249–251每次观测都gen++，同样的idle快照也会让授权失效并永久不可领取。

确定复现：第二次confirm挂起→observe完全相同idle→放行→一分钟后再observe，仍sends=0、deferred/stale_authorization、attempts=1。

请区分普通观测更新与会改变发送许可的语义变化。保留对真实窗口/身份/费用变化的防护，让已证明未发送的安全取消可以重新核实领取；不要仅加白名单造成持续撤销重领。

测试：相同快照与最终检查交错后仍能最终只发送一次；active/账号/费用变化必须阻止旧发送；授权失效后重新满足条件能恢复；已发送/结果未知不能恢复成未发送。

## 三、把取消接通真实I/O，并保证截止时间有效

目前cli.ts:47 `(provider)=>readProvider(provider)`丢弃Engine signal，readProvider:97–98也不传给Codex/AG。Grok:137–143在headers返回时就清timer/解绑abort，body仍可能挂住。Engine readShared仅abort，底层不完成就永久占槽。

纯本地验证：期限10ms，40ms后aborted=true但settled=false；wake仍只有原始那次read。Grok mock fetch返回headers后body挂起，再abort外部signal，底层信号仍未取消。

请将signal贯穿生产装配、所有适配器、RPC、短暂language server、子进程和完整响应body，并在成功/失败/取消各路径清理。确保截止后所属I/O被真正终止，读取槽能恢复；不能仅Promise.race后放任旧查询存活，也不能因某适配器忽略signal就永久挂住。

测试要走生产装配或相同工厂，不能只证明测试里的自定义read会响应signal。覆盖已收到headers但body不结束、RPC不回复、CLI不退出、取消中间阶段、取消后下次读取可恢复及不重叠；其他平台、暂停和退出仍可工作。不要为测试读取真实密钥或发消息。

## 四、锁必须覆盖初始化和回收者自身崩溃

lock.ts:21 open(wx)至28写入owner之间是空文件，readOwner将其当pid=0死锁，第二进程能回收，最终双acquired。门闩 .reclaim 只有token、没有恢复机制；回收者在持门闩时崩溃，之后主锁即使已死也一直busy。

请采用可靠的本机跨进程所有权方案，覆盖“已占有但元数据尚未写好”、失效回收交错、回收者异常退出、释放不删除他人资源。不要靠sleep、多读一次或层层新增同类门闩修补。如果采用系统提供的互斥能力，说明它与崩溃释放的实际语义。

测试要可控交错：第一进程刚占有而未写元数据时第二进程不得获得；回收者被终止后可以恢复；持活锁者永远不会被错误回收；只有一个进程有派发权。

## 五、单独处理Antigravity尚未完成的发送能力

Remaining解析、身份未知拦截、三类隔离参数精确匹配已经修好，请保留。无App精确读取新增了短暂自有language_server尝试，但尚无完整真实验收。

本机AG仍因plugins/MCP/hooks三个调用级参数缺失而停止自动发送。不要删guard、虚构未来CLI开关、跳过全部权限或自动改用户全局配置。请查明可行的同账号、套餐内、无需GUI的最小实际发送路径，并验证完整隔离语义，而非只搜索特定名字。

如果确实需要用户授权专用配置或其他修改，请提出明确做法、修改范围和影响，等待确认再执行依赖该决定的步骤，继续其他独立修复。若没有可行路径，明确报告这一功能未完成及原因，不要再次把动态blocked加测试当作已完成激活。

## 本轮交付

- 先修第1–4项根因和相应回归；保留上一轮已修的参数、cwd、费用门槛、跨池隔离、真正active后不发、共享读取和Retry-After。
- 所有故障测试用假账号/假CLI/临时数据；真实套餐内最小验证仍需符合窗口、账号、费用和隔离条件，不能为验收反复发消息。
- 重新构建、测试、部署，比较运行文件一致性，保留配置、暂停和任务状态；服务仍为一个轻便进程，不改电源、不强制唤醒、不增GUI/Web服务或常驻多CLI。
- 更新ACCEPTANCE_REPORT.md，逐项给出修改、真实复现转通过的证据、运行状态、资源和仍未验证项。区分读取成功、发送能力、消息接受和新窗口验证。
- 没有真实跨窗口/合盖/跨周机会就如实注明，不能用本地改时钟、手写idle或测试数冒充真实功能。
- Grok已证明固定周恢复的池保留只监控，不为三家都发伪造效果。
- 不执行Git写操作。不要只调整测试预期或报告文字；出现必须新增授权的具体事项再询问，其余已授权修复持续完成。
