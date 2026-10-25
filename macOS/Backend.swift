import Foundation

enum Backend {
    static let support = ProcessInfo.processInfo.environment["AIQUOTA5H_HOME"].map { URL(fileURLWithPath: $0) }
        ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/AIQuota5h")

    static func run(_ arguments: [String]) async throws -> Data {
        try await Task.detached(priority: .userInitiated) {
            let config = try Data(contentsOf: support.appendingPathComponent("config.json"))
            guard let json = try JSONSerialization.jsonObject(with: config) as? [String: Any],
                  let node = json["nodePath"] as? String, node.hasPrefix("/") else {
                throw NSError(domain: "AIQuota5h", code: 1, userInfo: [NSLocalizedDescriptionKey: "后台尚未安装，请先按 README 安装后台服务。"])
            }
            let process = Process()
            process.executableURL = URL(fileURLWithPath: node)
            process.arguments = [support.appendingPathComponent("app/index.js").path] + arguments
            var environment = ProcessInfo.processInfo.environment
            environment["AIQUOTA5H_HOME"] = support.path
            process.environment = environment
            let output = Pipe()
            let errors = Pipe()
            process.standardOutput = output
            process.standardError = errors
            try process.run()
            // Service lifecycle commands wait for the daemon; quota collection stays in the daemon.
            let timeoutSeconds = ["start", "stop"].contains(arguments.first ?? "") ? 25 : 12
            let timeout = DispatchWorkItem { if process.isRunning { process.terminate() } }
            DispatchQueue.global().asyncAfter(deadline: .now() + .seconds(timeoutSeconds), execute: timeout)
            let data = output.fileHandleForReading.readDataToEndOfFile()
            let errorData = errors.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            timeout.cancel()
            guard process.terminationStatus == 0 else {
                let text = String(data: errorData, encoding: .utf8) ?? "后台命令失败或超时"
                throw NSError(domain: "AIQuota5h", code: Int(process.terminationStatus), userInfo: [NSLocalizedDescriptionKey: text])
            }
            return data
        }.value
    }
}
