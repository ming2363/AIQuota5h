import Foundation

struct Dashboard: Decodable {
    let version: Int
    let generatedAt: Double
    let running: Bool
    let paused: Bool
    let pools: [QuotaPool]
    let providers: [QuotaProvider]
    let refreshPending: Bool
}

struct QuotaProvider: Decodable, Identifiable {
    let id: String
    let name: String
    let auth: String
    let hasSnapshot: Bool
    let monitoring: Bool
    let lastRead: ReadSummary?
    let nextRetryAt: Double?
    let refreshIntervalMs: Double?
}

struct ReadSummary: Decodable {
    let status: String
    let detail: String
    let startedAt: Double
    let finishedAt: Double?
}

struct QuotaPool: Decodable, Identifiable {
    let id: String
    let provider: String
    let poolId: String
    let name: String
    let account: String
    let selectedModel: String?
    let models: [String]
    let observedAt: Double
    let stale: Bool
    let billingSafety: String
    let blockReason: String?
    let guards: [Int]
    let monitoring: Bool
    let autoActivate: Bool
    let activationSupported: Bool
    let lastRead: ReadSummary?
    let nextRetryAt: Double?
    let windows: [QuotaWindow]
}

struct ReadPage: Decodable {
    let total: Int
    let items: [ReadItem]
}

struct ReadItem: Decodable, Identifiable {
    let id: Int
    let provider: String
    let at: Double
    let finishedAt: Double?
    let reason: String
    let status: String
    let detail: String
}

struct QuotaWindow: Decodable, Identifiable {
    let id: String
    let name: String
    let state: String
    let activationMode: String
    let allowance: String
    let remainingFraction: Double?
    let resetAt: Double?
    let dueAt: Double?
    let evidence: [String]
}

struct HistoryPage: Decodable {
    let total: Int
    let offset: Int
    let limit: Int
    let items: [HistoryItem]
}

struct HistoryItem: Decodable, Identifiable {
    let id: Int
    let provider: String
    let pool: String
    let window: String
    let status: String
    let attempts: Int
    let at: Double
    let updatedAt: Double
    let messageResult: String?
    let windowResult: String?
    let detail: String
}

func dateText(_ milliseconds: Double) -> String {
    Date(timeIntervalSince1970: milliseconds / 1000).formatted(date: .abbreviated, time: .standard)
}

func countdown(_ milliseconds: Double, now: Date) -> String {
    let seconds = max(0, Int(milliseconds / 1000 - now.timeIntervalSince1970))
    if seconds == 0 { return "已到重置时间，等待刷新" }
    let days = seconds / 86400
    let hours = seconds % 86400 / 3600
    let minutes = seconds % 3600 / 60
    return days > 0 ? "\(days) 天 \(hours) 小时后重置" : hours > 0 ? "\(hours) 小时 \(minutes) 分钟后重置" : "\(minutes) 分 \(seconds % 60) 秒后重置"
}
