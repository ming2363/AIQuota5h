<p align="center">
  <img src="docs/images/logo.png" alt="AIQuota5h 蓝色仪表盘 Logo" width="120" height="120">
</p>

<h1 align="center">AIQuota5h</h1>

<p align="center">
  <strong>少盯额度，多做事情。</strong>
</p>

<p align="center">
  <a href="#安装原生应用">安装使用</a> ·
  <a href="#接入范围">支持哪些平台</a> ·
  <a href="#开发与验证">开发与验证</a>
</p>

<p align="center">
  <img src="docs/images/benefits.svg" alt="额度一屏看清；到期自动检查，符合条件才激活；读取与激活记录可追溯" width="100%">
</p>

## 界面预览

![AIQuota5h 原生管理窗口演示](docs/images/dashboard-demo.png)

*界面演示使用合成额度和虚构账号，不代表真实测量结果；Claude Code 当前仅支持监控。*

## 自动处理流程

![后台定时读取、到期复核、条件检查、单次激活和结果核验；未通过条件时保持等待](docs/images/automation.svg)

## 接入范围

![Codex、Claude Code、Antigravity 和 Grok 的接入关系、额度周期与当前激活能力](docs/images/support-map.svg)

[接入细节与限制](docs/ADAPTERS.md) · [Claude 官方额度说明](https://support.claude.com/en/articles/11647753-how-do-usage-and-length-limits-work)

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

应用复用各客户端已有登录态，不要求把密钥填写到界面。Claude Code 若配置了代理、API Key 或云供应商入口，将显示无法读取官方订阅额度；本工具不会修改该配置或自动刷新登录凭证。

界面每 5 秒同步本机状态，菜单栏在窗口关闭后每 15 秒同步。它们不会另起一套额度采集器。历史仅包括本工具的额度读取和激活任务，不能列出其他客户端的所有聊天调用。旧版本没有逐次额度读取记录，升级前无法补回。

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
