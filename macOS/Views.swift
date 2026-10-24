import SwiftUI
import ServiceManagement

struct DashboardView: View {
    @ObservedObject var model: AppModel
    @State private var selectedTab = 0
    @State private var historyKind = 0

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 14) {
                Image(systemName: "gauge.with.dots.needle.50percent")
                    .font(.system(size: 30, weight: .medium)).foregroundStyle(.tint)
                    .frame(width: 52, height: 52).background(.tint.opacity(0.1), in: RoundedRectangle(cornerRadius: 14))
                VStack(alignment: .leading, spacing: 4) {
                    Text("AIQuota5h").font(.title2.bold())
                    Text("AI 订阅额度管理").font(.subheadline).foregroundStyle(.secondary)
                }
                Spacer()
                if let data = model.dashboard {
                    Label(data.running ? "后台运行中" : "后台未运行", systemImage: data.running ? "circle.fill" : "exclamationmark.circle")
                        .font(.caption).foregroundStyle(data.running ? .green : .orange)
                }
                Button { model.perform(["refresh"]) } label: {
                    Label(model.dashboard?.refreshPending == true ? "刷新中…" : "刷新额度", systemImage: "arrow.clockwise")
                }.help("请求后台读取最新额度，遵守渠道开关和限流退避")
                    .disabled(model.busy || model.dashboard?.refreshPending == true || model.dashboard?.running != true)
            }.padding(24)
            if !model.error.isEmpty {
                Label(model.error, systemImage: "exclamationmark.triangle")
                    .font(.callout).foregroundStyle(.orange).textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 24).padding(.bottom, 12)
            }
            TabView(selection: $selectedTab) {
                overview.tabItem { Label("额度概览", systemImage: "chart.bar.xaxis") }.tag(0)
                history.tabItem { Label("调用历史", systemImage: "clock.arrow.circlepath") }.tag(1)
                settings.tabItem { Label("设置", systemImage: "slider.horizontal.3") }.tag(2)
            }.padding(.horizontal, 20).padding(.bottom, 20)
        }
        .frame(minWidth: 780, minHeight: 640)
        .background(Color(nsColor: .windowBackgroundColor))
    }

    private var overview: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                HStack {
                    VStack(alignment: .leading, spacing: 5) {
                        Text("所有额度，一目了然").font(.title3.bold())
                        Text("共享额度按池显示。倒计时来自服务端重置时间。").font(.callout).foregroundStyle(.secondary)
                    }
                    Spacer()
                    if model.busy { ProgressView().controlSize(.small) }
                }
                if let data = model.dashboard {
                    if data.paused {
                        Label("后台已暂停自动处理", systemImage: "pause.circle.fill").foregroundStyle(.orange)
                    }
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 340), alignment: .top)], alignment: .leading, spacing: 16) {
                        ForEach(data.pools) { pool in PoolCard(pool: pool, model: model) }
                    }
                    ForEach(data.providers.filter { !$0.hasSnapshot }) { provider in
                        HStack(spacing: 12) {
                            Image(systemName: "questionmark.circle").font(.title2).foregroundStyle(.secondary)
                            VStack(alignment: .leading, spacing: 5) {
                                Text(provider.name).font(.headline)
                                Text(!provider.monitoring ? "自动读取已关闭，可在设置中开启。" : provider.lastRead?.detail ?? "尚无额度数据，请检查客户端登录和后台状态。")
                                    .font(.callout).foregroundStyle(.secondary)
                            }
                            Spacer()
                        }.padding(20).background(.background, in: RoundedRectangle(cornerRadius: 14))
                    }
                } else {
                    ContentUnavailableView("正在读取本机状态", systemImage: "gauge.with.dots.needle.50percent", description: Text("首次使用请先安装后台服务。"))
                }
            }.padding(20)
        }
    }

    private var history: some View {
        VStack(alignment: .leading, spacing: 12) {
            Picker("记录类型", selection: $historyKind) {
                Text("额度读取").tag(0)
                Text("自动激活").tag(1)
            }.pickerStyle(.segmented)
            if historyKind == 0 { readHistory }
            else { activationHistory }
        }.padding(20)
    }

    private var activationHistory: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("自动激活记录").font(.headline)
                Spacer()
                Text("共 \(model.history?.total ?? 0) 条").foregroundStyle(.secondary)
                Button("上一页") { model.changePage(-1) }.disabled(model.page == 0 || model.busy)
                Text("\(model.page + 1)").monospacedDigit()
                Button("下一页") { model.changePage(1) }
                    .disabled(model.busy || (model.page + 1) * 30 >= (model.history?.total ?? 0))
            }
            Text("消息已接受与额度窗口已启动分别记录；结果未知的请求不会直接重发。")
                .font(.caption).foregroundStyle(.secondary)
            ScrollView {
                LazyVStack(spacing: 10) {
                    if model.history?.items.isEmpty != false {
                        ContentUnavailableView("暂无激活记录", systemImage: "clock", description: Text("满足条件后的自动激活会记录在这里。"))
                    }
                    ForEach(model.history?.items ?? []) { item in
                        VStack(alignment: .leading, spacing: 8) {
                            HStack {
                                Text("#\(item.id) · \(item.pool) · \(item.window == "5h" ? "5 小时" : "周额度")").font(.headline)
                                Spacer()
                                Text(statusLabel(item.status)).font(.caption.bold())
                                    .foregroundStyle(item.status == "confirmed" ? .green : .secondary)
                            }
                            Text(dateText(item.at)).font(.caption).foregroundStyle(.secondary)
                            HStack(spacing: 20) {
                                Text("消息：\(resultLabel(item.messageResult))")
                                Text("窗口：\(resultLabel(item.windowResult))")
                                Text("尝试 \(item.attempts) 次")
                            }.font(.caption)
                            DisclosureGroup("详细原因") {
                                Text(item.detail).font(.callout).foregroundStyle(.secondary).textSelection(.enabled)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }.font(.caption)
                        }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
                            .background(.background, in: RoundedRectangle(cornerRadius: 12))
                    }
                }
            }
        }
    }

    private var readHistory: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("额度读取记录").font(.headline)
                Spacer()
                Text("共 \(model.reads?.total ?? 0) 条").foregroundStyle(.secondary)
                Button("上一页") { model.changeReadPage(-1) }.disabled(model.readPage == 0 || model.busy)
                Text("\(model.readPage + 1)").monospacedDigit()
                Button("下一页") { model.changeReadPage(1) }.disabled(model.busy || (model.readPage + 1) * 30 >= (model.reads?.total ?? 0))
            }
            Text("记录本工具每次额度读取的结果和耗时，不代表账号中所有聊天调用。旧版本没有逐次读取记录。")
                .font(.caption).foregroundStyle(.secondary)
            ScrollView {
                LazyVStack(spacing: 10) {
                    if model.reads?.items.isEmpty != false {
                        ContentUnavailableView("暂无读取记录", systemImage: "clock", description: Text("后台下一次读取后将显示记录。"))
                    }
                    ForEach(model.reads?.items ?? []) { item in
                        VStack(alignment: .leading, spacing: 8) {
                            HStack {
                                Text(providerLabel(item.provider)).font(.headline)
                                Text(readReason(item.reason)).font(.caption).foregroundStyle(.secondary)
                                Spacer()
                                Text(item.status == "ok" ? "成功" : item.status == "running" ? "读取中" : item.status == "interrupted" ? "已中断" : "失败")
                                    .foregroundStyle(item.status == "ok" ? .green : .orange).font(.caption.bold())
                            }
                            HStack {
                                Text(dateText(item.at))
                                Spacer()
                                if let end = item.finishedAt { Text(String(format: "耗时 %.1f 秒", max(0, end - item.at) / 1000)) }
                            }.font(.caption).foregroundStyle(.secondary)
                            Text(item.detail).font(.callout).foregroundStyle(.secondary).textSelection(.enabled)
                        }.padding(16).background(.background, in: RoundedRectangle(cornerRadius: 12))
                    }
                }
            }
        }
    }

    private var settings: some View {
        Form {
            Section("自动读取额度") {
                ForEach(model.dashboard?.providers ?? []) { provider in
                    VStack(alignment: .leading, spacing: 5) {
                        Toggle(provider.name, isOn: Binding(get: { provider.monitoring }, set: { enabled in
                            model.perform(["control", "monitor", provider.id, enabled ? "on" : "off"])
                        })).disabled(model.busy)
                        if let read = provider.lastRead, provider.monitoring, read.status != "ok" {
                            Text(read.detail).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
                Text("每分钟自动读取。关闭渠道后不再开始新的读取或激活；已发出的请求仍保留记录。")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Section("到期自动激活") {
                Text("在额度概览中按额度池开关。开启后，仅在旧周期结束满 120 秒、账号和费用条件通过且没有重复请求时发送一条短消息。")
                    .font(.caption).foregroundStyle(.secondary)
                Text("Claude Code 当前仅支持监控；Antigravity 和 Grok 的实际发送取决于调用隔离和费用验证结果。")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Section("后台服务") {
                LabeledContent("运行状态", value: model.dashboard?.running == true ? "运行中" : "未运行")
                Text("额度由独立后台进程读取；关闭管理窗口后继续运行。页面每 5 秒同步一次本地状态。")
                    .font(.caption).foregroundStyle(.secondary)
                Button("打开日志文件夹") { model.revealLogs() }
                Button(model.dashboard?.paused == true ? "恢复全部自动处理" : "暂停全部自动处理") {
                    model.perform([model.dashboard?.paused == true ? "resume" : "pause"])
                }.disabled(model.busy)
            }
            Section("菜单栏界面") {
                Toggle("登录 macOS 后启动菜单栏界面", isOn: Binding(get: { model.loginEnabled }, set: { model.setLoginEnabled($0) }))
                if !model.loginMessage.isEmpty { Text(model.loginMessage).font(.caption).foregroundStyle(.secondary) }
                Button("打开系统登录项") { SMAppService.openSystemSettingsLoginItems() }
                Text("后台服务的登录启动独立生效。此开关仅控制菜单栏管理界面。")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Section("额度说明") {
                Text("同一渠道的多个模型可能共享额度。Gemini 与 Gemini 4 Argon 按服务端返回的额度池分别展示。")
                Text("服务端没有返回百分比或重置时间时显示未知，过期快照会明确标记。")
            }
        }.formStyle(.grouped)
    }
}

struct PoolCard: View {
    let pool: QuotaPool
    @ObservedObject var model: AppModel
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                VStack(alignment: .leading, spacing: 5) {
                    Text(pool.name).font(.title3.bold())
                    Text("\(pool.provider == "antigravity" ? "Antigravity · " : "")\(pool.account)").font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                if pool.stale { Label("数据已过期", systemImage: "clock.badge.exclamationmark").font(.caption).foregroundStyle(.orange) }
            }
            Text("更新于 \(dateText(pool.observedAt))").font(.caption2).foregroundStyle(.secondary)
            Toggle("到期自动激活", isOn: Binding(get: { pool.autoActivate }, set: { enabled in
                model.perform(["control", "activate", pool.provider, enabled ? "on" : "off", pool.poolId])
            })).toggleStyle(.switch).controlSize(.small)
                .disabled(model.busy || !pool.activationSupported || !pool.monitoring)
            if !pool.monitoring { Text("该渠道自动读取已关闭；以下为历史快照。自动激活同时停止。").font(.caption).foregroundStyle(.orange) }
            if let read = pool.lastRead, read.status != "ok" && read.status != "running" {
                Label("最近读取失败：\(read.detail)", systemImage: "exclamationmark.circle").font(.caption).foregroundStyle(.orange)
            }
            ForEach(pool.windows) { window in
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Text(window.name).font(.callout.weight(.medium))
                        Spacer()
                        Text(window.remainingFraction.map { String(format: "剩余 %.0f%%", $0 * 100) } ?? "剩余额度未知")
                            .font(.callout.weight(.semibold)).monospacedDigit()
                    }
                    if let fraction = window.remainingFraction {
                        ProgressView(value: fraction).tint(fraction <= 0.1 ? .orange : .accentColor)
                    }
                    HStack {
                        Text(window.state == "active" ? "窗口进行中" : window.state == "idle" ? "等待新窗口启动" : "窗口状态待确认")
                        Spacer()
                        TimelineView(.periodic(from: .now, by: 1)) { context in
                            Text(window.resetAt.map { countdown($0, now: context.date) } ?? "重置时间未知")
                        }
                    }.font(.caption).foregroundStyle(.secondary)
                }
            }
            if !pool.guards.isEmpty {
                Label("历史请求待核验，同周期不会重发", systemImage: "hourglass").font(.caption).foregroundStyle(.orange)
            }
            if let reason = pool.blockReason {
                Label("自动激活暂不可用：\(blockReasonLabel(reason))", systemImage: "info.circle").font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
            }
            if pool.autoActivate && pool.billingSafety != "subscription_only" && pool.blockReason == nil {
                Label("费用条件未确认，当前仅监控额度", systemImage: "info.circle").font(.caption).foregroundStyle(.secondary)
            }
            DisclosureGroup("额度与模型详情") {
                VStack(alignment: .leading, spacing: 7) {
                    Text("激活模型：\(pool.selectedModel ?? "未确认")")
                    Text("费用状态：\(pool.billingSafety == "subscription_only" ? "已证明仅使用订阅额度" : "未证明仅使用订阅额度，禁止自动发送")")
                    Text("模型：\(pool.models.joined(separator: "、"))").textSelection(.enabled)
                    ForEach(pool.windows) { window in
                        Text("\(window.name)重置时间：\(window.resetAt.map(dateText) ?? "未知")")
                    }
                }.font(.caption).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading).padding(.top, 7)
            }.font(.caption)
        }.padding(20).background(.background, in: RoundedRectangle(cornerRadius: 14))
    }
}

