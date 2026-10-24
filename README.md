<p align="center">
  <img src="docs/images/logo.png" alt="AIQuota5h Logo" width="120" height="120">
</p>

<h1 align="center">AIQuota5h</h1>

<p align="center">
  <strong>到期自动激活，让下一轮计时不等你开工。</strong><br>
  5 小时 / 周额度窗口 · 后台自动接续
</p>

<p align="center">
  <a href="#自动接续流程">工作原理</a> ·
  <a href="#安装使用">安装使用</a> ·
  <a href="#使用文档">使用文档</a>
</p>

<p align="center">
  <img src="docs/images/benefits.svg" alt="时间轴对比：等用户使用才激活，会推迟后续窗口；旧窗口到期后主动激活，让空闲期间也在计时" width="100%">
</p>

## 自动接续流程

![旧窗口到期，后台复核后主动发起最小请求，核验新窗口计时启动并持续守候下一轮](docs/images/automation.svg)

## 激活开关与执行记录

![AIQuota5h 原生管理窗口演示](docs/images/dashboard-demo.png)

*界面使用演示数据。*

## 安装使用

macOS 15+ · Node.js 24+ · Xcode Command Line Tools

```bash
git clone https://github.com/ming2363/AIQuota5h.git
cd AIQuota5h
npm ci
npm run install:macos
```

打开 `~/Applications/AIQuota5h.app`，按额度池开启「到期自动激活」。后台会持续运行，关闭管理窗口后仍继续处理。

## 使用文档

[安装与操作](docs/USAGE.md) · [平台接入](docs/ADAPTERS.md)

## 开发与验证

```bash
npm test
npm run build:macos
```

`src/` 后台与激活决策 · `macOS/` 原生管理界面 · `test/` 自动验证
