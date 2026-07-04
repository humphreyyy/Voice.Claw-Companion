import AppKit
import CryptoKit
import Foundation
import Security
import ServiceManagement
import Sparkle

enum CompanionRealtimeAuthMode: String, CaseIterable, Identifiable {
    case apiKey = "api-key"
    case openClawOAuth = "openclaw-oauth"

    var id: String { rawValue }

    var label: String {
        switch self {
        case .apiKey:
            "API Key"
        case .openClawOAuth:
            "OAuth (ChatGPT Subscription)"
        }
    }

    var detail: String {
        switch self {
        case .apiKey:
            "Use the OpenAI API key from the paired phone or the bridge environment. This is currently required for GPT-Realtime-2 Live sessions."
        case .openClawOAuth:
            "Reserved for ChatGPT subscription auth after OpenAI re-enables GPT-Realtime-2 Sign-in-with-ChatGPT access. Current GPT-Realtime-2 Live sessions should use API Key mode."
        }
    }
}

enum CompanionUpdateCheckInterval: String, CaseIterable, Identifiable {
    case fiveMinutes = "5m"
    case thirtyMinutes = "30m"
    case oneHour = "1h"

    var id: String { rawValue }

    var label: String {
        switch self {
        case .fiveMinutes:
            "Every 5 minutes"
        case .thirtyMinutes:
            "Every 30 minutes"
        case .oneHour:
            "Every hour"
        }
    }

    var shortLabel: String {
        switch self {
        case .fiveMinutes:
            "5 min"
        case .thirtyMinutes:
            "30 min"
        case .oneHour:
            "1 hour"
        }
    }

    var seconds: TimeInterval {
        switch self {
        case .fiveMinutes:
            5 * 60
        case .thirtyMinutes:
            30 * 60
        case .oneHour:
            60 * 60
        }
    }

    var nanoseconds: UInt64 {
        UInt64(seconds * 1_000_000_000)
    }
}

@MainActor
final class BridgeStore: ObservableObject {
    private enum DefaultsKeys {
        static let includeOpenAIAPIKeyInPairing = "voiceclaw.includeOpenAIAPIKeyInPairing"
        static let watchPublicBridgeURL = "voiceclaw.watchPublicBridgeURL"
        static let openClawAgentName = "voiceclaw.openClawAgentName"
        static let realtimeAuthMode = "voiceclaw.realtimeAuthMode"
        static let realtimeAuthFallbackToAPIKey = "voiceclaw.realtimeAuthFallbackToAPIKey"
        static let automaticUpdateChecksEnabled = "voiceclaw.automaticUpdateChecksEnabled"
        static let automaticUpdateInstallsEnabled = "voiceclaw.automaticUpdateInstallsEnabled"
        static let automaticUpdateCheckInterval = "voiceclaw.automaticUpdateCheckInterval"
        static let launchAtStartupEnabled = "voiceclaw.launchAtStartupEnabled"
    }

    private static let defaultBridgePort = "12321"
    private static let defaultOpenClawAgentName = "main"

