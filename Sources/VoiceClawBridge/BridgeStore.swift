import AppKit
import Foundation
import Security

enum CompanionRealtimeAuthMode: String, CaseIterable, Identifiable {
    case apiKey = "api-key"
    case openClawOAuth = "openclaw-oauth"

    var id: String { rawValue }

    var label: String {
        switch self {
        case .apiKey:
            "API Key"
        case .openClawOAuth:
            "OpenClaw OAuth"
        }
    }

    var detail: String {
        switch self {
        case .apiKey:
            "Use the OpenAI API key from the iPhone or the bridge environment."
        case .openClawOAuth:
            "Use OpenClaw's ChatGPT/Codex login on this Mac to mint short-lived GPT-Realtime-2 client secrets."
        }
    }
}

@MainActor
final class BridgeStore: ObservableObject {
    private enum DefaultsKeys {
        static let includeOpenAIAPIKeyInPairing = "voiceclaw.includeOpenAIAPIKeyInPairing"
        static let realtimeAuthMode = "voiceclaw.realtimeAuthMode"
        static let realtimeAuthFallbackToAPIKey = "voiceclaw.realtimeAuthFallbackToAPIKey"
    }

    @Published var port: String = "3191"
    @Published var openClawInstallPath: String = "\(NSHomeDirectory())/.openclaw"
    @Published var openAIAPIKey: String = "" {
        didSet {
            CompanionKeychainStore.save(openAIAPIKey, account: "openai.apiKey")
            refreshPairingPayloadSecrets()
        }
    }
    @Published var includeOpenAIAPIKeyInPairing: Bool = true {
        didSet {
            UserDefaults.standard.set(includeOpenAIAPIKeyInPairing, forKey: DefaultsKeys.includeOpenAIAPIKeyInPairing)
            refreshPairingPayloadSecrets()
        }
    }
    @Published var realtimeAuthMode: CompanionRealtimeAuthMode = .apiKey {
        didSet {
            UserDefaults.standard.set(realtimeAuthMode.rawValue, forKey: DefaultsKeys.realtimeAuthMode)
            refreshPairingPayloadSecrets()
            Task { await persistBridgeAuthDefaults() }
        }
    }
    @Published var realtimeAuthFallbackToAPIKey: Bool = true {
        didSet {
            UserDefaults.standard.set(realtimeAuthFallbackToAPIKey, forKey: DefaultsKeys.realtimeAuthFallbackToAPIKey)
            refreshPairingPayloadSecrets()
            Task { await persistBridgeAuthDefaults() }
        }
    }
    @Published var status: BridgeStatus = .idle
    @Published var bridgeURL: String = ""
    @Published var tailscaleSummary: String = "Not checked"
    @Published var localBridgeSummary: String = "Not checked"
    @Published var pairingJSON: String = ""
    @Published var pairingPreview: String = ""
    @Published var pairingURL: String = ""
    @Published var lastLog: String = ""
    @Published var lastRefreshDate: Date?
    @Published var setupAdvice: String = "Click Install and Start to install the bridge and configure Tailscale Serve for this port."
    @Published var canResetTailscaleMapping: Bool = false
    @Published var updateSummary: String = "Updates have not been checked."
    @Published var updateAvailable: Bool = false
    @Published var isCheckingForUpdates: Bool = false
    @Published var latestReleaseURL: URL? = URL(string: "https://github.com/bdjben/Voice.Claw-Companion/releases/latest")
    @Published var latestDMGName: String = ""

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
        openAIAPIKey = CompanionKeychainStore.load(account: "openai.apiKey") ?? ""
        if UserDefaults.standard.object(forKey: DefaultsKeys.includeOpenAIAPIKeyInPairing) != nil {
            includeOpenAIAPIKeyInPairing = UserDefaults.standard.bool(forKey: DefaultsKeys.includeOpenAIAPIKeyInPairing)
        }
        if let savedMode = UserDefaults.standard.string(forKey: DefaultsKeys.realtimeAuthMode),
           let mode = CompanionRealtimeAuthMode(rawValue: savedMode) {
            realtimeAuthMode = mode
        }
        if UserDefaults.standard.object(forKey: DefaultsKeys.realtimeAuthFallbackToAPIKey) != nil {
            realtimeAuthFallbackToAPIKey = UserDefaults.standard.bool(forKey: DefaultsKeys.realtimeAuthFallbackToAPIKey)
        }
        Task {
            await loadSavedBridgeConfig()
            await refreshStatus()
            await checkForUpdates(manual: false)
        }
    }

    func refreshStatus() async {
        await refreshBridgeDiagnostics()
        lastRefreshDate = Date()
    }

    func setupBridge() async {
        guard let portValue = Int(port.trimmingCharacters(in: .whitespacesAndNewlines)),
              (1024...65535).contains(portValue)
        else {
            lastLog = "Choose a port from 1024 to 65535. Ports below 1024 are system ports and can fail without extra macOS privileges."
            status = .failed("Choose a valid port.")
            return
        }

        status = .working("Setting Up Bridge")
        lastLog = ""

        do {
            let output = try await runSetupScript(
                arguments: [
                    "--install",
                    "--start",
                    "--tailscale",
                    "--json",
                    "--port",
                    String(portValue),
                    "--openclaw-path",
                    normalizedOpenClawPath,
                    "--realtime-auth-mode",
                    realtimeAuthMode.rawValue,
                    realtimeAuthFallbackToAPIKey ? "--realtime-auth-fallback-to-api-key" : "--no-realtime-auth-fallback-to-api-key",
                ]
            )

            let trimmed = output.trimmingCharacters(in: .whitespacesAndNewlines)
            updatePairingPayload(from: trimmed)
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
        bridgeURL = ""
        pairingJSON = ""
        pairingPreview = ""
        pairingURL = ""
        lastLog = "Selected the default bridge port. Click Install and Start to create a fresh setup payload for this port."
    }

    func openTailscaleInstallPage() {
        NSWorkspace.shared.open(URL(string: "https://tailscale.com/download/mac")!)
    }

    func openTailscaleServeDocs() {
        NSWorkspace.shared.open(URL(string: "https://tailscale.com/docs/features/tailscale-serve")!)
    }

    func openTailscaleAdminConsole() {
        NSWorkspace.shared.open(URL(string: "https://login.tailscale.com/admin/dns")!)
    }

    func openNodeInstallPage() {
        NSWorkspace.shared.open(URL(string: "https://nodejs.org/en/download")!)
    }

    func openOpenClawFolder() {
        NSWorkspace.shared.open(URL(fileURLWithPath: normalizedOpenClawPath, isDirectory: true))
    }

    func openLatestRelease() {
        if let latestReleaseURL {
            NSWorkspace.shared.open(latestReleaseURL)
        } else if let releasesURL = URL(string: "https://github.com/bdjben/Voice.Claw-Companion/releases") {
            NSWorkspace.shared.open(releasesURL)
        }
    }

    func checkForUpdates(manual: Bool = true) async {
        guard !isCheckingForUpdates else { return }

        isCheckingForUpdates = true
        if manual {
            updateSummary = "Checking GitHub Releases for a notarized Voice.Claw Companion update..."
        }
        defer { isCheckingForUpdates = false }

        do {
            var request = URLRequest(url: URL(string: "https://api.github.com/repos/bdjben/Voice.Claw-Companion/releases/latest")!)
            request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
            request.setValue("VoiceClawCompanion", forHTTPHeaderField: "User-Agent")

            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse,
                  (200..<300).contains(http.statusCode)
            else {
                throw BridgeProcessError(message: "GitHub returned an unexpected response.")
            }

            let release = try JSONDecoder().decode(GitHubRelease.self, from: data)
            latestReleaseURL = release.htmlURL
            latestDMGName = release.preferredDMGAsset?.name ?? ""

            guard let latestVersion = Self.normalizedVersion(release.tagName),
                  !latestVersion.isEmpty
            else {
                updateAvailable = false
                updateSummary = "Latest release found, but its version could not be read. Open GitHub Releases to verify the newest notarized DMG."
                return
            }

            guard release.preferredDMGAsset != nil else {
                updateAvailable = false
                updateSummary = "Latest release is \(release.tagName), but no DMG download is attached yet. Wait for a notarized DMG before updating."
                return
            }

            guard let currentVersion = Self.currentCompanionVersion,
                  !currentVersion.isEmpty
            else {
                updateAvailable = true
                updateSummary = "Latest release is \(release.tagName) with \(latestDMGName). This build's version is unavailable, so open GitHub Releases to compare."
                return
            }

            if Self.compareVersions(latestVersion, currentVersion) == .orderedDescending {
                updateAvailable = true
                updateSummary = "Update \(release.tagName) is available. Download \(latestDMGName) from GitHub Releases."
            } else {
                updateAvailable = false
                updateSummary = "Voice.Claw Companion is up to date at \(currentVersion). Latest DMG: \(latestDMGName)."
            }
        } catch {
            updateAvailable = false
            updateSummary = "Could not check GitHub Releases: \(error.localizedDescription)"
        }
    }

    func chooseFreshTestPort() async {
        status = .working("Choosing Fresh Port")
        do {
            let output = try await runSetupScript(arguments: ["--suggest-port", "--json"])
            let data = Data(output.utf8)
            let response = try JSONDecoder().decode(SuggestedPortResponse.self, from: data)
            port = String(response.suggestedPort)
            bridgeURL = ""
            pairingJSON = ""
            pairingPreview = ""
            pairingURL = ""
            lastLog = "Selected unused test port \(response.suggestedPort). Nothing changed on this Mac yet. Click Install and Start to configure the bridge and Tailscale Serve for this port, then pair the iPhone again."
            status = .idle
            await refreshStatus()
        } catch {
            lastLog = Self.userFacingSetupError(error)
            status = .failed("Could Not Choose Port")
        }
    }

    func resetForFirstRun(removeTailscaleMapping: Bool = false) async {
        status = .working(removeTailscaleMapping ? "Resetting App and Network Mapping" : "Resetting")
        do {
            var arguments = ["--reset", "--json"]
            if removeTailscaleMapping {
                arguments.append(contentsOf: ["--reset-tailscale-port", "--port", port])
            }
            let output = try await runSetupScript(arguments: arguments)
            let resetResponse = try? JSONDecoder().decode(ResetResponse.self, from: Data(output.utf8))
            port = "3191"
            openClawInstallPath = "\(NSHomeDirectory())/.openclaw"
            bridgeURL = ""
            tailscaleSummary = "Not checked"
            localBridgeSummary = "Not checked"
            pairingJSON = ""
            pairingPreview = ""
            pairingURL = ""
            if removeTailscaleMapping {
                let networkSummary = resetResponse?.tailscaleReset?.summary ?? "No matching Voice.Claw Tailscale Serve mapping needed removal."
                lastLog = "Reset complete. Voice.Claw removed its LaunchAgent and local bridge config. \(networkSummary) Tailscale itself, OpenClaw, and Node.js were not changed."
            } else {
                lastLog = "Reset complete. Voice.Claw removed its LaunchAgent and local bridge config only. Tailscale, OpenClaw, Node.js, and tailnet settings were not changed."
            }
            status = .idle
            await refreshStatus()
        } catch {
            lastLog = Self.userFacingSetupError(error)
            status = .failed("Reset Failed")
        }
    }

    private func runSetupScript(arguments: [String]) async throws -> String {
        try await runner.run(
            executable: try await resolveNodeExecutable(),
            arguments: ["scripts/voiceclaw-bridge-setup.mjs"] + arguments,
            workingDirectory: projectRoot,
            environment: ["VOICECLAW_BRIDGE_ROOT": projectRoot.path]
        )
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
        if let savedMode = object["realtimeAuthMode"] as? String,
           let mode = CompanionRealtimeAuthMode(rawValue: savedMode) {
            realtimeAuthMode = mode
        }
        if let fallback = object["realtimeAuthFallbackToAPIKey"] as? Bool {
            realtimeAuthFallbackToAPIKey = fallback
        }

        let payload = Self.pairingPayload(from: object)
        updatePairingPayload(payload)
    }

    private func updatePairingPayload(from json: String) {
        guard let data = json.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            pairingJSON = json
            pairingPreview = Self.redactedPairingJSON(json)
            pairingURL = Self.deepLink(for: json)
            return
        }

        updatePairingPayload(object)
    }

    private func updatePairingPayload(_ payload: [String: Any]) {
        var updated = payload
        let trimmedKey = openAIAPIKey.trimmingCharacters(in: .whitespacesAndNewlines)
        if includeOpenAIAPIKeyInPairing, !trimmedKey.isEmpty {
            updated["OpenAIAPIKey"] = trimmedKey
        } else {
            updated.removeValue(forKey: "OpenAIAPIKey")
        }
        updated["RealtimeAuthMode"] = realtimeAuthMode.rawValue
        updated["RealtimeAuthFallbackToAPIKey"] = realtimeAuthFallbackToAPIKey
        updated["InstantModel"] = updated["InstantModel"] as? String ?? "gpt-5-chat-latest"
        updated["InstantWebSearch"] = updated["InstantWebSearch"] as? Bool ?? true

        guard let data = try? JSONSerialization.data(withJSONObject: updated, options: [.prettyPrinted]),
              let json = String(data: data, encoding: .utf8)
        else { return }

        pairingJSON = json
        pairingPreview = Self.redactedPairingJSON(json)
        pairingURL = Self.deepLink(for: json)
    }

    private func refreshPairingPayloadSecrets() {
        guard !pairingJSON.isEmpty else { return }
        updatePairingPayload(from: pairingJSON)
    }

    private func persistBridgeAuthDefaults() async {
        let configURL = URL(fileURLWithPath: "\(NSHomeDirectory())/.voiceclaw/bridge.json")
        guard let data = try? Data(contentsOf: configURL),
              var object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return }

        object["realtimeAuthMode"] = realtimeAuthMode.rawValue
        object["realtimeAuthFallbackToAPIKey"] = realtimeAuthFallbackToAPIKey

        guard let output = try? JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted]) else { return }
        try? output.write(to: configURL, options: [.atomic])
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: configURL.path)
    }

    private func refreshBridgeDiagnostics() async {
        do {
            let output = try await runSetupScript(arguments: ["--diagnose", "--json", "--port", port])
            let diagnostics = try JSONDecoder().decode(BridgeDiagnostics.self, from: Data(output.utf8))
            localBridgeSummary = diagnostics.local.summary
            tailscaleSummary = diagnostics.tailscale.summary
            setupAdvice = diagnostics.suggestedAction
            canResetTailscaleMapping = diagnostics.tailscale.canClearSafely ?? false

            guard !status.isWorking else { return }
            if diagnostics.local.state == "running", diagnostics.tailscale.state == "voiceclaw_mapping" {
                status = .ready
            } else if diagnostics.tailscale.state == "stale_voiceclaw_mapping" || diagnostics.tailscale.state == "occupied_by_other_mapping" || (diagnostics.savedConfigExists && diagnostics.tailscale.state == "not_available") {
                status = .warning("Bridge Needs Attention")
            } else if case .ready = status {
                status = .idle
            } else if case .warning = status {
                status = .idle
            }
        } catch {
            localBridgeSummary = "Diagnostics could not run."
            tailscaleSummary = Self.userFacingSetupError(error)
            setupAdvice = "Install Node.js and Tailscale if needed, then click Install and Start."
            canResetTailscaleMapping = false
            if !status.isWorking {
                status = .warning("Diagnostics Need Attention")
            }
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
            let detail = raw.isEmpty ? "" : "\n\nTailscale detail: \(raw)"
            return "Tailscale Serve could not be configured. Serve is Tailscale's private HTTPS proxy for exposing this Mac's local Voice.Claw bridge only inside your tailnet.\n\nTry these in order:\n1. Open Tailscale on this Mac and confirm it is signed in.\n2. In the Tailscale admin console, make sure HTTPS certificates are enabled for the tailnet.\n3. Confirm this Mac and the iPhone are in the same tailnet.\n4. Come back here and click Install and Start again.\n\nVoice.Claw looks for the Tailscale command in the standard macOS install locations and only changes Tailscale Serve when you click Install and Start; Check Again is read-only.\(detail)"
        }

        if lower.contains("openclaw config was not found") || lower.contains("openclaw.json") {
            return "\(raw)\n\nThe install path should be the folder that contains openclaw.json. On this Mac, that is usually ~/.openclaw, not ~/openclaw."
        }

        if lower.contains("launchctl") || lower.contains("bootstrap") || lower.contains("launch agent") {
            return "macOS could not install or start the Voice.Claw LaunchAgent. Make sure this user account can write to ~/Library/LaunchAgents, then try Install and Start again."
        }

        if raw.isEmpty {
            return "Setup failed before returning details. Check that Node.js and Tailscale are installed, then try Install and Start again."
        }

        return "\(raw)\n\nCheck that Node.js and Tailscale are installed, that the OpenClaw path contains openclaw.json, and that the selected port is free. Then try Install and Start again."
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

    private static var currentCompanionVersion: String? {
        let value = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String
        return normalizedVersion(value ?? "")
    }

    private static func normalizedVersion(_ value: String) -> String? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let noPrefix = trimmed.hasPrefix("v") ? String(trimmed.dropFirst()) : trimmed
        let version = noPrefix
            .split(separator: "-", maxSplits: 1, omittingEmptySubsequences: true)
            .first
            .map(String.init) ?? noPrefix
        return version.allSatisfy { $0.isNumber || $0 == "." } ? version : nil
    }

    private static func compareVersions(_ lhs: String, _ rhs: String) -> ComparisonResult {
        let left = lhs.split(separator: ".").map { Int($0) ?? 0 }
        let right = rhs.split(separator: ".").map { Int($0) ?? 0 }
        let count = max(left.count, right.count)

        for index in 0..<count {
            let a = index < left.count ? left[index] : 0
            let b = index < right.count ? right[index] : 0
            if a < b { return .orderedAscending }
            if a > b { return .orderedDescending }
        }

        return .orderedSame
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
            "InstantModel": "gpt-5-chat-latest",
            "InstantWebSearch": true,
            "RealtimeAuthMode": config["realtimeAuthMode"] as? String ?? CompanionRealtimeAuthMode.apiKey.rawValue,
            "RealtimeAuthFallbackToAPIKey": config["realtimeAuthFallbackToAPIKey"] as? Bool ?? true,
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
        if let key = object["OpenAIAPIKey"] as? String, !key.isEmpty {
            object["OpenAIAPIKey"] = "••••••••••••\(key.suffix(4))"
        }

        guard let redacted = try? JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted]),
              let string = String(data: redacted, encoding: .utf8)
        else { return json }

        return string
    }
}

