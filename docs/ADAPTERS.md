# 脱敏适配记录

调查时间：2026-10-16。账号、令牌和 CSRF 不写入本文。

## 渠道与窗口

![各渠道的额度池、周期和接入状态](images/support-map.svg)

## Codex

- CLI：`/opt/homebrew/bin/codex`，版本 `0.147.0`。登录方式 `codex login status` 为 ChatGPT。
- 稳定账号标识：`~/.codex/auth.json` 的 `tokens.account_id`（UUID，不是 token 哈希）。本次前缀 `be62c568`。
- 认证模式：`auth_mode=chatgpt`。`account/read` 返回 `planType=plus`，邮箱与 CLI 会话一致。
- 额度字段：`account/rateLimits/read` 的 `rateLimitsByLimitId.codex`。当前只有一个池 `codex`。
  - `primary`：300 分钟，本次 `usedPercent=24`，`resetsAt` 锚定在未来约 3.5 小时。
  - `secondary`：10080 分钟，本次 `usedPercent=51`，重置时间锚定。
  - `credits.balance=0`，`hasCredits=false`。存在两张未使用的重置券；本工具不调用消耗接口。
- 模型：`model/list` 本次返回 `gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna`。发送候选按名称优先 Luna，并在执行前再次核对列表。用户配置里的 `gpt-6.1-sol` 未出现在这次列表中，因此不写死。
- 窗口判断：`usedPercent>0` 且 reset 锚定在未来，判定 active。`usedPercent=0` 加未来 reset 仍是 unknown。reset 已过去且没有新时钟，才把该服务端时间当作旧边界。
- 费用：只有 `credits` 对象明确给出 `hasCredits=false` 且 `balance=0`、认证为 chatgpt、且没有 API Key 时才标记 subscription_only。字段缺失、null 或无法解析时禁止发送。
- 发送参数：`-a never` 在 `exec` 之前；其后使用 `--ignore-user-config`、`--disable` 和只读沙箱。本机 `codex <完整参数> --help` 退出码为 0。不用危险绕过参数。
- App 关闭：读取走 CLI app-server，不需要图形程序保持打开。桌面端与 CLI 默认共用 `~/.codex/auth.json`。

## Claude Code（2026-10-31 更新，独立官方订阅）