    @Published var port: String = BridgeStore.defaultBridgePort
    @Published var openClawInstallPath: String = "\(NSHomeDirectory())/.openclaw"
    @Published var openClawAgentName: String = BridgeStore.defaultOpenClawAgentName {
        didSet {
            UserDefaults.standard.set(openClawAgentName, forKey: DefaultsKeys.openClawAgentName)
            refreshPairingPayloadSecrets()
        }
    }
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
    @Published var watchPublicBridgeURL: String = "" {
        didSet {
            UserDefaults.standard.set(watchPublicBridgeURL, forKey: DefaultsKeys.watchPublicBridgeURL)
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
    @Published var realtimeAuthFallbackToAPIKey: Bool = false {
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
    @Published var realtimeRuntimeSummary: String = "Realtime runtime not checked."
    @Published var realtimeAuthStatusSummary: String = "OpenAI auth status not checked."
    @Published var companionVoiceSummary: String = "Companion Realtime Voice dependencies not checked."
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
    @Published var isDownloadingUpdate: Bool = false
    @Published var automaticUpdateChecksEnabled: Bool = true {
        didSet {
            UserDefaults.standard.set(automaticUpdateChecksEnabled, forKey: DefaultsKeys.automaticUpdateChecksEnabled)
            configureAutomaticUpdateChecks()
            applySparkleUpdatePreferences()
        }
    }
    @Published var automaticUpdateInstallsEnabled: Bool = true {
        didSet {
            UserDefaults.standard.set(automaticUpdateInstallsEnabled, forKey: DefaultsKeys.automaticUpdateInstallsEnabled)
            applySparkleUpdatePreferences()
        }
    }
    @Published var automaticUpdateCheckInterval: CompanionUpdateCheckInterval = .thirtyMinutes {
        didSet {
            UserDefaults.standard.set(automaticUpdateCheckInterval.rawValue, forKey: DefaultsKeys.automaticUpdateCheckInterval)
            configureAutomaticUpdateChecks()
            applySparkleUpdatePreferences()
        }
    }
    @Published var lastUpdateCheckDate: Date?
    @Published var latestReleaseTag: String = ""
    @Published var latestReleaseURL: URL? = URL(string: "https://github.com/bdjben/Voice.Claw-Companion/releases/latest")
    @Published var latestDMGURL: URL?
    @Published var latestDMGName: String = ""
    @Published var latestDMGDigest: String = ""
    @Published var launchAtStartupEnabled: Bool = false
    @Published var launchAtStartupSummary: String = "Launch at startup has not been checked."
    @Published var isUpdatingLaunchAtStartup: Bool = false

    private let runner = ProcessRunner()
    private let sparkleUpdaterController: SPUStandardUpdaterController
    private lazy var projectRoot: URL = Self.resolveProjectRoot()
    private var automaticUpdateTask: Task<Void, Never>?
    private var isSyncingSparkleUpdatePreferences = false
    private var suppressTransientSetupWarningUntil: Date?

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
                "Companion Ready"
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
        sparkleUpdaterController = SPUStandardUpdaterController(startingUpdater: true, updaterDelegate: nil, userDriverDelegate: nil)
        openAIAPIKey = CompanionKeychainStore.load(account: "openai.apiKey") ?? ""
        if UserDefaults.standard.object(forKey: DefaultsKeys.includeOpenAIAPIKeyInPairing) != nil {
            includeOpenAIAPIKeyInPairing = UserDefaults.standard.bool(forKey: DefaultsKeys.includeOpenAIAPIKeyInPairing)
        }
        watchPublicBridgeURL = UserDefaults.standard.string(forKey: DefaultsKeys.watchPublicBridgeURL) ?? ""
        if let savedMode = UserDefaults.standard.string(forKey: DefaultsKeys.realtimeAuthMode),
           let mode = CompanionRealtimeAuthMode(rawValue: savedMode) {
            realtimeAuthMode = mode
        }
        if UserDefaults.standard.object(forKey: DefaultsKeys.realtimeAuthFallbackToAPIKey) != nil {
            realtimeAuthFallbackToAPIKey = UserDefaults.standard.bool(forKey: DefaultsKeys.realtimeAuthFallbackToAPIKey)
        }
        if let savedAgentName = UserDefaults.standard.string(forKey: DefaultsKeys.openClawAgentName),
           !savedAgentName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            openClawAgentName = savedAgentName
        }
        if UserDefaults.standard.object(forKey: DefaultsKeys.automaticUpdateChecksEnabled) != nil {
            automaticUpdateChecksEnabled = UserDefaults.standard.bool(forKey: DefaultsKeys.automaticUpdateChecksEnabled)
        } else if UserDefaults.standard.object(forKey: "SUEnableAutomaticChecks") == nil {
            sparkleUpdaterController.updater.automaticallyChecksForUpdates = true
            automaticUpdateChecksEnabled = true
        }
        if UserDefaults.standard.object(forKey: DefaultsKeys.automaticUpdateInstallsEnabled) != nil {
            automaticUpdateInstallsEnabled = UserDefaults.standard.bool(forKey: DefaultsKeys.automaticUpdateInstallsEnabled)
        } else if UserDefaults.standard.object(forKey: "SUAutomaticallyUpdate") == nil {
            sparkleUpdaterController.updater.automaticallyDownloadsUpdates = true
            automaticUpdateInstallsEnabled = true
        }
        if let savedUpdateInterval = UserDefaults.standard.string(forKey: DefaultsKeys.automaticUpdateCheckInterval),
           let interval = CompanionUpdateCheckInterval(rawValue: savedUpdateInterval) {
            automaticUpdateCheckInterval = interval
        } else {
            automaticUpdateCheckInterval = .thirtyMinutes
        }
        syncSparkleUpdatePreferences()
        applySparkleUpdatePreferences()
        Task {
            await configureLaunchAtStartupOnFirstRun()
            await loadSavedBridgeConfig()
            await refreshStatus()
            await checkForUpdates(manual: false)
            configureAutomaticUpdateChecks()
        }
    }

    func refreshStatus() async {
        refreshLaunchAtStartupStatus()
        await refreshBridgeDiagnostics()
        lastRefreshDate = Date()
    }

    func refreshLaunchAtStartupStatus() {
        let status = SMAppService.mainApp.status
        launchAtStartupEnabled = status == .enabled || status == .requiresApproval
        launchAtStartupSummary = Self.launchAtStartupSummary(for: status)
    }

    func setLaunchAtStartupEnabled(_ enabled: Bool, userInitiated: Bool = true) async {
        guard !isUpdatingLaunchAtStartup else { return }
        isUpdatingLaunchAtStartup = true
        defer { isUpdatingLaunchAtStartup = false }

        do {
            let currentStatus = SMAppService.mainApp.status
            if enabled {
                if currentStatus != .enabled, currentStatus != .requiresApproval {
                    try SMAppService.mainApp.register()
                }
                UserDefaults.standard.set(true, forKey: DefaultsKeys.launchAtStartupEnabled)
            } else {
                if currentStatus == .enabled || currentStatus == .requiresApproval {
                    try await SMAppService.mainApp.unregister()
                }
                UserDefaults.standard.set(false, forKey: DefaultsKeys.launchAtStartupEnabled)
            }
            refreshLaunchAtStartupStatus()
            lastLog = enabled
                ? "VoiceClaw Companion is set to launch when this Mac user logs in."
                : "VoiceClaw Companion will no longer launch automatically at login."
        } catch {
            refreshLaunchAtStartupStatus()
            let action = enabled ? "enable" : "disable"
            let message = "Could not \(action) Launch upon Startup: \(error.localizedDescription)"
            launchAtStartupSummary = message
            if userInitiated {
                lastLog = message
            }
        }
    }

    func setupBridge() async {
        guard let portValue = Int(port.trimmingCharacters(in: .whitespacesAndNewlines)),
              (1024...65535).contains(portValue)
        else {
            lastLog = "Choose a port from 1024 to 65535. Ports below 1024 are system ports and can fail without extra macOS privileges."
            status = .failed("Choose a valid port.")
            return
        }

        status = .working("Setting Up Companion")
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
                    "--openclaw-agent",
                    normalizedOpenClawAgentName,
                    "--realtime-auth-mode",
                    realtimeAuthMode.rawValue,
                    realtimeAuthFallbackToAPIKey ? "--realtime-auth-fallback-to-api-key" : "--no-realtime-auth-fallback-to-api-key",
                ]
            )