private struct GitHubRelease: Decodable {
    let tagName: String
    let htmlURL: URL
    let assets: [Asset]

    var preferredDMGAsset: Asset? {
        assets.first { asset in
            let lowercased = asset.name.lowercased()
            return lowercased.hasSuffix(".dmg") && !lowercased.contains("unnotarized")
        }
    }

    enum CodingKeys: String, CodingKey {
        case tagName = "tag_name"
        case htmlURL = "html_url"
        case assets
    }

    struct Asset: Decodable {
        let name: String
        let browserDownloadURL: URL?

        enum CodingKeys: String, CodingKey {
            case name
            case browserDownloadURL = "browser_download_url"
        }
    }
}

private struct SuggestedPortResponse: Decodable {
    let suggestedPort: Int
}

private struct ResetResponse: Decodable {
    let tailscaleReset: TailscaleReset?

    struct TailscaleReset: Decodable {
        let removed: Bool?
        let summary: String?
    }
}

private struct BridgeDiagnostics: Decodable {
    let savedConfigExists: Bool
    let local: Component
    let tailscale: Component
    let suggestedAction: String

    struct Component: Decodable {
        let state: String
        let summary: String
        let canClearSafely: Bool?
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

enum CompanionKeychainStore {
    private static let service = "ai.voiceclaw.bridge"

    static func save(_ value: String, account: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]

        SecItemDelete(query as CFDictionary)

        guard !value.isEmpty,
              let data = value.data(using: .utf8)
        else { return }

        var attributes = query
        attributes[kSecValueData as String] = data
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(attributes as CFDictionary, nil)
    }

    static func load(account: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess,
              let data = result as? Data
        else { return nil }

        return String(data: data, encoding: .utf8)
    }
}
