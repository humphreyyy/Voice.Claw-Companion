import AppKit
import Foundation

@MainActor
final class BridgeStore: ObservableObject {
    @Published var port: String = "3191"
    @Published var openClawInstallPath: String = "\(NSHomeDirectory())/.openclaw"
    @Published var status: BridgeStatus = .idle
    @Published var bridgeURL: String = ""
    @Published var tailscaleSummary: String = "Not checked"
    @Published var localBridgeSummary: String = "Not checked"
    @Published var pairingJSON: String = ""
    @Published var pairingPreview: String = ""
    @Published var pairingURL: String = ""
    @Published var lastLog: String = ""
    @Published var lastRefreshDate: Date?

    private let runner = ProcessRunner()
    private lazy var projectRoot: URL = Self.resolveProjectRoot()

    enum BridgeStatus: Equatable {
        case idle
        case working(String)
        case ready
        case warning(String)
        case failed(String)

        var title: String {
            switch self {
            case .idle:
                "Ready to Set Up"
            case let .working(message):
                message
            case .ready:
                "Bridge Ready"
            case let .warning(message):
                message
            case let .failed(message):
                message
            }
        }

        var isWorking: Bool {
            if case .working = self { return true }
            return false
        }
    }

    init() {
        Task { await refreshStatus() }
    }

    func refreshStatus() async {
        await loadSavedBridgeConfig()
        await refreshLocalBridge()
        await refreshTailscaleServe()
        lastRefreshDate = Date()
    }

    func setupBridge() async {
        guard let portValue = Int(port.trimmingCharacters(in: .whitespacesAndNewlines)),
              (1...65535).contains(portValue)
        else {
            status = .failed("Choose a valid port.")
            return
        }

        status = .working("Setting Up Bridge")
        lastLog = ""

        do {
            let nodeExecutable = try await resolveNodeExecutable()
            let output = try await runner.run(
                executable: nodeExecutable,
                arguments: [
                    "scripts/voiceclaw-bridge-setup.mjs",
                    "--install",
                    "--start",
                    "--tailscale",
                    "--json",
                    "--port",
                    String(portValue),
                    "--openclaw-path",
                    normalizedOpenClawPath,
                ],
                workingDirectory: projectRoot,
                environment: ["VOICECLAW_BRIDGE_ROOT": projectRoot.path]
            )

            let trimmed = output.trimmingCharacters(in: .whitespacesAndNewlines)
            pairingJSON = trimmed
            pairingPreview = Self.redactedPairingJSON(trimmed)
            pairingURL = Self.deepLink(for: trimmed)
            lastLog = "Setup completed. Copy or scan the iPhone setup payload."
            status = .ready
            await refreshStatus()
        } catch {
            lastLog = Self.userFacingSetupError(error)
            status = .failed("Setup Failed")
        }
    }

    func copyPairingPayload() {
        guard !pairingJSON.isEmpty else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(pairingJSON, forType: .string)
        lastLog = "Copied iPhone setup JSON."
    }

    func copyPairingLink() {
        guard !pairingURL.isEmpty else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(pairingURL, forType: .string)
        lastLog = "Copied VoiceClaw setup link."
    }

    func useDefaultPort() {
        port = "3191"
    }

    func openTailscaleInstallPage() {
        NSWorkspace.shared.open(URL(string: "https://tailscale.com/download/mac")!)
    }

    func openNodeInstallPage() {
        NSWorkspace.shared.open(URL(string: "https://nodejs.org/en/download")!)
    }

    func openOpenClawFolder() {
        NSWorkspace.shared.open(URL(fileURLWithPath: normalizedOpenClawPath, isDirectory: true))
    }

    private var normalizedOpenClawPath: String {
        let trimmed = openClawInstallPath.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "\(NSHomeDirectory())/.openclaw" : trimmed.replacingOccurrences(of: "/+$", with: "", options: .regularExpression)
    }

    private func loadSavedBridgeConfig() async {
        let configURL = URL(fileURLWithPath: "\(NSHomeDirectory())/.voiceclaw/bridge.json")
        guard let data = try? Data(contentsOf: configURL),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return }

