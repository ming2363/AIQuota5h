import AppKit
import SwiftUI

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    let model = AppModel()
    private var statusItem: NSStatusItem!
    private var window: NSWindow?
    private var timer: Timer?
    private var lastPoll = Date.distantPast
    private var fullyExiting = false
    private var startupTask: Task<Void, Never>?
    private let fullQuitItem = NSMenuItem(title: "完全退出（同时停止后台）", action: #selector(quitEverything), keyEquivalent: "")
    private let stateItem = NSMenuItem(title: "正在读取状态…", action: nil, keyEquivalent: "")

    func applicationDidFinishLaunching(_ notification: Notification) {
        let others = NSRunningApplication.runningApplications(withBundleIdentifier: Bundle.main.bundleIdentifier ?? "com.zhangming.aiquota5h.app")
            .filter { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }
        if let other = others.first {
            other.activate(options: [])
            NSApp.terminate(nil)
            return
        }
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.image = NSImage(systemSymbolName: "gauge.with.dots.needle.50percent", accessibilityDescription: "AIQuota5h")
        let menu = NSMenu()
        menu.autoenablesItems = false
        stateItem.isEnabled = false
        menu.addItem(stateItem)
        menu.addItem(.separator())
        let open = NSMenuItem(title: "打开激活管理…", action: #selector(openWindow), keyEquivalent: ",")
        open.target = self
        menu.addItem(open)
        let logs = NSMenuItem(title: "打开日志", action: #selector(openLogs), keyEquivalent: "")
        logs.target = self
        menu.addItem(logs)
        menu.addItem(.separator())
        let quit = NSMenuItem(title: "退出管理界面（后台继续运行）", action: #selector(quitApp), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)
        fullQuitItem.target = self
        menu.addItem(fullQuitItem)
        statusItem.menu = menu
        model.onUpdate = { [weak self] in
            guard let self, !self.fullyExiting, let data = model.dashboard else { return }
            self.stateItem.title = data.running ? "后台运行中 · \(data.pools.count) 个额度池" : "后台未运行"
        }
        timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self, !self.fullyExiting else { return }
                if self.window?.isVisible == true || Date().timeIntervalSince(self.lastPoll) >= 15 {
                    self.lastPoll = Date()
                    await self.model.reload()
                }
            }
        }
        if !CommandLine.arguments.contains("--background") { openWindow() }
        startupTask = Task {
            do {
                _ = try await Backend.run(["start"])
                await model.reload()
            } catch {
                await model.reload()
                model.error = "后台恢复失败：\(error.localizedDescription)"
                openWindow()
            }
        }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        openWindow()
        return true
    }

    @objc func openWindow() {
        if window == nil {
            let host = NSHostingController(rootView: DashboardView(model: model))
            let created = NSWindow(contentViewController: host)
            created.title = "AIQuota5h · 窗口自动激活"
            created.styleMask = [.titled, .closable, .miniaturizable, .resizable]
            created.setContentSize(NSSize(width: 920, height: 780))
            created.minSize = NSSize(width: 800, height: 680)
            created.isReleasedWhenClosed = false
            created.delegate = self
            created.center()
            window = created
        }
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
    }

    func windowWillClose(_ notification: Notification) { NSApp.setActivationPolicy(.accessory) }
    @objc func openLogs() { model.revealLogs() }
    @objc func quitApp() {
        guard !fullyExiting else { return }
        NSApp.terminate(nil)
    }
    @objc func quitEverything() {
        guard !fullyExiting else { return }
        fullyExiting = true
        fullQuitItem.isEnabled = false
        stateItem.title = "正在停止后台…"
        Task {
            // Finish any in-progress startup first, so it cannot restart after stop succeeds.
            await startupTask?.value
            do {
                _ = try await Backend.run(["stop"])
                NSApp.terminate(nil)
            } catch {
                fullyExiting = false
                fullQuitItem.isEnabled = true
                await model.reload()
                model.error = "完全退出失败：\(error.localizedDescription)"
                openWindow()
            }
        }
    }
}

MainActor.assumeIsolated {
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    app.setActivationPolicy(.accessory)
    withExtendedLifetime(delegate) { app.run() }
}
