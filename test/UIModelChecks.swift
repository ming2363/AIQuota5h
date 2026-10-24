import Foundation

@main
struct UIModelChecks {
    static func main() throws {
        let data = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
        let snapshot = try JSONDecoder().decode(Dashboard.self, from: data)
        precondition(snapshot.version == 1)
        precondition(snapshot.providers.contains { $0.id == "claude" })
        precondition(snapshot.pools.contains { $0.windows.contains { $0.remainingFraction != nil } })
        precondition(countdown(3661_000, now: Date(timeIntervalSince1970: 0)) == "1 小时 1 分钟后重置")
        precondition(countdown(0, now: Date()) == "已到重置时间，等待刷新")
        print("Swift 状态解码与倒计时检查通过")
    }
}
