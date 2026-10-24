import AppKit
import SwiftUI
import ServiceManagement

@MainActor
final class AppModel: ObservableObject {
    @Published var dashboard: Dashboard?
    @Published var history: HistoryPage?
    @Published var reads: ReadPage?
    @Published var error = ""
    @Published var busy = false
    @Published var page = 0
    @Published var readPage = 0
    @Published var loginEnabled = SMAppService.mainApp.status == .enabled
    @Published var loginMessage = ""
    var onUpdate: (() -> Void)?

    func reload() async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do {
            let data = try await Backend.run(["dashboard"])
            dashboard = try JSONDecoder().decode(Dashboard.self, from: data)
            let records = try await Backend.run(["history", String(page * 30)])
            history = try JSONDecoder().decode(HistoryPage.self, from: records)
            reads = try JSONDecoder().decode(ReadPage.self, from: await Backend.run(["reads", String(readPage * 30)]))
            error = ""
            onUpdate?()
        } catch { self.error = error.localizedDescription }
    }

    func changePage(_ delta: Int) {
        guard !busy else { return }
        page = max(0, page + delta)
        Task { await reload() }
    }

    func changeReadPage(_ delta: Int) {
        guard !busy else { return }
        readPage = max(0, readPage + delta)
        Task { await reload() }
    }

    func perform(_ arguments: [String]) {
        guard !busy else { return }
        busy = true
        Task {
            do {
                _ = try await Backend.run(arguments)
                busy = false
                await reload()
            } catch { busy = false; self.error = error.localizedDescription }
        }
    }

    func revealLogs() {
        let url = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/AIQuota5h")
        NSWorkspace.shared.open(url)
    }

    func setLoginEnabled(_ enabled: Bool) {
        do {
            if enabled { try SMAppService.mainApp.register() }
            else { try SMAppService.mainApp.unregister() }
            loginEnabled = SMAppService.mainApp.status == .enabled
            loginMessage = SMAppService.mainApp.status == .requiresApproval ? "需要在系统设置的登录项中允许 AIQuota5h。" : ""
        } catch { loginMessage = error.localizedDescription }
    }
}