- `claude-login` 调用官方 `claude auth login --claudeai`，使用工具专属 `CLAUDE_CONFIG_DIR`。登录后从带目录哈希后缀的 macOS 钥匙串读取凭证并写入独立目录的 `.credentials.json`（目录 0700、文件 0600）；原有 `~/.claude/` 代理配置保持不变。
- 读取官方 `/api/oauth/profile` 与 `/api/oauth/usage`，账号 UUID、套餐类型及额外付费状态来自同一令牌。仅个人 `claude_pro` / `claude_max` 且额外付费明确关闭时标记 `subscription_only`；任一来源明确开启额外付费都阻止发送。
- 即将过期的独立凭证通过官方 CLI 使用的 `https://platform.claude.com/v1/oauth/token` 续期；合并并发续期，原子保存旋转后的令牌，失败不覆盖原凭证。API 路径与公开客户端 ID 核对自本机官方 Claude Code 2.1.83，属于客户端实现细节，变化时停止读取／发送，不伪造成功。
- 展示服务端实际返回的 `five_hour`、`seven_day` 及模型周额度；百分比非法时显示未知。保存同账号同额度池的旧 5 小时边界，窗口结束满 65 秒后复核；首次没有旧边界时先监控。周额度是固定重置，只作额度约束，不额外发送周激活消息。
- 发送用同一已核验的 OAuth token 临时注入官方 CLI，只使用 Sonnet 别名。环境白名单不继承代理 API 凭证或模型覆盖。参数禁用设置来源、MCP、工具、技能、Chrome、会话保存；专用设置禁用 hooks、自动记忆、fast mode。发现受管配置则暂不发送。运行目录由调度器单独创建。
- 每次发送前复核账号、费用和额度，再解析 CLI 的 `result / success / is_error=false`。回合完成后仍由额度观测确认窗口启动；空输出、超时或失败回合均视为已启动但未知，保留防重发保护。
- 页面支持 Claude 独立读取与自动激活开关，历史记录与现有渠道共用。
- 日常每 2 分钟读取，窗口到期仍独立复核；管理窗口打开时请求刷新，短时间内合并重复刷新。账号在调度器最终快照和发送器的同令牌会话中核对，不再因重复查询的 429 把账号判为变化。未发送时的 429 暂缓后重试，不计入模型不可用的有限重试。
- 读取及发送前复核保留 `Retry-After`，限流等待至少 5 分钟，连续限流逐步延长至 30 分钟；等待时间写入状态库，重启不绕过，成功后清零。
- 官方参考：[CLI 参数](https://code.claude.com/docs/en/cli-reference)、[Pro / Max 登录](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan)、[固定周重置](https://support.claude.com/en/articles/11049741-what-is-the-max-plan)、[额外用量](https://support.claude.com/en/articles/12429409-manage-usage-credits-for-paid-claude-plans)。

## Antigravity

- App 2.23.1 已安装。官方 CLI 原先不在 PATH。已按官方清单校验 SHA-512 后，把 `agy` 1.4.0 放到 `~/.local/bin/agy`。没有运行 `agy install`，因此没有改 shell 配置。
- 稳定账号标识：Google 账号邮箱，不是 token。App language server 与 `agy` keyring 登录为同一 consumer 账号。
- 认证：`agy` 日志显示 `authenticated via keyring`，`authMethod=consumer`。`~/.gemini/settings.json` 里的 `gemini-api-key` 没有被这次 CLI 认证使用。
- 额度来源：本机 language server `RetrieveUserQuotaSummary`，不用百分比取整后的 `agy -p /usage`。
- 池映射（2026-10-16 实测）：
  - `gemini`：Gemini Flash/Pro，共享 `gemini-5h` 与 `gemini-weekly`。低消耗候选 `gemini-3.8-flash-low`。
  - `claude-gpt`：Claude 与 GPT-OSS，共享 `3p-5h` 与 `3p-weekly`。低消耗候选 `claude-sonnet-5-5-low`。
  - `gemini-argon`：Gemini 4 Argon 独立周池。候选 `gemini-4-argon-low`。
- 窗口证据：间隔约 26 秒重读时，已使用的周窗口和 Gemini 五小时窗口 reset 不变；`3p-5h` 剩余比例恰好为 1、没有 “you have used” 描述，reset 随墙钟滑动同样的秒数。这不是单独凭 100% 或未来 reset 推断，而是时钟滑动证明新五小时窗口尚未启动。旧边界服务端没有给出，所以不发送。
- 费用：`agy -p /credits` 显示剩余 AI credits 为 0。官方说明 credits 只在基线额度耗尽后、且用户打开 overage 时消耗。本地没有找到 overage 开关。调用级必须同时有 plugins、MCP、hooks 的精确开关。agy 1.4.0 三项都没有，发送未完成。
- 非图形读取：App language server 不在时，改用 `agy -p /usage` 和 `agy models`。2026-10-16 退出 Antigravity 后该路径读到三个池，并动态选择 `gemini-3.8-flash-low`、`claude-sonnet-5-5-low`、`gemini-4-argon-low`。CLI 把剩余显示成 100% 时不当作 idle 或 active。
- 发送隔离：`agy --help` 没有调用级禁用 plugins/MCP/hooks 的参数。发送器会在参数出现后使用它；当前返回 not_sent，不修改全局插件配置。

## Grok Build

- CLI：`/Users/zhangming/.local/bin/grok`，版本 1.0.46。`grok models` 显示已登录 grok.com，默认模型 `grok-4.7`。
- 稳定账号标识：`~/.grok/auth.json` 的 `user_id`，不是 token。订阅层级 SuperGrok。
- `grok agent stdio` 的 `x.ai/billing` 在本版本返回 Method not found。额度改读官方订阅接口 `GetGrokCreditsConfig`，令牌只在内存中使用。
- 2026-11-01 核对官网当前 `GrokCreditsConfig` 协议定义：总使用率为 config 字段 1（proto3 float），统一计费标记为字段 11，当前周期为字段 8（type=2 表示周，start/end 为字段 2/3）。确认统一周额度结构后，省略的总使用率按 proto3 默认值 0 解析，表示剩余 100%。不再递归扫描其他产品／历史的浮点数来猜总使用率。缺少 config、周期错误、字段类型变化或响应损坏不会被默认成 100%。
- 同时验证 HTTP 与 gRPC header/trailer 状态；HTTP 200 中的 gRPC 错误也算失败，保留上次成功快照。周期时间包含秒和纳秒，不丢失精度。
- 官方 FAQ 写明周额度按 Usage 页日程重置，消息不能启动窗口。用户在 2026-10-17 对话中说可以发一条、不在乎这一条额度；该授权不能代替套餐证明。费用为 unknown、blocked 或额度耗尽时不发送。当前未读到 Auto Top Up，标记为 billing_safety_unknown，因此只监控。
- 费用：CLI authenticate 的 `backend_billed=false`。没有读到 Auto Top Up 开关，发送安全标记为 `billing_safety_unknown`。由于无需激活，这不会触发消息。
- 界面显示「官方定时重置，无需消息激活」，额度显示与发送费用条件分别处理；读取正常不会再因无需激活而显示自动激活异常。
- App 关闭：Grok Build 入口是 CLI。Grok Bot 不是本工具目标，不需要保持打开。