        if let savedPort = object["port"] as? Int {
            port = String(savedPort)
        }
        if let savedPath = object["openClawInstallPath"] as? String, !savedPath.isEmpty {
            openClawInstallPath = savedPath
        }
        if let savedURL = object["tailscaleBaseURL"] as? String {
            bridgeURL = savedURL
        }

        let payload = Self.pairingPayload(from: object)
        if let data = try? JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted]),
           let json = String(data: data, encoding: .utf8) {
            pairingJSON = json
            pairingPreview = Self.redactedPairingJSON(json)
            pairingURL = Self.deepLink(for: json)
        }
    }

    private func refreshLocalBridge() async {
        guard let portValue = Int(port) else {
            localBridgeSummary = "Invalid port"
            return
        }

        do {
            let url = URL(string: "http://127.0.0.1:\(portValue)/healthz")!
            var request = URLRequest(url: url)
            request.timeoutInterval = 3
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                localBridgeSummary = "No HTTP response"
                return
            }
            if http.statusCode == 200,
               let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               object["ok"] as? Bool == true {
                let auth = object["auth"] as? [String: Any]
                let authText = (auth?["required"] as? Bool == true) ? "auth on" : "auth off"
                if authText == "auth off", !pairingJSON.isEmpty {
                    localBridgeSummary = "Running on localhost:\(portValue), auth off. Click Install and Start to restart the protected bridge."
                } else {
                    localBridgeSummary = "Running on localhost:\(portValue), \(authText)"
                }
            } else {
                localBridgeSummary = "HTTP \(http.statusCode)"
            }
        } catch {
            localBridgeSummary = "Not running"
        }
    }

    private func refreshTailscaleServe() async {
        do {
            let output = try await runner.run(
                executable: "/usr/bin/env",
                arguments: ["tailscale", "serve", "status"],
                workingDirectory: projectRoot,
                environment: [:]
            )
            let lines = output.split(separator: "\n").map(String.init)
            if let index = lines.firstIndex(where: { $0.contains(":\(port)") || $0.contains("127.0.0.1:\(port)") }) {
                let start = max(0, index - 1)
                let end = min(lines.count, index + 3)
                tailscaleSummary = lines[start..<end].joined(separator: "\n")
            } else {
                tailscaleSummary = lines.prefix(10).joined(separator: "\n")
            }
        } catch {
            tailscaleSummary = "Tailscale Serve is not ready. Install Tailscale, sign in on this Mac, then click Install and Start. This status check is read-only and does not change your Tailscale settings."
        }
    }

    private func resolveNodeExecutable() async throws -> String {
        let candidates = [
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
            "/usr/bin/node",
        ]

        for candidate in candidates where FileManager.default.isExecutableFile(atPath: candidate) {
            return candidate
        }

        do {
            let output = try await runner.run(
                executable: "/usr/bin/env",
                arguments: ["which", "node"],
                workingDirectory: projectRoot,
                environment: [:]
            )
            let resolved = output.trimmingCharacters(in: .whitespacesAndNewlines)
            if !resolved.isEmpty {
                return resolved
            }
        } catch {}

        throw BridgeProcessError(message: "Node.js is not installed or is not available to apps launched from Finder. Install Node.js, reopen Voice.Claw Companion, then click Install and Start again.")
    }

    private static func userFacingSetupError(_ error: Error) -> String {
        let raw = error.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
        let lower = raw.lowercased()

        if lower.contains("node") && (lower.contains("no such file") || lower.contains("not installed") || lower.contains("not found")) {
            return "Node.js is required to run the local bridge, but Voice.Claw Companion could not find it. Install Node.js, reopen the companion app, then click Install and Start again."
        }

        if lower.contains("tailscale") {
            return "Tailscale is required for private iPhone-to-Mac access. Install Tailscale, sign in on this Mac, make sure Tailscale Serve is allowed, then click Install and Start again. The app only changes Tailscale Serve when you click Install and Start."
        }

        if lower.contains("launchctl") || lower.contains("bootstrap") || lower.contains("launch agent") {
            return "macOS could not install or start the Voice.Claw LaunchAgent. Make sure this user account can write to ~/Library/LaunchAgents, then try Install and Start again."
        }

        if raw.isEmpty {
            return "Setup failed before returning details. Check that Node.js and Tailscale are installed, then try Install and Start again."
        }

        return "\(raw)\n\nCheck that Node.js and Tailscale are installed and that the selected port is free, then try Install and Start again."
    }

    private static func resolveProjectRoot() -> URL {
        if let value = ProcessInfo.processInfo.environment["VOICECLAW_BRIDGE_ROOT"], !value.isEmpty {
            return URL(fileURLWithPath: value, isDirectory: true)
        }

        let anchors = [
            Bundle.main.resourceURL?.appendingPathComponent("BridgeRuntime", isDirectory: true),
            URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true),
            Bundle.main.bundleURL,
            URL(fileURLWithPath: #filePath, isDirectory: false),
        ].compactMap { $0 }

        for anchor in anchors {
            var candidate = anchor.hasDirectoryPath ? anchor : anchor.deletingLastPathComponent()
            for _ in 0..<10 {
                if FileManager.default.fileExists(atPath: candidate.appendingPathComponent("package.json").path),
                   FileManager.default.fileExists(atPath: candidate.appendingPathComponent("server/index.js").path) {
                    return candidate
                }
                candidate.deleteLastPathComponent()
            }
        }

        return URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
    }

    private static func pairingPayload(from config: [String: Any]) -> [String: Any] {
        [
            "VoiceClawSetupVersion": 1,
            "TailscaleBaseURL": config["tailscaleBaseURL"] as? String ?? "",
            "BridgePath": "/realtime/openclaw-turn",
            "OpenClawInstallPath": config["openClawInstallPath"] as? String ?? "\(NSHomeDirectory())/.openclaw",
            "OpenClawGatewayToken": config["gatewayToken"] as? String ?? "",
            "RouteMode": "openclaw-bridge",
            "RealtimeModel": "gpt-realtime-2",
        ]
    }

    private static func deepLink(for json: String) -> String {
        let encoded = Data(json.utf8)
            .base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        return "voiceclaw://setup?payload=\(encoded)"
    }

    private static func redactedPairingJSON(_ json: String) -> String {
        guard let data = json.data(using: .utf8),
              var object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return json }

        if let token = object["OpenClawGatewayToken"] as? String, !token.isEmpty {
            object["OpenClawGatewayToken"] = "••••••••••••\(token.suffix(4))"
        }

        guard let redacted = try? JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted]),
              let string = String(data: redacted, encoding: .utf8)
        else { return json }

        return string
    }
}