            let trimmed = output.trimmingCharacters(in: .whitespacesAndNewlines)
            updatePairingPayload(from: trimmed)
            lastLog = "Setup completed. Copy or scan the phone setup payload."
            status = .ready
            suppressTransientSetupWarningUntil = Date().addingTimeInterval(10)
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
        lastLog = "Copied phone setup JSON."
    }

    func copyPairingLink() {
        guard !pairingURL.isEmpty else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(pairingURL, forType: .string)
        lastLog = "Copied VoiceClaw setup link."
    }

    func useDefaultPort() {
        port = Self.defaultBridgePort
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

    func openLatestDMG() {
        if let latestDMGURL {
            NSWorkspace.shared.open(latestDMGURL)
            lastLog = "Opened the notarized VoiceClaw Companion DMG download."
        } else {
            openLatestRelease()
        }
    }

    func installLatestUpdate() {
        updateSummary = "Opening the VoiceClaw Companion updater. If a signed update is available, Sparkle can download and install it from inside the app."
        sparkleUpdaterController.checkForUpdates(nil)
        syncSparkleUpdatePreferences()
    }

    func downloadLatestDMG() async {
        guard !isDownloadingUpdate else { return }
        guard let latestDMGURL else {
            updateSummary = "No notarized DMG URL is available yet. Check updates first."
            openLatestRelease()
            return
        }

        isDownloadingUpdate = true
        updateSummary = "Downloading notarized VoiceClaw Companion DMG..."
        defer { isDownloadingUpdate = false }

        do {
            let (temporaryURL, response) = try await URLSession.shared.download(from: latestDMGURL)
            guard let http = response as? HTTPURLResponse,
                  (200..<300).contains(http.statusCode)
            else {
                throw BridgeProcessError(message: "GitHub did not return the DMG download.")
            }

            let fileName = latestDMGName.isEmpty ? "VoiceClawCompanion-\(latestReleaseTag.isEmpty ? "latest" : latestReleaseTag).dmg" : latestDMGName
            let downloads = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
                ?? URL(fileURLWithPath: "\(NSHomeDirectory())/Downloads", isDirectory: true)
            let destination = downloads.appendingPathComponent(fileName, isDirectory: false)
            let expectedDigest = Self.normalizedSHA256Digest(latestDMGDigest)

            if let expectedDigest {
                let data = try Data(contentsOf: temporaryURL)
                let actualDigest = Self.sha256Hex(data)
                guard actualDigest == expectedDigest else {
                    throw BridgeProcessError(message: "Downloaded DMG checksum did not match the GitHub release digest.")
                }
                if FileManager.default.fileExists(atPath: destination.path) {
                    try FileManager.default.removeItem(at: destination)
                }
                try data.write(to: destination, options: [.atomic])
                lastLog = "Downloaded \(fileName) to Downloads and verified SHA-256."
            } else {
                if FileManager.default.fileExists(atPath: destination.path) {
                    try FileManager.default.removeItem(at: destination)
                }
                try FileManager.default.moveItem(at: temporaryURL, to: destination)
                lastLog = "Downloaded \(fileName) to Downloads. No release digest was available to verify."
            }

            updateSummary = "Downloaded \(fileName) to Downloads and opened it. Drag VoiceClaw Companion to Applications to update."
            NSWorkspace.shared.open(destination)
        } catch {
            updateSummary = "Could not download the update: \(error.localizedDescription)"
            lastLog = updateSummary
        }
    }

    func checkForUpdates(manual: Bool = true) async {
        guard !isCheckingForUpdates else { return }

        isCheckingForUpdates = true
        lastUpdateCheckDate = Date()
        if manual {
                updateSummary = "Checking GitHub Releases for a notarized VoiceClaw Companion update..."
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
            latestReleaseTag = release.tagName
            latestReleaseURL = release.htmlURL
            let preferredAsset = release.preferredDMGAsset
            latestDMGName = preferredAsset?.name ?? ""
            latestDMGURL = preferredAsset?.browserDownloadURL
            latestDMGDigest = preferredAsset?.digest ?? ""

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
                updateSummary = "Update \(release.tagName) is available. Use Install Update to let Sparkle download and install the signed release. Notarized DMG: \(latestDMGName)."
            } else {
                updateAvailable = false
                updateSummary = "VoiceClaw Companion is up to date at \(currentVersion). Latest DMG: \(latestDMGName). Automatic checks run \(automaticUpdateCheckInterval.label.lowercased()) when enabled."
            }
        } catch {
            updateAvailable = false
            updateSummary = "Could not check GitHub Releases: \(error.localizedDescription)"
        }
    }

    private func configureAutomaticUpdateChecks() {
        automaticUpdateTask?.cancel()
        automaticUpdateTask = nil

        guard automaticUpdateChecksEnabled else { return }

        let intervalNanoseconds = automaticUpdateCheckInterval.nanoseconds
        automaticUpdateTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: intervalNanoseconds)
                guard !Task.isCancelled else { break }
                await self?.checkForUpdates(manual: false)
            }
        }
    }

    private func applySparkleUpdatePreferences() {
        guard !isSyncingSparkleUpdatePreferences else { return }
        sparkleUpdaterController.updater.automaticallyChecksForUpdates = automaticUpdateChecksEnabled
        sparkleUpdaterController.updater.updateCheckInterval = automaticUpdateCheckInterval.seconds
        if sparkleUpdaterController.updater.allowsAutomaticUpdates {
            sparkleUpdaterController.updater.automaticallyDownloadsUpdates = automaticUpdateInstallsEnabled
        }
        syncSparkleUpdatePreferences()
    }

    private func syncSparkleUpdatePreferences() {
        isSyncingSparkleUpdatePreferences = true
        automaticUpdateChecksEnabled = sparkleUpdaterController.updater.automaticallyChecksForUpdates
        automaticUpdateInstallsEnabled = sparkleUpdaterController.updater.automaticallyDownloadsUpdates
        isSyncingSparkleUpdatePreferences = false
    }

    private func configureLaunchAtStartupOnFirstRun() async {
        let defaults = UserDefaults.standard
        let storedPreference = defaults.object(forKey: DefaultsKeys.launchAtStartupEnabled)
        if storedPreference == nil {
            defaults.set(true, forKey: DefaultsKeys.launchAtStartupEnabled)
        }

        refreshLaunchAtStartupStatus()
        if defaults.bool(forKey: DefaultsKeys.launchAtStartupEnabled),
           SMAppService.mainApp.status != .enabled,
           SMAppService.mainApp.status != .requiresApproval {
            await setLaunchAtStartupEnabled(true, userInitiated: false)
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
            lastLog = "Selected unused test port \(response.suggestedPort). Nothing changed on this Mac yet. Click Install and Start to configure the bridge and Tailscale Serve for this port, then pair the phone again."
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
            port = Self.defaultBridgePort
            openClawInstallPath = "\(NSHomeDirectory())/.openclaw"
            openClawAgentName = Self.defaultOpenClawAgentName
            bridgeURL = ""
            tailscaleSummary = "Not checked"
            localBridgeSummary = "Not checked"
            pairingJSON = ""
            pairingPreview = ""
            pairingURL = ""
            if removeTailscaleMapping {
                let networkSummary = resetResponse?.tailscaleReset?.summary ?? "No matching VoiceClaw Tailscale Serve mapping needed removal."
                lastLog = "Reset complete. VoiceClaw removed its LaunchAgent and local bridge config. \(networkSummary) Tailscale itself, OpenClaw, and Node.js were not changed."
            } else {
                lastLog = "Reset complete. VoiceClaw removed its LaunchAgent and local bridge config only. Tailscale, OpenClaw, Node.js, and tailnet settings were not changed."
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

    private var normalizedOpenClawAgentName: String {
        let trimmed = openClawAgentName.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? Self.defaultOpenClawAgentName : trimmed
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
        if let savedAgentName = object["openClawAgentName"] as? String, !savedAgentName.isEmpty {
            openClawAgentName = savedAgentName
        } else if let savedAgentName = object["openClawAgent"] as? String, !savedAgentName.isEmpty {
            openClawAgentName = savedAgentName
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
        updated["OpenClawAgent"] = normalizedOpenClawAgentName
        updated["InstantModel"] = updated["InstantModel"] as? String ?? "gpt-5-chat-latest"
        updated["InstantWebSearch"] = updated["InstantWebSearch"] as? Bool ?? true
        updated["CompanionVersion"] = Self.currentCompanionVersion ?? ""
        updated["CompanionBuild"] = Self.currentCompanionBuild ?? ""
        updated["CompanionReleaseTag"] = Self.currentCompanionReleaseTag
        let trimmedWatchBridgeURL = watchPublicBridgeURL.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmedWatchBridgeURL.isEmpty {
            updated.removeValue(forKey: "WatchPublicBridgeURL")
        } else {
            updated["WatchPublicBridgeURL"] = trimmedWatchBridgeURL
        }

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
        object["openClawAgentName"] = normalizedOpenClawAgentName

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
            companionVoiceSummary = diagnostics.companionVoice?.summary ?? "Companion Realtime Voice dependencies were not reported by this bridge runtime."
            setupAdvice = diagnostics.suggestedAction
            canResetTailscaleMapping = diagnostics.tailscale.canClearSafely ?? false
            await refreshRealtimeRuntimeStatus()

            guard !status.isWorking else { return }
            if diagnostics.local.state == "running", diagnostics.tailscale.state == "voiceclaw_mapping" {
                status = .ready
                suppressTransientSetupWarningUntil = nil
            } else if diagnostics.tailscale.state == "stale_voiceclaw_mapping" || diagnostics.tailscale.state == "occupied_by_other_mapping" || (diagnostics.savedConfigExists && diagnostics.tailscale.state == "not_available") {
                if let suppressUntil = suppressTransientSetupWarningUntil, Date() < suppressUntil {
                    status = .ready
                } else {
                    status = .warning("Companion Needs Attention")
                }
            } else if case .ready = status {
                status = .idle
            } else if case .warning = status {
                status = .idle
            }
        } catch {
            localBridgeSummary = "Diagnostics could not run."
            tailscaleSummary = Self.userFacingSetupError(error)
            realtimeRuntimeSummary = "Realtime runtime status could not be read because bridge diagnostics failed."
            realtimeAuthStatusSummary = "OpenAI auth status could not be read because bridge diagnostics failed."
            companionVoiceSummary = "Companion Realtime Voice dependencies could not be checked because bridge diagnostics failed."
            setupAdvice = "Install Node.js and Tailscale if needed, then click Install and Start."
            canResetTailscaleMapping = false
            if !status.isWorking {
                status = .warning("Diagnostics Need Attention")
            }
        }
    }

    private func refreshRealtimeRuntimeStatus() async {
        guard let portValue = Int(port.trimmingCharacters(in: .whitespacesAndNewlines)),
              let url = URL(string: "http://127.0.0.1:\(portValue)/realtime/status")
        else {
            realtimeRuntimeSummary = "Choose a valid bridge port to read Realtime runtime status."
            realtimeAuthStatusSummary = "Choose a valid bridge port to read OpenAI auth status."
            return
        }

        var request = URLRequest(url: url)
        request.timeoutInterval = 3
        applyBridgeAuthHeaders(to: &request)

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse,
                  (200..<300).contains(http.statusCode),
                  let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
            else {
                realtimeRuntimeSummary = "Realtime runtime endpoint did not return a readable status."
                return
            }

            realtimeRuntimeSummary = Self.realtimeRuntimeSummary(from: object)
            await refreshRealtimeAuthStatus(portValue: portValue)
        } catch {
            realtimeRuntimeSummary = "Realtime runtime is not reachable on the local bridge yet."
            await refreshRealtimeAuthStatus(portValue: portValue)
        }
    }

    private func refreshRealtimeAuthStatus(portValue: Int) async {
        var components = URLComponents(string: "http://127.0.0.1:\(portValue)/realtime/auth/status")
        components?.queryItems = [
            URLQueryItem(name: "probe", value: realtimeAuthMode == .openClawOAuth ? "1" : "0"),
            URLQueryItem(name: "model", value: "gpt-realtime-2"),
            URLQueryItem(name: "voice", value: "marin"),
        ]
        guard let url = components?.url else {
            realtimeAuthStatusSummary = "Choose a valid bridge port to read OpenAI auth status."
            return
        }

        var request = URLRequest(url: url)
        request.timeoutInterval = realtimeAuthMode == .openClawOAuth ? 12 : 3
        applyBridgeAuthHeaders(to: &request)

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse,
                  (200..<300).contains(http.statusCode),
                  let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
            else {
                realtimeAuthStatusSummary = "OpenAI auth endpoint did not return a readable status."
                return
            }

            realtimeAuthStatusSummary = Self.realtimeAuthStatusSummary(from: object)
        } catch {
            realtimeAuthStatusSummary = "OpenAI auth status is not reachable on the local companion bridge yet."
        }
    }

    private func applyBridgeAuthHeaders(to request: inout URLRequest) {
        let configURL = URL(fileURLWithPath: "\(NSHomeDirectory())/.voiceclaw/bridge.json")
        guard let data = try? Data(contentsOf: configURL),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return }

        if let token = object["gatewayToken"] as? String,
           !token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        if let password = object["gatewayPassword"] as? String,
           !password.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            request.setValue(password, forHTTPHeaderField: "X-OpenClaw-Gateway-Password")
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

        throw BridgeProcessError(message: "Node.js is not installed or is not available to apps launched from Finder. Install Node.js, reopen VoiceClaw Companion, then click Install and Start again.")
    }

    private static func userFacingSetupError(_ error: Error) -> String {
        let raw = error.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
        let lower = raw.lowercased()

        if lower.contains("node") && (lower.contains("no such file") || lower.contains("not installed") || lower.contains("not found")) {
            return "Node.js is required to run the local bridge, but VoiceClaw Companion could not find it. Install Node.js, reopen the companion app, then click Install and Start again."
        }

        if lower.contains("tailscale") {
            let detail = raw.isEmpty ? "" : "\n\nTailscale detail: \(raw)"
            return "Tailscale Serve could not be configured. Serve is Tailscale's private HTTPS proxy for exposing this Mac's local VoiceClaw bridge only inside your tailnet.\n\nTry these in order:\n1. Open Tailscale on this Mac and confirm it is signed in.\n2. In the Tailscale admin console, make sure HTTPS certificates are enabled for the tailnet.\n3. Confirm this Mac and the phone are in the same tailnet.\n4. Come back here and click Install and Start again.\n\nVoiceClaw looks for the Tailscale command in the standard macOS install locations and only changes Tailscale Serve when you click Install and Start; Check Again is read-only.\(detail)"
        }

        if lower.contains("openclaw config was not found") || lower.contains("openclaw.json") {
            return "\(raw)\n\nThe install path should be the folder that contains openclaw.json. On this Mac, that is usually ~/.openclaw, not ~/openclaw."
        }

        if lower.contains("launchctl") || lower.contains("bootstrap") || lower.contains("launch agent") {
            return "macOS could not install or start the VoiceClaw LaunchAgent. Make sure this user account can write to ~/Library/LaunchAgents, then try Install and Start again."
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

    private static var currentCompanionBuild: String? {
        Bundle.main.infoDictionary?["CFBundleVersion"] as? String
    }

    private static var currentCompanionReleaseTag: String {
        guard let currentCompanionVersion,
              !currentCompanionVersion.isEmpty
        else { return "" }
        return "v\(currentCompanionVersion)"
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

    private static func launchAtStartupSummary(for status: SMAppService.Status) -> String {
        switch status {
        case .enabled:
            return "VoiceClaw Companion will open automatically when this Mac user logs in."
        case .requiresApproval:
            return "VoiceClaw Companion is registered for login, but macOS needs approval in System Settings > General > Login Items."
        case .notRegistered:
            return "VoiceClaw Companion is not currently set to open at login."
        case .notFound:
            return "macOS could not find this app as a login item. Move VoiceClaw Companion to Applications, reopen it, then enable Launch upon Startup."
        @unknown default:
            return "macOS returned an unknown Launch upon Startup status."
        }
    }

    private static func normalizedSHA256Digest(_ digest: String) -> String? {
        let cleaned = digest.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard cleaned.hasPrefix("sha256:") else { return nil }
        let value = String(cleaned.dropFirst("sha256:".count))
        guard value.count == 64,
              value.allSatisfy({ $0.isHexDigit })
        else { return nil }
        return value
    }

    private static func sha256Hex(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    private static func realtimeRuntimeSummary(from object: [String: Any]) -> String {
        let active = object["active"] as? Bool ?? false
        let pending = integerText(object["realtimePending"]) ?? "0"
        let maxPending = integerText(object["maxRealtimePending"]) ?? "?"
        let sidebandEnabled = object["sidebandEnabled"] as? Bool ?? false
        let sideband = (object["sideband"] as? String)?.capitalized ?? "Unknown"
        let sessionConfig = object["sessionConfig"] as? [String: Any]
        let sidebandDiagnostics = object["sidebandDiagnostics"] as? [String: Any]
        let attempts = integerText(sidebandDiagnostics?["responseCreateAttempts"]) ?? "0"
        let collisions = integerText(sidebandDiagnostics?["responseCreateCollisions"]) ?? "0"
        let activeResponse = sidebandDiagnostics?["activeResponseId"] as? String
        let queuedResponses = integerText(sidebandDiagnostics?["pendingResponseCreates"]) ?? "0"
        let auth = sessionConfig?["authSource"] as? String ?? "not connected"
        let processing = sessionConfig?["processing"] as? [String: Any]
        let runtime = (processing?["runtime"] as? String)?.lowercased() == "hermes" ? "Hermes" : "OpenClaw"

        if sidebandEnabled {
            return "Sideband \(sideband), auth \(auth), \(runtime) active \(active ? "yes" : "no"), queue \(pending)/\(maxPending), replies active \(shortID(activeResponse) ?? "none") with \(queuedResponses) queued, \(attempts) attempts, \(collisions) collisions."
        }

        return "Sideband disabled, auth \(auth), \(runtime) active \(active ? "yes" : "no"), queue \(pending)/\(maxPending), phone fallback handles agent tools."
    }

    private static func realtimeAuthStatusSummary(from object: [String: Any]) -> String {
        let mode = object["mode"] as? String ?? CompanionRealtimeAuthMode.apiKey.rawValue
        let source = object["effectiveSource"] as? String ?? "unknown"
        let fallback = object["fallbackToAPIKey"] as? Bool ?? false
        let apiKeyAvailable = object["apiKeyAvailable"] as? Bool ?? false
        let oauth = object["openClawOAuth"] as? [String: Any]
        let oauthChecked = oauth?["checked"] as? Bool ?? false
        let oauthAvailable = oauth?["available"] as? Bool ?? false
        let probe = oauth?["clientSecretProbe"] as? String
        let oauthError = oauth?["error"] as? String

        if mode != CompanionRealtimeAuthMode.openClawOAuth.rawValue, !oauthChecked {
            return "API-key mode is selected from \(source). OpenAI API key available: \(apiKeyAvailable ? "yes" : "no"). This is the supported GPT-Realtime-2 Live path until OpenAI re-enables Sign-in-with-ChatGPT for GPT-Realtime-2."
        }

        if oauthAvailable {
            if probe == "passed" {
                return "OAuth can mint a GPT-Realtime-2 client secret, but current /realtime/calls signaling is not admitted with OAuth-minted secrets. Use API Key mode for Live sessions. API-key fallback \(fallback ? "on" : "off"); OpenAI API key available: \(apiKeyAvailable ? "yes" : "no")."
            }

            return "Local OpenClaw OAuth profile is available, but GPT-Realtime-2 Live should use API Key mode until OpenAI re-enables subscription sign-in for Realtime signaling. API-key fallback \(fallback ? "on" : "off")."
        }

        if let oauthError, !oauthError.isEmpty {
            return "Local Companion OAuth is not ready: \(oauthError) Use API Key mode for GPT-Realtime-2 Live sessions. API-key fallback \(fallback ? "on" : "off"); OpenAI API key available: \(apiKeyAvailable ? "yes" : "no")."
        }

        return "OAuth (ChatGPT Subscription) has not been checked. Use API Key mode for GPT-Realtime-2 Live sessions until OpenAI re-enables subscription sign-in. API-key fallback \(fallback ? "on" : "off")."
    }

    private static func integerText(_ value: Any?) -> String? {
        if let int = value as? Int { return "\(int)" }
        if let double = value as? Double { return "\(Int(double))" }
        if let string = value as? String, !string.isEmpty { return string }
        return nil
    }

    private static func shortID(_ value: String?) -> String? {
        guard let value,
              !value.isEmpty
        else { return nil }
        return value.count > 12 ? "\(value.prefix(6))...\(value.suffix(4))" : value
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
            "RealtimeAuthFallbackToAPIKey": config["realtimeAuthFallbackToAPIKey"] as? Bool ?? false,
            "WatchPublicBridgeURL": "",
            "CompanionVersion": Self.currentCompanionVersion ?? "",
            "CompanionBuild": Self.currentCompanionBuild ?? "",
            "CompanionReleaseTag": Self.currentCompanionReleaseTag,
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
        let digest: String?

        enum CodingKeys: String, CodingKey {
            case name
            case browserDownloadURL = "browser_download_url"
            case digest
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
    let companionVoice: Component?
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
