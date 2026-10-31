# 安装、使用与运行说明

AIQuota5h 的核心是额度窗口到期后主动触发下一轮计时。额度展示用于辅助判定和启动核验。

## 当前运行策略

旧窗口结束后等待 65 秒，再复核账号、可用额度、费用边界和防重发条件。到达计划时间后会主动处理，不需要用户再发起第一条请求。实际调用仍需服务端窗口证据；按固定日程自动重置的限制遵循平台规则。该等待策略由共享常量统一用于决策、任务计划和旧计划升级；已发送任务的去重记录不受调整影响。

## 安装原生应用

需要 macOS 15+、Node.js 24+、Xcode Command Line Tools，以及已登录的对应客户端／CLI。

```bash
git clone https://github.com/ming2363/AIQuota5h.git
cd AIQuota5h
npm ci
npm test
npm run install:macos
```

安装结果为 `~/Applications/AIQuota5h.app`。打开应用后可在菜单栏进入管理窗口：

1. **设置 → 自动读取额度**：选择需要监控的渠道。
2. **额度概览 → 到期自动激活**：按额度池选择是否允许到期发送。开启只代表允许后台检查，不代表费用或窗口条件已经满足。
3. **调用历史**：切换“额度读取／自动激活”，查看每次操作及历史结果。

应用复用各客户端已有登录态，不要求把密钥填写到界面。Claude Code 官方订阅使用下面的独立登录，保留原有代理、插件和日常配置。

## Claude 官方订阅

运行一次官方登录，并在浏览器中选择已购买 Pro / Max 的账号：

```bash
node dist/src/index.js claude-login
```

安装后也可运行 `node "$HOME/Library/Application Support/AIQuota5h/app/index.js" claude-login`。登录成功后，在管理窗口中打开 Claude Code 的「自动读取额度」和「到期自动激活」。

独立配置保存在 `~/Library/Application Support/AIQuota5h/claude-subscription/`，不修改 `~/.claude/` 的第三方代理。专用 OAuth 凭证以仅当前用户可读写的文件保存；续期只更新该独立登录。不要分享或提交此目录。

后台记录当前 5 小时窗口边界；窗口结束满 65 秒后复核，满足条件时通过官方 Claude Code 向 Sonnet 发送一条短消息，再核验新窗口。首次接入但没有旧边界时先监控；如果用户已经手动使用、新窗口正在运行，便跳过本轮发送。Claude 周额度按官方固定时间自动恢复，显示余额并约束发送，不通过额外消息改变周重置时间。

仅在官方个人 Pro / Max 订阅、额外付费明确关闭、返回的各额度均可用时允许自动激活。额外付费开启、缺少必要额度字段、受管配置无法隔离、登录失效或账号变化时停止发送并记录原因。发送禁用工具、技能、MCP、Chrome 集成、插件来源、钩子和会话保存；请求结果不明时不会重发。

## 退出与重新打开

- **退出管理界面（后台继续运行）**：只关闭菜单栏和窗口，后台继续自动处理。
- **完全退出（同时停止后台）**：停止并卸载本次登录会话中的后台服务，再关闭界面；后台不会被 KeepAlive 自动拉起。保留配置、历史和原有登录启动设置。

下次手动打开 `AIQuota5h.app` 时，会自动恢复后台。停止失败时管理界面保持打开并显示错误，便于重试。

界面每 5 秒同步本机状态，菜单栏在窗口关闭后每 15 秒同步。它们不会另起一套额度采集器。历史仅包括本工具的额度读取和激活任务，不能列出其他客户端的所有聊天调用。旧版本没有逐次额度读取记录，升级前无法补回。

打开管理窗口会请求后台更新额度，继续遵守渠道开关及限流等待。日常 Claude 每 2 分钟查询，其余渠道每分钟查询；到期窗口另外复核，不因日常降频而等待下一轮查询。Claude 短时间重复打开合并刷新，接口返回 429 时按 `Retry-After` 和连续失败退避等待，等待时间跨后台重启保留。

临时失败时保留上一次成功额度和更新时间，界面显示限流原因及预计重试时间；旧数据不会标为实时数据。Grok 周额度由官方按固定日程重置，无需发送激活消息。官方确认的零使用率显示剩余 100%；无效响应不会被猜成 100%。

重复安装会保留现有后台配置。应用是本机构建的 ad-hoc 签名，尚未提供 Apple Developer ID 公证或跨机器安装包。构建脚本针对已验证的 CLT Swift 6.2.4 / SDK 6.2.3 组合提供本地兼容层，不修改系统 SDK；其他不匹配组合应安装匹配的 Xcode 工具。

## 开发与验证

```bash
npm run build          # 编译 TypeScript
npm test               # 后台、适配器、开关和历史测试
npm run build:macos    # 构建 dist/AIQuota5h.app，包含图标
```

源码入口：`src/` 为后台、`macOS/` 为原生界面、`scripts/` 为构建安装脚本、`test/` 为测试。管理界面通过有超时限制的本地进程命令读取结构化 JSON；没有监听公网或本地 HTTP 端口。

真实登录态、状态库、日志和构建产物不提交到 Git。页面不返回原始认证响应，账号默认脱敏。

## 命令

```bash
npm run build
npm test
node dist/src/index.js install
node dist/src/index.js status
node dist/src/index.js start
node dist/src/index.js stop
node dist/src/index.js claude-login
node dist/src/index.js dashboard
node dist/src/index.js history 0
node dist/src/index.js reads 0
node dist/src/index.js refresh
node dist/src/index.js control monitor codex off
node dist/src/index.js control activate codex off codex
node dist/src/index.js doctor
node dist/src/index.js pause
node dist/src/index.js resume
node dist/src/index.js uninstall
node dist/src/index.js uninstall --purge-data
```

`status` 会分开显示进程、读取和发送能力。进程在运行不等于自动激活已完成。`status` 和 `doctor` 不会发消息，也不会再启动一个 daemon。`pause` 写入 SQLite，重启后仍然有效。

已发送的激活请求超过 30 分钟仍未确认时，会继续核验并保留防重发保护。观测到确认范围之外的后续活跃窗口，或证明后续周期已结束后，旧任务会收尾为“历史未确认”，保留发送记录，不冒充激活成功。后续任务仍须满足新周期的证据与费用条件；超时、重启、旧快照及窗口编号变化都不会让同一请求重新发送。

安装位置：

- 程序与状态：`~/Library/Application Support/AIQuota5h/`
- 日志：`~/Library/Logs/AIQuota5h/`
- LaunchAgent：`~/Library/LaunchAgents/com.zhangming.aiquota5h.plist`

卸载先 `launchctl bootout`，避免 KeepAlive 把进程拉起来。默认保留状态和日志。`--purge-data` 只删除本工具目录。

## 配置

安装器写入绝对路径。示例见 `config/config.example.json`。不要把令牌写进配置。

## 限制

窗口判断和费用隔离见 `docs/ADAPTERS.md`。不能证明的窗口或费用边界不会发送。Grok 周额度按固定日程重置；用户曾要求新周期可发一条，但费用不是明确的套餐内时仍不发送。当前费用未知，所以只监控。Antigravity 当前缺少调用级插件隔离参数，真实发送暂停。
