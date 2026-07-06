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

enum CompanionPowerhouseMode: String, CaseIterable, Identifiable {
    case light
    case balanced
    case maximum
    case presentation

    var id: String { rawValue }

    var label: String {
        switch self {
        case .light:
            "Light"
        case .balanced:
            "Balanced"
        case .maximum:
            "Maximum"
        case .presentation:
            "Presentation"
        }
    }

    var detail: String {
        switch self {
        case .light:
            "Bridge stays available, but voice workers and models warm only on demand."
        case .balanced:
            "Prepares the primary/default realtime voice stack only when you explicitly start a warm pass."
        case .maximum:
            "Aggressively prepares local STT, local LLM, streaming TTS, route prewarm, and network probes."
        case .presentation:
            "Most aggressive mode. Uses the Mac like a realtime appliance for lowest latency during demos or heavy use."
        }
    }
}

@MainActor
final class BridgeStore: ObservableObject {
    private enum DefaultsKeys {
        static let includeOpenAIAPIKeyInPairing = "voiceclaw.includeOpenAIAPIKeyInPairing"
        static let includeCerebrasAPIKeyInPairing = "voiceclaw.includeCerebrasAPIKeyInPairing"
        static let watchPublicBridgeURL = "voiceclaw.watchPublicBridgeURL"
        static let openClawAgentName = "voiceclaw.openClawAgentName"
        static let realtimeAuthMode = "voiceclaw.realtimeAuthMode"
        static let realtimeAuthFallbackToAPIKey = "voiceclaw.realtimeAuthFallbackToAPIKey"
        static let powerhouseMode = "voiceclaw.powerhouseMode"
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
            Task { await persistBridgeAuthDefaults() }
        }
    }
    @Published var cerebrasAPIKey: String = "" {
        didSet {
            CompanionKeychainStore.save(cerebrasAPIKey, account: "cerebras.apiKey")
            refreshPairingPayloadSecrets()
            Task { await persistBridgeAuthDefaults() }
        }
    }
    @Published var includeOpenAIAPIKeyInPairing: Bool = true {
        didSet {
            UserDefaults.standard.set(includeOpenAIAPIKeyInPairing, forKey: DefaultsKeys.includeOpenAIAPIKeyInPairing)
            refreshPairingPayloadSecrets()
        }
    }
    @Published var includeCerebrasAPIKeyInPairing: Bool = true {
        didSet {
            UserDefaults.standard.set(includeCerebrasAPIKeyInPairing, forKey: DefaultsKeys.includeCerebrasAPIKeyInPairing)
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
    @Published var powerhouseMode: CompanionPowerhouseMode = .light {
        didSet {
            lastAutomaticPowerhousePrewarmDate = nil
            UserDefaults.standard.set(powerhouseMode.rawValue, forKey: DefaultsKeys.powerhouseMode)
            refreshPairingPayloadSecrets()
            Task { await persistBridgeAuthDefaults() }
        }
    }
    @Published var status: BridgeStatus = .idle
    @Published var bridgeURL: String = ""
    @Published var tailscaleSummary: String = "Not checked"
    @Published var localBridgeSummary: String = "Not checked"
    @Published var runtimeIntegritySummary: String = "Runtime identity has not been checked."
    @Published var realtimeRuntimeSummary: String = "Realtime runtime not checked."
    @Published var realtimeAuthStatusSummary: String = "OpenAI auth status not checked."
    @Published var companionVoiceSummary: String = "Companion Realtime Voice dependencies not checked."
    @Published var companionVoiceState: String = "not_checked"
    @Published var companionVoiceWarmSummary: String = "Companion Realtime Voice warm runtime has not been checked."
    @Published var powerhouseState: String = "not_checked"
    @Published var powerhouseSummary: String = "Powerhouse runtime has not been checked."
    @Published var powerhouseHardwareSummary: String = "Mac hardware profile has not been checked."
    @Published var powerhouseResourcePostureSummary: String = "Powerhouse resource posture has not been checked."
    @Published var powerhouseWorkerItems: [PowerhouseWorkerItem] = []
    @Published var powerhouseJobID: String = ""
    @Published var powerhouseJobStartedAt: String = ""
    @Published var powerhouseJobUpdatedAt: String = ""
    @Published var powerhouseCanCancel: Bool = false
    @Published var powerhouseCanRetry: Bool = false
    @Published var powerhouseLastError: String = ""
    @Published var companionVoiceDependencyInstallSummary: String = ""
    @Published var companionVoiceDependencyInstallAvailable: Bool = false
    @Published var companionVoiceDependencyItems: [CompanionVoiceDependencyItem] = []
    @Published var accessSummary: String = "Access and permissions have not been checked."
    @Published var accessItems: [CompanionAccessItem] = []
    @Published var isCheckingBridgeRuntime: Bool = false
    @Published var bridgeRuntimeCheckSummary: String = "Bridge runtime has not been checked yet."
    @Published var isInstallingCompanionVoiceDependencies: Bool = false
    @Published var isPrewarmingCompanionVoiceRuntime: Bool = false
    @Published var isPrewarmingPowerhouseRuntime: Bool = false
    @Published var pairingJSON: String = ""
    @Published var pairingPreview: String = ""
    @Published var pairingURL: String = ""
    @Published var pairingQRCodeValue: String = ""
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
    private var runtimeSelfHealAttempted = false
    private var lastLocalBridgeRestartAttemptDate: Date?
    private var lastAutomaticPowerhousePrewarmDate: Date?
    private var powerhousePollingTask: Task<Void, Never>?

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
        cerebrasAPIKey = CompanionKeychainStore.load(account: "cerebras.apiKey") ?? ""
        if UserDefaults.standard.object(forKey: DefaultsKeys.includeOpenAIAPIKeyInPairing) != nil {
            includeOpenAIAPIKeyInPairing = UserDefaults.standard.bool(forKey: DefaultsKeys.includeOpenAIAPIKeyInPairing)
        }
        if UserDefaults.standard.object(forKey: DefaultsKeys.includeCerebrasAPIKeyInPairing) != nil {
            includeCerebrasAPIKeyInPairing = UserDefaults.standard.bool(forKey: DefaultsKeys.includeCerebrasAPIKeyInPairing)
        }
        watchPublicBridgeURL = UserDefaults.standard.string(forKey: DefaultsKeys.watchPublicBridgeURL) ?? ""
        if let savedMode = UserDefaults.standard.string(forKey: DefaultsKeys.realtimeAuthMode),
           let mode = CompanionRealtimeAuthMode(rawValue: savedMode) {
            realtimeAuthMode = mode
        }
        if UserDefaults.standard.object(forKey: DefaultsKeys.realtimeAuthFallbackToAPIKey) != nil {
            realtimeAuthFallbackToAPIKey = UserDefaults.standard.bool(forKey: DefaultsKeys.realtimeAuthFallbackToAPIKey)
        }
        if let savedPowerhouseMode = UserDefaults.standard.string(forKey: DefaultsKeys.powerhouseMode),
           let mode = CompanionPowerhouseMode(rawValue: savedPowerhouseMode) {
            powerhouseMode = mode
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
            await persistBridgeAuthDefaults()
            await configureLaunchAtStartupOnFirstRun()
            await loadSavedBridgeConfig()
            await refreshStatus()
            await checkForUpdates(manual: false)
            configureAutomaticUpdateChecks()
        }
    }

    func refreshStatus() async {
        refreshLaunchAtStartupStatus()
        refreshPairingPayloadFromBridgeConfig()
        isCheckingBridgeRuntime = true
        bridgeRuntimeCheckSummary = "Checking Bridge Runtime: LaunchAgent identity, local bridge, Tailscale Serve mapping, Realtime endpoints, Companion Realtime Voice dependencies, warm runtime status, and required Mac access."
        defer {
            refreshPairingPayloadFromBridgeConfig()
            isCheckingBridgeRuntime = false
            lastRefreshDate = Date()
        }
        await refreshBridgeDiagnostics()
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
                    "--powerhouse-mode",
                    powerhouseMode.rawValue,
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
        pairingQRCodeValue = ""
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

    func openLoginItemsSettings() {
        openSystemSettings("x-apple.systempreferences:com.apple.LoginItems-Settings.extension")
    }

    func openFullDiskAccessSettings() {
        openSystemSettings("x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")
    }

    func openFilesAndFoldersSettings() {
        openSystemSettings("x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders")
    }

    func openLocalNetworkSettings() {
        openSystemSettings("x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork")
    }

    func openMicrophoneSettings() {
        openSystemSettings("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")
    }

    func chooseOpenClawInstallFolder() {
        let panel = NSOpenPanel()
        panel.title = "Choose OpenClaw Install Folder"
        panel.message = "Choose the folder that contains openclaw.json."
        panel.prompt = "Use This Folder"
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.directoryURL = URL(fileURLWithPath: normalizedOpenClawPath, isDirectory: true)

        guard panel.runModal() == .OK,
              let url = panel.url
        else { return }

        openClawInstallPath = url.path
        bridgeURL = ""
        pairingJSON = ""
        pairingPreview = ""
        pairingURL = ""
        pairingQRCodeValue = ""
        lastLog = "Selected OpenClaw install folder: \(url.path). Click Install and Start to apply it to the bridge."
    }

    func openOpenClawFolder() {
        openOrCreateDirectory(URL(fileURLWithPath: normalizedOpenClawPath, isDirectory: true))
    }

    func openVoiceClawSupportFolder() {
        openOrCreateDirectory(URL(fileURLWithPath: "\(NSHomeDirectory())/.voiceclaw", isDirectory: true))
    }

    func openHuggingFaceCacheFolder() {
        openOrCreateDirectory(URL(fileURLWithPath: "\(NSHomeDirectory())/.cache/huggingface/hub", isDirectory: true))
    }

    func openHermesHomeFolder() {
        let envHome = ProcessInfo.processInfo.environment["HERMES_HOME"]?.trimmingCharacters(in: .whitespacesAndNewlines)
        let path = envHome?.isEmpty == false ? envHome! : "\(NSHomeDirectory())/.hermes"
        openOrCreateDirectory(URL(fileURLWithPath: path, isDirectory: true))
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
        updateSummary = "Opening the signed VoiceClaw Companion updater..."
        lastLog = "Opening Sparkle to download, verify, install, and relaunch VoiceClaw Companion."
        sparkleUpdaterController.checkForUpdates(nil)
    }

    private func openSystemSettings(_ value: String) {
        guard let url = URL(string: value) else { return }
        if !NSWorkspace.shared.open(url),
           let fallback = URL(string: "x-apple.systempreferences:com.apple.preference.security") {
            NSWorkspace.shared.open(fallback)
        }
    }

    private func openOrCreateDirectory(_ url: URL) {
        do {
            try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
            NSWorkspace.shared.open(url)
        } catch {
            lastLog = "Could not open \(url.path): \(error.localizedDescription)"
        }
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
                updateSummary = "Update \(release.tagName) is available. Use Install Update to open the signed updater. If the updater cannot complete, open the GitHub release and install the notarized DMG manually: \(latestDMGName)."
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
            pairingQRCodeValue = ""
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
            pairingQRCodeValue = ""
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

    func installMissingCompanionVoiceDependencies() async {
        guard companionVoiceDependencyInstallAvailable else {
            lastLog = "Companion Realtime Voice does not currently report any automatically installable missing dependencies."
            return
        }
        guard confirmCompanionVoiceDependencyInstall() else {
            lastLog = "Companion Realtime Voice dependency installation was cancelled."
            return
        }

        isInstallingCompanionVoiceDependencies = true
        status = .working("Installing Voice Dependencies")
        defer {
            isInstallingCompanionVoiceDependencies = false
        }

        do {
            let output = try await runSetupScript(
                arguments: [
                    "--install-companion-voice-deps",
                    "--json",
                    "--openclaw-path",
                    normalizedOpenClawPath,
                ]
            )
            let trimmed = output.trimmingCharacters(in: .whitespacesAndNewlines)
            lastLog = trimmed.isEmpty ? "Companion Realtime Voice dependency installation completed." : trimmed
            await refreshStatus()
        } catch {
            lastLog = Self.userFacingSetupError(error)
            status = .failed("Voice Dependency Install Failed")
            await refreshStatus()
        }
    }

    private func prewarmCompanionVoiceRuntimeIfReady(force: Bool = false) async {
        guard !isPrewarmingCompanionVoiceRuntime else { return }
        guard force || companionVoiceState == "ready" else { return }
        guard let portValue = Int(port.trimmingCharacters(in: .whitespacesAndNewlines)),
              let url = URL(string: "http://127.0.0.1:\(portValue)/realtime/hf-prewarm")
        else {
            companionVoiceWarmSummary = "Choose a valid bridge port before warming the Companion Realtime Voice runtime."
            return
        }

        isPrewarmingCompanionVoiceRuntime = true
        companionVoiceWarmSummary = "Starting the Companion Realtime Voice warm runtime..."
        defer { isPrewarmingCompanionVoiceRuntime = false }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 20 * 60
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: [
            "prepareSet": "recommended",
            "brainMode": "qwen3.5-2b",
            "sttProfile": "parakeet-live",
            "localVoice": "kokoro-af-heart",
        ])
        applyBridgeAuthHeaders(to: &request)

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse,
                  (200..<300).contains(http.statusCode),
                  let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
            else {
                companionVoiceWarmSummary = "Companion Realtime Voice warm runtime did not return a readable status."
                return
            }
            if let summary = object["summary"] as? String, !summary.isEmpty {
                companionVoiceWarmSummary = summary
            } else {
                companionVoiceWarmSummary = "Companion Realtime Voice warm runtime is online."
            }
        } catch {
            companionVoiceWarmSummary = "Companion Realtime Voice warm runtime is not online yet: \(Self.userFacingSetupError(error))"
        }
    }

    private var shouldAutomaticallyPrewarmPowerhouse: Bool {
        false
    }

    func prewarmPowerhouseRuntime(install: Bool = true, refreshAfterCompletion: Bool = true) async {
        guard let portValue = Int(port.trimmingCharacters(in: .whitespacesAndNewlines)),
              let url = URL(string: "http://127.0.0.1:\(portValue)/realtime/powerhouse/prewarm")
        else {
            powerhouseSummary = "Choose a valid bridge port before warming Powerhouse mode."
            return
        }

        isPrewarmingPowerhouseRuntime = true
        powerhouseSummary = "Starting \(powerhouseMode.label) Powerhouse warm pass. QR, bridge readiness, and route start remain available."

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 30
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: [
            "mode": powerhouseMode.rawValue,
            "install": install,
            "async": true,
        ])
        applyBridgeAuthHeaders(to: &request)

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse,
                  (200..<300).contains(http.statusCode),
                  let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
            else {
                powerhouseSummary = "Powerhouse warm pass did not return a readable status."
                return
            }

            applyPowerhouseStatusObject(object)
            startPowerhouseStatusPolling(portValue: portValue, refreshAfterCompletion: refreshAfterCompletion)
        } catch {
            powerhouseState = "failed"
            powerhouseSummary = "Powerhouse warm pass failed: \(Self.userFacingSetupError(error))"
            isPrewarmingPowerhouseRuntime = false
            powerhouseCanRetry = true
        }
    }

    func cancelPowerhouseRuntimeWarmPass() async {
        guard let portValue = Int(port.trimmingCharacters(in: .whitespacesAndNewlines)),
              let url = URL(string: "http://127.0.0.1:\(portValue)/realtime/powerhouse/cancel")
        else {
            recoverPowerhouseRuntimeUI()
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 12
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: [
            "jobID": powerhouseJobID,
            "reason": "user_cancelled",
        ])
        applyBridgeAuthHeaders(to: &request)

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse,
                  (200..<300).contains(http.statusCode),
                  let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
            else {
                recoverPowerhouseRuntimeUI()
                return
            }
            applyPowerhouseStatusObject(object)
            startPowerhouseStatusPolling(portValue: portValue, refreshAfterCompletion: false)
        } catch {
            recoverPowerhouseRuntimeUI()
        }
    }

    func retryPowerhouseRuntimeWarmPass() async {
        await prewarmPowerhouseRuntime(install: true)
    }

    func recoverPowerhouseRuntimeUI() {
        powerhousePollingTask?.cancel()
        powerhousePollingTask = nil
        isPrewarmingPowerhouseRuntime = false
        powerhouseCanCancel = false
        powerhouseCanRetry = true
        powerhouseState = powerhouseState == "running" || powerhouseState == "warming" || powerhouseState == "accepted" || powerhouseState == "cancelling"
            ? "not_checked"
            : powerhouseState
        powerhouseSummary = "Powerhouse UI recovered locally. Bridge, QR, and route start are not blocked by Powerhouse. Click Check Again or Retry to refresh the warm-pass status."
    }

    private func startPowerhouseStatusPolling(portValue: Int, refreshAfterCompletion: Bool) {
        powerhousePollingTask?.cancel()
        powerhousePollingTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                guard let self else { return }
                do {
                    guard let status = try await self.fetchPowerhouseStatus(portValue: portValue, force: false) else {
                        continue
                    }
                    self.applyPowerhouseStatusObject(status)
                    if Self.isTerminalPowerhouseState(self.powerhouseState) {
                        if refreshAfterCompletion {
                            await self.refreshStatus()
                        }
                        self.powerhousePollingTask = nil
                        return
                    }
                } catch {
                    self.powerhouseSummary = "Powerhouse status polling paused: \(Self.userFacingSetupError(error)). Bridge, QR, and route start remain available."
                    self.isPrewarmingPowerhouseRuntime = false
                    self.powerhouseCanCancel = false
                    self.powerhouseCanRetry = true
                    self.powerhousePollingTask = nil
                    return
                }
            }
        }
    }

    private func fetchPowerhouseStatus(portValue: Int, force: Bool) async throws -> [String: Any]? {
        var components = URLComponents()
        components.scheme = "http"
        components.host = "127.0.0.1"
        components.port = portValue
        components.path = "/realtime/powerhouse/status"
        components.queryItems = [
            URLQueryItem(name: "mode", value: powerhouseMode.rawValue),
            URLQueryItem(name: "force", value: force ? "1" : "0"),
        ]
        guard let url = components.url else { return nil }
        var request = URLRequest(url: url)
        request.timeoutInterval = 12
        applyBridgeAuthHeaders(to: &request)
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse,
              (200..<300).contains(http.statusCode),
              let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }
        return object
    }

    private func applyPowerhouseStatusObject(_ object: [String: Any]) {
        powerhouseState = object["state"] as? String ?? powerhouseState
        powerhouseSummary = object["summary"] as? String ?? "Powerhouse warm pass completed."
        powerhouseJobID = (object["jobID"] as? String) ?? (object["jobId"] as? String) ?? powerhouseJobID
        powerhouseJobStartedAt = object["startedAt"] as? String ?? powerhouseJobStartedAt
        powerhouseJobUpdatedAt = object["updatedAt"] as? String ?? powerhouseJobUpdatedAt
        powerhouseCanCancel = object["canCancel"] as? Bool ?? Self.isRunningPowerhouseState(powerhouseState)
        powerhouseCanRetry = object["canRetry"] as? Bool ?? Self.isTerminalPowerhouseState(powerhouseState)
        powerhouseLastError = object["error"] as? String ?? ""
        isPrewarmingPowerhouseRuntime = Self.isRunningPowerhouseState(powerhouseState)
        if let posture = object["resourcePosture"] as? [String: Any] {
            powerhouseResourcePostureSummary = Self.powerhousePostureSummary(posture)
        }
        if let hardware = object["hardware"] as? [String: Any],
           let summary = hardware["summary"] as? String {
            powerhouseHardwareSummary = summary
        }
        let workers = object["progress"] as? [[String: Any]]
            ?? (object["workers"] as? [[String: Any]])
            ?? (object["workerPlan"] as? [[String: Any]])
            ?? ((object["lastPrewarm"] as? [String: Any])?["workers"] as? [[String: Any]])
        if let workers {
            powerhouseWorkerItems = workers.map {
                PowerhouseWorkerItem(
                    id: ($0["id"] as? String) ?? UUID().uuidString,
                    label: ($0["label"] as? String) ?? "Worker",
                    state: ($0["state"] as? String) ?? "unknown",
                    resource: ($0["resource"] as? String) ?? "",
                    mode: ($0["mode"] as? String) ?? powerhouseMode.rawValue,
                    summary: ($0["summary"] as? String) ?? "",
                    elapsedMs: $0["elapsedMs"] as? Int
                )
            }
        }
    }

    private static func isRunningPowerhouseState(_ state: String) -> Bool {
        switch state.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "accepted", "running", "warming", "cancelling":
            return true
        default:
            return false
        }
    }

    private static func isTerminalPowerhouseState(_ state: String) -> Bool {
        switch state.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "ready", "degraded", "failed", "error", "cancelled", "idle", "needs_setup", "not_checked":
            return true
        default:
            return false
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
        if let savedPowerhouseMode = object["powerhouseMode"] as? String,
           let mode = CompanionPowerhouseMode(rawValue: savedPowerhouseMode) {
            powerhouseMode = mode
        } else if let savedPowerhouseMode = object["PowerhouseMode"] as? String,
                  let mode = CompanionPowerhouseMode(rawValue: savedPowerhouseMode) {
            powerhouseMode = mode
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
            pairingQRCodeValue = pairingURL
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
        let trimmedCerebrasKey = cerebrasAPIKey.trimmingCharacters(in: .whitespacesAndNewlines)
        if includeCerebrasAPIKeyInPairing, !trimmedCerebrasKey.isEmpty {
            updated["CerebrasAPIKey"] = trimmedCerebrasKey
        } else {
            updated.removeValue(forKey: "CerebrasAPIKey")
        }
        updated["RealtimeAuthMode"] = realtimeAuthMode.rawValue
        updated["RealtimeAuthFallbackToAPIKey"] = realtimeAuthFallbackToAPIKey
        updated["OpenClawAgent"] = normalizedOpenClawAgentName
        updated["PowerhouseMode"] = powerhouseMode.rawValue
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
        pairingQRCodeValue = Self.compactDeepLink(for: updated) ?? pairingURL
    }

    private func refreshPairingPayloadSecrets() {
        guard !pairingJSON.isEmpty else { return }
        updatePairingPayload(from: pairingJSON)
    }

    private func persistBridgeAuthDefaults() async {
        let configURL = URL(fileURLWithPath: "\(NSHomeDirectory())/.voiceclaw/bridge.json")
        let objectFromDisk: [String: Any]
        if let data = try? Data(contentsOf: configURL),
           let decoded = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            objectFromDisk = decoded
        } else {
            objectFromDisk = [
                "port": Int(port.trimmingCharacters(in: .whitespacesAndNewlines)) ?? Self.defaultBridgePort,
                "openClawInstallPath": normalizedOpenClawPath,
                "openClawAgentName": normalizedOpenClawAgentName,
                "realtimeAuthMode": realtimeAuthMode.rawValue,
                "realtimeAuthFallbackToAPIKey": realtimeAuthFallbackToAPIKey,
                "powerhouseMode": powerhouseMode.rawValue,
            ]
        }

        var object = objectFromDisk

        object["realtimeAuthMode"] = realtimeAuthMode.rawValue
        object["realtimeAuthFallbackToAPIKey"] = realtimeAuthFallbackToAPIKey
        object["openClawAgentName"] = normalizedOpenClawAgentName
        object["powerhouseMode"] = powerhouseMode.rawValue
        let trimmedOpenAIKey = openAIAPIKey.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmedOpenAIKey.isEmpty {
            object.removeValue(forKey: "openAIAPIKey")
            object.removeValue(forKey: "OpenAIAPIKey")
        } else {
            object["openAIAPIKey"] = trimmedOpenAIKey
        }
        let trimmedCerebrasKey = cerebrasAPIKey.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmedCerebrasKey.isEmpty {
            object.removeValue(forKey: "cerebrasAPIKey")
        } else {
            object["cerebrasAPIKey"] = trimmedCerebrasKey
        }

        guard let output = try? JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted]) else { return }
        try? FileManager.default.createDirectory(at: configURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? output.write(to: configURL, options: [.atomic])
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: configURL.path)
    }

    private func refreshBridgeDiagnostics() async {
        do {
            let output = try await runSetupScript(arguments: ["--diagnose", "--json", "--port", port])
            let diagnostics = try JSONDecoder().decode(BridgeDiagnostics.self, from: Data(output.utf8))
            localBridgeSummary = diagnostics.local.summary
            tailscaleSummary = diagnostics.tailscale.summary
            runtimeIntegritySummary = diagnostics.runtimeIntegrity?.summary ?? "Runtime identity was not reported by this bridge runtime."
            companionVoiceState = diagnostics.companionVoice?.state ?? "not_reported"
            companionVoiceSummary = diagnostics.companionVoice?.summary ?? "Companion Realtime Voice dependencies were not reported by this bridge runtime."
            let installPlan = diagnostics.companionVoice?.installPlan
            companionVoiceDependencyInstallSummary = installPlan?.summary ?? ""
            companionVoiceDependencyInstallAvailable = (installPlan?.installableCount ?? 0) > 0
            companionVoiceDependencyItems = (installPlan?.items ?? []).map {
                CompanionVoiceDependencyItem(
                    id: $0.id ?? UUID().uuidString,
                    label: ($0.label?.isEmpty == false ? $0.label : $0.id) ?? "Dependency",
                    detail: $0.detail ?? "",
                    installable: $0.installable ?? false,
                    command: $0.command ?? ""
                )
            }
            powerhouseState = diagnostics.powerhouse?.state ?? "not_reported"
            powerhouseSummary = diagnostics.powerhouse?.summary ?? "Powerhouse runtime was not reported by this bridge runtime."
            powerhouseHardwareSummary = diagnostics.powerhouse?.hardware?.summary ?? "Mac hardware profile was not reported by this bridge runtime."
            powerhouseResourcePostureSummary = diagnostics.powerhouse?.resourcePosture?.summary ?? "Powerhouse resource posture was not reported by this bridge runtime."
            powerhouseWorkerItems = (diagnostics.powerhouse?.workerPlan ?? []).map {
                PowerhouseWorkerItem(
                    id: $0.id ?? UUID().uuidString,
                    label: ($0.label?.isEmpty == false ? $0.label : $0.id) ?? "Worker",
                    state: $0.state ?? "unknown",
                    resource: $0.resource ?? "",
                    mode: $0.mode ?? "",
                    summary: "",
                    elapsedMs: nil
                )
            }
            setupAdvice = diagnostics.suggestedAction
            canResetTailscaleMapping = diagnostics.tailscale.canClearSafely ?? false
            accessSummary = diagnostics.access?.summary ?? "Access and permissions were not reported by this bridge runtime."
            accessItems = (diagnostics.access?.items ?? []).map {
                CompanionAccessItem(
                    id: $0.id ?? UUID().uuidString,
                    label: ($0.label?.isEmpty == false ? $0.label : $0.id) ?? "Access Check",
                    state: $0.state ?? "unknown",
                    summary: $0.summary ?? "",
                    detail: $0.detail ?? "",
                    action: $0.action ?? "",
                    path: $0.path ?? "",
                    installable: $0.installable ?? false
                )
            }
            await refreshRealtimeRuntimeStatus()

            if await refreshLaunchAgentIfRuntimeStale(diagnostics) {
                return
            }

            if await restartLaunchAgentIfLocalBridgeDown(diagnostics) {
                return
            }

            guard !status.isWorking else { return }
            applyReadinessStatus(from: diagnostics)
        } catch {
            localBridgeSummary = "Diagnostics could not run."
            tailscaleSummary = Self.userFacingSetupError(error)
            runtimeIntegritySummary = "Runtime identity could not be checked because bridge diagnostics failed."
            realtimeRuntimeSummary = "Realtime runtime status could not be read because bridge diagnostics failed."
            realtimeAuthStatusSummary = "OpenAI auth status could not be read because bridge diagnostics failed."
            companionVoiceSummary = "Companion Realtime Voice dependencies could not be checked because bridge diagnostics failed."
            companionVoiceState = "failed"
            companionVoiceWarmSummary = "Companion Realtime Voice warm runtime could not be checked because bridge diagnostics failed."
            companionVoiceDependencyInstallSummary = ""
            companionVoiceDependencyInstallAvailable = false
            companionVoiceDependencyItems = []
            powerhouseState = "failed"
            powerhouseSummary = "Powerhouse runtime could not be checked because bridge diagnostics failed."
            powerhouseHardwareSummary = "Mac hardware profile could not be checked because bridge diagnostics failed."
            powerhouseWorkerItems = []
            accessSummary = "Access and permissions could not be checked because bridge diagnostics failed."
            accessItems = []
            bridgeRuntimeCheckSummary = "Bridge Runtime check failed: \(Self.userFacingSetupError(error))"
            setupAdvice = "Install Node.js and Tailscale if needed, then click Install and Start."
            canResetTailscaleMapping = false
            if !status.isWorking {
                status = .warning("Diagnostics Need Attention")
            }
        }
    }

    private func applyReadinessStatus(from diagnostics: BridgeDiagnostics) {
        let runtimeState = diagnostics.runtimeIntegrity?.state ?? "not_reported"
        let localReady = diagnostics.local.state == "running"
        let tailscaleReady = diagnostics.tailscale.state == "voiceclaw_mapping"
        let runtimeReady = runtimeState == "ready"
        let companionVoiceReady = companionVoiceState == "ready"
        let accessState = diagnostics.access?.state ?? "not_reported"
        let accessReady = accessState == "ready"

        var missing: [String] = []
        if !runtimeReady {
            missing.append("Bridge runtime identity is \(runtimeState).")
        }
        if !localReady {
            missing.append("Local bridge is \(diagnostics.local.state).")
        }
        if !tailscaleReady {
            missing.append("Tailscale Serve mapping is \(diagnostics.tailscale.state).")
        }
        if !companionVoiceReady {
            missing.append("Companion Realtime Voice dependencies are \(companionVoiceState).")
        }
        if !accessReady {
            missing.append("Access checks are \(accessState).")
        }

        if missing.isEmpty {
            status = .ready
            suppressTransientSetupWarningUntil = nil
            bridgeRuntimeCheckSummary = "Companion Ready means the packaged bridge runtime is current, the local bridge is running, Tailscale Serve is mapped to VoiceClaw, access checks are clear, and Companion Realtime Voice dependencies are installed. Selected-runtime prewarming and Powerhouse warm passes are advisory and never block starting a route."
            return
        }

        let summary = "Companion is not fully ready: \(missing.joined(separator: " ")) \(setupAdvice)"
        bridgeRuntimeCheckSummary = summary
        lastLog = summary

        if runtimeState == "stale" || runtimeState == "needs_restart" {
            status = .warning("Runtime Needs Refresh")
        } else if !runtimeReady {
            status = .warning("Bridge Runtime Needs Attention")
        } else if !localReady || !tailscaleReady {
            if let suppressUntil = suppressTransientSetupWarningUntil,
               Date() < suppressUntil,
               diagnostics.tailscale.state == "stale_voiceclaw_mapping" || diagnostics.tailscale.state == "occupied_by_other_mapping" || (diagnostics.savedConfigExists && diagnostics.tailscale.state == "not_available") {
                status = .ready
            } else {
                status = .warning("Companion Needs Attention")
            }
        } else if !companionVoiceReady {
            status = .warning("Voice Runtime Needs Attention")
        } else if !accessReady {
            status = .warning("Companion Access Needs Attention")
        }
    }

    private func refreshLaunchAgentIfRuntimeStale(_ diagnostics: BridgeDiagnostics) async -> Bool {
        guard diagnostics.savedConfigExists,
              diagnostics.runtimeIntegrity?.selfHealRecommended == true,
              !runtimeSelfHealAttempted,
              !status.isWorking
        else { return false }

        runtimeSelfHealAttempted = true
        status = .working("Refreshing Bridge Runtime")
        runtimeIntegritySummary = "Refreshing the LaunchAgent so the bridge uses this Companion app's packaged runtime."
        bridgeRuntimeCheckSummary = "Checking Bridge Runtime found a stale or mismatched LaunchAgent runtime. VoiceClaw is refreshing the bridge runtime now, then it will run diagnostics again."
        lastLog = runtimeIntegritySummary

        do {
            let output = try await runSetupScript(arguments: ["--refresh-launch-agent", "--json", "--port", port])
            let trimmed = output.trimmingCharacters(in: .whitespacesAndNewlines)
            lastLog = trimmed.isEmpty ? "Refreshed VoiceClaw bridge LaunchAgent from the current app runtime." : trimmed
            status = .idle
            await refreshBridgeDiagnostics()
        } catch {
            runtimeIntegritySummary = Self.userFacingSetupError(error)
            lastLog = runtimeIntegritySummary
            status = .warning("Runtime Refresh Failed")
        }

        return true
    }

    private func restartLaunchAgentIfLocalBridgeDown(_ diagnostics: BridgeDiagnostics) async -> Bool {
        guard diagnostics.savedConfigExists,
              diagnostics.local.state != "running",
              diagnostics.runtimeIntegrity?.state == "needs_restart" || diagnostics.runtimeIntegrity?.selfHealRecommended == true,
              !status.isWorking
        else { return false }

        if let lastLocalBridgeRestartAttemptDate,
           Date().timeIntervalSince(lastLocalBridgeRestartAttemptDate) < 8 {
            return false
        }

        lastLocalBridgeRestartAttemptDate = Date()
        status = .working("Restarting Local Bridge")
        localBridgeSummary = "Local bridge is not answering on this port. VoiceClaw Companion is restarting the current LaunchAgent now."
        bridgeRuntimeCheckSummary = "Checking Bridge Runtime found the local bridge down. VoiceClaw Companion is restarting the bridge runtime, then it will check again."
        lastLog = bridgeRuntimeCheckSummary

        do {
            let output = try await runSetupScript(arguments: ["--refresh-launch-agent", "--json", "--port", port])
            let trimmed = output.trimmingCharacters(in: .whitespacesAndNewlines)
            lastLog = trimmed.isEmpty ? "Restarted VoiceClaw bridge LaunchAgent from the current app runtime." : trimmed
            status = .idle
            try? await Task.sleep(nanoseconds: 700_000_000)
            await refreshBridgeDiagnostics()
        } catch {
            localBridgeSummary = Self.userFacingSetupError(error)
            bridgeRuntimeCheckSummary = "Local bridge restart failed: \(localBridgeSummary)"
            lastLog = bridgeRuntimeCheckSummary
            status = .warning("Local Bridge Restart Failed")
        }

        return true
    }

    private func confirmCompanionVoiceDependencyInstall() -> Bool {
        let alert = NSAlert()
        alert.messageText = "Install missing Companion Realtime Voice dependencies?"
        alert.informativeText = companionVoiceDependencyInstallSummary.isEmpty
            ? "VoiceClaw Companion will install missing local speech dependencies needed for Companion Realtime Voice."
            : companionVoiceDependencyInstallSummary
        alert.alertStyle = .informational
        alert.addButton(withTitle: "Install")
        alert.addButton(withTitle: "Cancel")
        return alert.runModal() == .alertFirstButtonReturn
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
            URLQueryItem(name: "probe", value: "1"),
            URLQueryItem(name: "model", value: "gpt-realtime-2"),
            URLQueryItem(name: "voice", value: "marin"),
        ]
        guard let url = components?.url else {
            realtimeAuthStatusSummary = "Choose a valid bridge port to read OpenAI auth status."
            return
        }

        var request = URLRequest(url: url)
        request.timeoutInterval = 12
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
            refreshPairingPayloadFromBridgeConfig()
        } catch {
            realtimeAuthStatusSummary = "OpenAI auth status is not reachable on the local companion bridge yet."
        }
    }

    @discardableResult
    private func refreshPairingPayloadFromBridgeConfig() -> Bool {
        let configURL = URL(fileURLWithPath: "\(NSHomeDirectory())/.voiceclaw/bridge.json")
        guard let data = try? Data(contentsOf: configURL),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return false }
        updatePairingPayload(Self.pairingPayload(from: object))
        return true
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
            return "Tailscale Serve could not be configured. Serve is Tailscale's private HTTPS proxy for exposing this Mac's local VoiceClaw bridge only inside your tailnet.\n\nTry these in order:\n1. Open Tailscale on this Mac and confirm it is signed in.\n2. In the Tailscale admin console, make sure HTTPS certificates are enabled for the tailnet.\n3. Confirm this Mac and the phone are in the same tailnet.\n4. Come back here and click Install and Start again.\n\nVoiceClaw looks for the Tailscale command in the standard macOS install locations and only changes Tailscale Serve when you click Install and Start. Verify Runtime checks status and can refresh VoiceClaw's own stale LaunchAgent runtime when safe, but it does not reset Tailscale Serve mappings.\(detail)"
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

    private static func powerhousePostureSummary(_ posture: [String: Any]) -> String {
        let priority = (posture["priority"] as? String)?.replacingOccurrences(of: "-", with: " ") ?? "aggressive"
        let workers = posture["parallelWorkers"] as? Int ?? 0
        let physical = posture["physicalCores"] as? Int ?? 0
        let logical = posture["logicalCores"] as? Int ?? 0
        let tts = posture["ttsProbeRepeats"] as? Int ?? 0
        let route = posture["routePrewarmRepeats"] as? Int ?? 0
        let network = posture["networkProbeRepeats"] as? Int ?? 0
        let threads = posture["aggressiveThreads"] as? Int ?? 0
        let pipelines = posture["hfNumPipelines"] as? Int ?? 0
        let activity = (posture["activityAssertion"] as? Bool) == true ? "activity assertion on" : "activity assertion on demand"
        let policy = posture["hfSidecarPolicy"] as? String ?? "Primary/default realtime sidecar is restored after fallback warmups."
        let cores = physical > 0 || logical > 0 ? "\(physical) physical / \(logical) logical cores" : "Mac cores detected"
        let threadText = threads > 0 ? "; \(threads) aggressive runtime threads" : ""
        let pipelineText = pipelines > 0 ? "; \(pipelines) HF pipelines per sidecar" : ""
        let primary = posture["primaryRuntimeProfile"] as? [String: Any]
        let primaryBrain = primary?["brainMode"] as? String ?? ""
        let primarySTT = primary?["sttProfile"] as? String ?? ""
        let primaryDescriptor = [primaryBrain, primarySTT].filter { !$0.isEmpty }.joined(separator: " / ")
        let primaryText = primaryDescriptor.isEmpty ? "" : " Primary profile: \(primaryDescriptor)."
        return "Priority: \(priority). Parallel workers: \(workers). Hardware: \(cores)\(threadText)\(pipelineText); \(activity). Probes: \(tts) TTS, \(route) route, \(network) network.\(primaryText) \(policy)"
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
            "OpenClawGatewayPassword": config["gatewayPassword"] as? String ?? "",
            "RouteMode": "openclaw-bridge",
            "RealtimeModel": "gpt-realtime-2",
            "InstantModel": "gpt-5-chat-latest",
            "InstantWebSearch": true,
            "RealtimeAuthMode": config["realtimeAuthMode"] as? String ?? CompanionRealtimeAuthMode.apiKey.rawValue,
            "RealtimeAuthFallbackToAPIKey": config["realtimeAuthFallbackToAPIKey"] as? Bool ?? false,
            "ChatGPTOAuthAccessToken": config["ChatGPTOAuthAccessToken"] as? String
                ?? config["openAIChatGPTOAuthAccessToken"] as? String
                ?? config["openAIOAuthAccessToken"] as? String
                ?? "",
            "ChatGPTOAuthRefreshToken": config["ChatGPTOAuthRefreshToken"] as? String
                ?? config["openAIChatGPTOAuthRefreshToken"] as? String
                ?? config["openAIOAuthRefreshToken"] as? String
                ?? "",
            "ChatGPTOAuthExpiresAt": config["ChatGPTOAuthExpiresAt"]
                ?? config["openAIChatGPTOAuthExpiresAt"]
                ?? config["openAIOAuthExpiresAt"]
                ?? 0,
            "ChatGPTOAuthAccountID": config["ChatGPTOAuthAccountID"] as? String
                ?? config["openAIChatGPTOAuthAccountID"] as? String
                ?? config["openAIOAuthAccountID"] as? String
                ?? "",
            "CerebrasAPIKey": config["cerebrasAPIKey"] as? String ?? "",
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

    private static func compactDeepLink(for payload: [String: Any]) -> String? {
        let includeOpenAIKey = (payload["OpenAIAPIKey"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
        let includeCerebrasKey = (payload["CerebrasAPIKey"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
        let gatewayToken = (payload["OpenClawGatewayToken"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let gatewayPassword = (payload["OpenClawGatewayPassword"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !gatewayToken.isEmpty || !gatewayPassword.isEmpty else { return nil }

        let baseURLCandidates = [
            payload["TailscaleBaseURL"] as? String,
            payload["WatchPublicBridgeURL"] as? String,
        ]

        guard let setupPayloadURL = baseURLCandidates.lazy
            .compactMap({ $0 })
            .compactMap({ bridgeEndpointURL(baseURLString: $0, path: "/realtime/setup-payload") })
            .first,
              var payloadComponents = URLComponents(url: setupPayloadURL, resolvingAgainstBaseURL: false),
              var components = URLComponents(string: "voiceclaw://setup")
        else { return nil }

        var payloadQueryItems = payloadComponents.queryItems ?? []
        payloadQueryItems.append(URLQueryItem(name: "include_openai_key", value: includeOpenAIKey ? "1" : "0"))
        payloadQueryItems.append(URLQueryItem(name: "include_cerebras_key", value: includeCerebrasKey ? "1" : "0"))
        payloadComponents.queryItems = payloadQueryItems
        guard let payloadURL = payloadComponents.url else { return nil }

        var items = [
            URLQueryItem(name: "v", value: "2"),
            URLQueryItem(name: "payload_url", value: payloadURL.absoluteString),
        ]

        if !gatewayToken.isEmpty {
            items.append(URLQueryItem(name: "gateway_token", value: gatewayToken))
        }

        if !gatewayPassword.isEmpty {
            items.append(URLQueryItem(name: "gateway_password", value: gatewayPassword))
        }

        components.queryItems = items
        return components.url?.absoluteString
    }

    private static func bridgeEndpointURL(baseURLString: String, path: String) -> URL? {
        let trimmed = baseURLString.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        let candidate = trimmed.contains("://") ? trimmed : "https://\(trimmed)"
        guard var components = URLComponents(string: candidate),
              components.host?.isEmpty == false
        else { return nil }

        let basePath = components.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let endpointPath = path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        components.path = "/" + [basePath, endpointPath]
            .filter { !$0.isEmpty }
            .joined(separator: "/")
        components.query = nil
        return components.url
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
        if let token = object["ChatGPTOAuthAccessToken"] as? String, !token.isEmpty {
            object["ChatGPTOAuthAccessToken"] = "••••••••••••\(token.suffix(4))"
        }
        if let token = object["ChatGPTOAuthRefreshToken"] as? String, !token.isEmpty {
            object["ChatGPTOAuthRefreshToken"] = "••••••••••••\(token.suffix(4))"
        }
        if let key = object["CerebrasAPIKey"] as? String, !key.isEmpty {
            object["CerebrasAPIKey"] = "••••••••••••\(key.suffix(4))"
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

struct CompanionVoiceDependencyItem: Identifiable, Equatable {
    let id: String
    let label: String
    let detail: String
    let installable: Bool
    let command: String
}

struct CompanionAccessItem: Identifiable, Equatable {
    let id: String
    let label: String
    let state: String
    let summary: String
    let detail: String
    let action: String
    let path: String
    let installable: Bool
}

struct PowerhouseWorkerItem: Identifiable, Equatable {
    let id: String
    let label: String
    let state: String
    let resource: String
    let mode: String
    let summary: String
    let elapsedMs: Int?
}

private struct BridgeDiagnostics: Decodable {
    let savedConfigExists: Bool
    let local: Component
    let tailscale: Component
    let runtimeIntegrity: Component?
    let companionVoice: Component?
    let powerhouse: PowerhouseDiagnostics?
    let access: AccessDiagnostics?
    let suggestedAction: String

    struct Component: Decodable {
        let state: String
        let summary: String
        let canClearSafely: Bool?
        let selfHealRecommended: Bool?
        let installPlan: InstallPlan?
    }

    struct InstallPlan: Decodable {
        let needed: Bool?
        let brewAvailable: Bool?
        let installableCount: Int?
        let summary: String?
        let items: [InstallItem]?
    }

    struct InstallItem: Decodable {
        let id: String?
        let label: String?
        let detail: String?
        let installable: Bool?
        let command: String?
    }

    struct AccessDiagnostics: Decodable {
        let state: String?
        let summary: String?
        let items: [AccessItem]?
    }

    struct PowerhouseDiagnostics: Decodable {
        let state: String?
        let mode: String?
        let label: String?
        let summary: String?
        let hardware: Hardware?
        let resourcePosture: ResourcePosture?
        let workerPlan: [Worker]?
    }

    struct Hardware: Decodable {
        let summary: String?
        let memoryPressure: String?
    }

    struct Worker: Decodable {
        let id: String?
        let label: String?
        let state: String?
        let resource: String?
        let mode: String?
    }

    struct ResourcePosture: Decodable {
        let priority: String?
        let parallelWorkers: Int?
        let physicalCores: Int?
        let logicalCores: Int?
        let strategy: String?
        let hfSidecarPolicy: String?
        let activityAssertion: Bool?
        let aggressiveThreads: Int?
        let hfNumPipelines: Int?
        let ttsProbeRepeats: Int?
        let routePrewarmRepeats: Int?
        let networkProbeRepeats: Int?
        let primaryRuntimeProfile: PrimaryRuntimeProfile?

        var summary: String {
            let priorityText = (priority ?? "aggressive").replacingOccurrences(of: "-", with: " ")
            let workerText = parallelWorkers.map(String.init) ?? "auto"
            let coreText: String
            if let physicalCores, let logicalCores {
                coreText = "\(physicalCores) physical / \(logicalCores) logical cores"
            } else {
                coreText = "Mac cores detected"
            }
            let tts = ttsProbeRepeats ?? 0
            let route = routePrewarmRepeats ?? 0
            let network = networkProbeRepeats ?? 0
            let threadText = aggressiveThreads.map { "; \($0) aggressive runtime threads" } ?? ""
            let pipelineText = hfNumPipelines.map { "; \($0) HF pipelines per sidecar" } ?? ""
            let activity = activityAssertion == true ? "activity assertion on" : "activity assertion on demand"
            let policy = hfSidecarPolicy ?? "Primary/default realtime sidecar is restored after fallback warmups."
            let primaryText = primaryRuntimeProfile?.summary.map { " Primary profile: \($0)." } ?? ""
            return "Priority: \(priorityText). Parallel workers: \(workerText). Hardware: \(coreText)\(threadText)\(pipelineText); \(activity). Probes: \(tts) TTS, \(route) route, \(network) network.\(primaryText) \(policy)"
        }
    }

    struct PrimaryRuntimeProfile: Decodable {
        let brainMode: String?
        let sttProfile: String?
        let localVoice: String?

        var summary: String? {
            let brain = brainMode?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let stt = sttProfile?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let voice = localVoice?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let joined = [brain, stt, voice].filter { !$0.isEmpty }.joined(separator: " / ")
            return joined.isEmpty ? nil : joined
        }
    }

    struct AccessItem: Decodable {
        let id: String?
        let label: String?
        let state: String?
        let summary: String?
        let detail: String?
        let action: String?
        let path: String?
        let installable: Bool?
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
