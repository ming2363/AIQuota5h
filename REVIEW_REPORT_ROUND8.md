# AIQuota5h 第八轮复核

日期：2026-10-17。结论：本轮未发现新增可复现缺陷，第七轮监听器保留问题已修复。当前修复通过代码与离线回归复核；三平台自动激活的整体目标仍未完成真实验收。

## 修复复核

- Engine 不再给每次读取注册多余的全生命周期停止监听器，仍通过 readControllers 集合取消进行中的读取。
- RPC 的 release 同时解除调用方 signal 和全局 shutdownSignal 的监听器，显式 close、自然退出、启动 error、外部取消及全局退出都有清理入口。
- 已复查调用链，退出封锁、发送准备后的停止检查、已启动结果未知的保守分类、费用门槛与进程组清理均保留。
- `npm test`：构建成功，63/63 通过。包括监听器恢复基线、进行中任务取消、退出后不启动新发送、静默子孙清理、未知结果不重发等既有回归。

## 独立本地验证

使用编译后的真实 Engine/Store/openRpc/proc，内存数据库、假快照和本地 Node 假 RPC。没有认证读取、网络访问或模型消息。观测结果：

```json
{"probe":"engine-completed20","stopListeners":0}
{"probe":"rpc-closed12","baseline":0,"shutdownListeners":0}
{"probe":"rpc-spawn-error","shutdownListeners":0}
{"probe":"rpc-external-cancel","shutdownListeners":0,"externalListeners":0}
```

正常 RPC 逐个完成请求并等待 close，最后等待 killOwned；失败和取消路径也等待了子进程结束。所有本地子进程已清理，内存数据库已关闭。没有把重置全局信号或提高监听器上限作为清理证明。

## 实际部署

- LaunchAgent running，PID 51894，runs=1，last exit code=(never exited)。本轮未停止或重启真实服务。
- 安装 app 中的全部 JS 与本次 dist/src 一致。
- 只读状态库：任务数 0，暂停值 0。Codex subscription_only、当前无 block_reason；Grok billing_safety_unknown/allowance_unknown；Antigravity 三池仍缺少 agy 调用级 plugins/MCP/hooks 隔离。快照只证明最近存储的观测，不能证明真实激活成功。

## 尚未完成的功能和验证

- Antigravity 三池的真实自动发送仍不可用。现有安全阻塞正确，但不能据此宣称原始三平台目标已经完成。
- Grok 费用安全未确认，继续禁止发送；固定日程周窗口本身也不能被表述成由消息启动。
- Codex 参数链路和决策通过离线验证，但本轮没有真实请求接受、新窗口启动的证据。
- 真实合盖唤醒、跨五小时、跨周及长期资源稳定性未实测。监听器回到基线只证明该项保留缺陷修复，不能代替长期 RSS 验收。

下一步应聚焦现有能力缺口及符合身份、额度、费用和隔离条件时的真实端到端验收。本轮没有新的已确认代码缺陷，因此未新增一份要求修改业务逻辑的修复提示词；继续处理 Antigravity 或新的配置方案时仍须遵守此前用户确认范围。

## 范围说明

本轮仅新增本报告，未修改业务源码、运行配置或状态，未发送真实 AI 消息，未执行 Git 写操作。npm test 重新生成 dist。当前目录没有 .git，未使用固定提交差异或 GitNexus 图索引作覆盖证明。结论限于本轮源码与调用链检查、63 项测试、独立本地验证和只读部署检查。