struct ProcessRunner {
    func run(
        executable: String,
        arguments: [String],
        workingDirectory: URL,
        environment: [String: String]
    ) async throws -> String {
        try await withCheckedThrowingContinuation { continuation in
            let process = Process()
            process.executableURL = URL(fileURLWithPath: executable)
            process.arguments = arguments
            process.currentDirectoryURL = workingDirectory
            process.environment = ProcessInfo.processInfo.environment.merging(environment) { _, new in new }

            let output = Pipe()
            let error = Pipe()
            process.standardOutput = output
            process.standardError = error

            process.terminationHandler = { process in
                let outputData = output.fileHandleForReading.readDataToEndOfFile()
                let errorData = error.fileHandleForReading.readDataToEndOfFile()
                let stdout = String(data: outputData, encoding: .utf8) ?? ""
                let stderr = String(data: errorData, encoding: .utf8) ?? ""

                if process.terminationStatus == 0 {
                    continuation.resume(returning: stdout)
                } else {
                    let message = stderr.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? stdout : stderr
                    continuation.resume(throwing: BridgeProcessError(message: message.trimmingCharacters(in: .whitespacesAndNewlines)))
                }
            }

            do {
                try process.run()
            } catch {
                continuation.resume(throwing: error)
            }
        }
    }
}

struct BridgeProcessError: LocalizedError {
    let message: String

    var errorDescription: String? {
        message.isEmpty ? "Bridge command failed." : message
    }
}