func providerLabel(_ id: String) -> String {
    ["codex": "Codex", "claude": "Claude Code", "antigravity": "Antigravity", "grok": "Grok Build"][id] ?? id
}

func readReason(_ reason: String) -> String {
    ["startup": "启动读取", "refresh": "自动刷新", "manual": "手动刷新", "verification": "激活核验", "due": "到期复核", "wake": "唤醒检查", "clock": "时钟变化"][reason] ?? reason
}

func blockReasonLabel(_ reason: String) -> String {
    ["window_state_unknown": "窗口状态尚未确认", "allowance_unknown": "服务端未提供可用额度", "activation_mode_unknown": "尚未确认窗口重置方式", "activation_unproven": "尚无足够的启动证据", "old_boundary_unknown": "尚未证明旧周期结束时间", "account_context_unverified": "账号身份尚未核实", "account_mismatch": "客户端与订阅账号不一致", "account_unverified": "账号身份尚未核实", "billing_safety_unknown": "无法证明仅使用订阅额度", "billing_blocked": "当前计费方式不允许发送", "model_unknown": "未读到可用激活模型"][reason] ?? reason
}

func statusLabel(_ status: String) -> String {
    ["confirmed": "已确认启动", "historical_unconfirmed": "历史未确认 · 已收尾", "verifying": "核验中", "unknown_result": "结果未知", "stalled": "等待核验", "skipped": "已跳过", "blocked": "被阻止", "deferred": "稍后重试", "pending": "等待执行", "in_flight": "执行中"][status] ?? status
}

func resultLabel(_ result: String?) -> String {
    guard let result else { return "待确认" }
    return ["accepted": "已接受", "not_sent": "未发送", "unknown": "未知", "active": "已启动", "unconfirmed": "未确认"][result] ?? result
}
