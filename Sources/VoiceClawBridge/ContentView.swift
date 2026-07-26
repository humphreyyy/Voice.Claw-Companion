import CoreImage.CIFilterBuiltins
import SwiftUI

struct ContentView: View {
    @ObservedObject var store: BridgeStore
    @State private var selection: CompanionSection = .setup

    var body: some View {
        NavigationSplitView {
            SidebarView(selection: $selection, status: store.status)
        } detail: {
            DetailPane(selection: selection, store: store)
            .toolbar {
                ToolbarItemGroup {
                    Button {
                        Task { await store.refreshStatus() }
                    } label: {
                        Label(store.isCheckingBridgeRuntime ? "Checking Runtime" : "Verify Runtime", systemImage: "arrow.clockwise")
                    }
                    .disabled(store.isCheckingBridgeRuntime)
                    .help("Run the full Companion readiness check: bridge runtime identity, local bridge, Tailscale Serve, Realtime endpoints, and required Mac access.")

                }
            }
        }
        .onChange(of: selection) { newSelection in
            guard newSelection == .pair else { return }
            store.refreshPairingPayloadForDisplay()
        }
        .onReceive(NotificationCenter.default.publisher(for: .voiceClawCompanionMainWindowActivated)) { _ in
            guard store.automaticUpdateChecksEnabled else { return }
            Task { await store.checkForUpdates(manual: false) }
        }
        .task(id: selection) {
            guard selection == .work else { return }
            await store.refreshWorkCenter()
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 3_000_000_000)
                guard !Task.isCancelled else { return }
                await store.refreshWorkCenter(silent: true)
            }
        }
    }
}

private enum CompanionSection: String, CaseIterable, Identifiable {
    case setup
    case access
    case work
    case companionVoice
    case pair
    case tailscale
    case diagnostics

    var id: String { rawValue }

    static var visibleCases: [CompanionSection] {
        allCases.filter { section in
            section != .companionVoice || VoiceClawProductSurfacePolicy.companionRealtimeVoiceVisible
        }
    }

    var title: String {
        switch self {
        case .setup:
            "Set Up"
        case .access:
            "Access"
        case .work:
            "Tasks & Files"
        case .companionVoice:
            "Companion Voice"
        case .pair:
            "Pair Phone"
        case .tailscale:
            "Tailscale"
        case .diagnostics:
            "Diagnostics"
        }
    }

    var detail: String {
        switch self {
        case .setup:
            "Install bridge"
        case .access:
            "Permissions"
        case .work:
            "Runs and inbox"
        case .companionVoice:
            "Voice runtime"
        case .pair:
            "QR and JSON"
        case .tailscale:
            "Private URL"
        case .diagnostics:
            "Status checks"
        }
    }

    var symbol: String {
        switch self {
        case .setup:
            "wand.and.stars"
        case .access:
            "checkmark.shield"
        case .work:
            "tray.full"
        case .companionVoice:
            "brain.head.profile"
        case .pair:
            "qrcode.viewfinder"
        case .tailscale:
            "network"
        case .diagnostics:
            "checklist"
        }
    }
}

private struct SidebarView: View {
    @Binding var selection: CompanionSection
    let status: BridgeStore.BridgeStatus

    var body: some View {
        List(selection: $selection) {
            ForEach(CompanionSection.visibleCases) { section in
                HStack(spacing: 10) {
                    Image(systemName: section.symbol)
                        .foregroundStyle(.secondary)
                        .frame(width: 16)

                    VStack(alignment: .leading, spacing: 2) {
                        Text(section.title)
                            .lineLimit(1)
                        Text(section.detail)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                .tag(section)
            }
        }
        .listStyle(.sidebar)
        .safeAreaInset(edge: .bottom) {
            HStack(spacing: 10) {
                Circle()
                    .fill(statusColor)
                    .frame(width: 9, height: 9)
                Text(status.title)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                Spacer(minLength: 0)
            }
            .padding(12)
        }
        .navigationTitle(VoiceClawBranding.companionDisplayName)
    }

    private var statusColor: Color {
        switch status {
        case .ready:
            .green
        case .working:
            .yellow
        case .failed:
            .red
        case .warning:
            .orange
        case .idle:
            .secondary
        }
    }
}

private struct DetailPane: View {
    let selection: CompanionSection
    @ObservedObject var store: BridgeStore

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    HeroPanel(store: store)
                    LaunchAtStartupPanel(store: store)
                    UpdateAvailableBanner(store: store)
                    RuntimeCheckingBanner(store: store)
                    StatusBanner(store: store)

                    switch selection {
                    case .setup:
                        SetupPanel(store: store)
                    case .access:
                        AccessPanel(store: store)
                    case .work:
                        WorkCenterPanel(store: store)
                    case .companionVoice:
                        CompanionVoicePanel(store: store)
                    case .pair:
                        PairingPanel(store: store)
                    case .tailscale:
                        TailscalePanel(store: store)
                    case .diagnostics:
                        StatusPanel(store: store)
                    }
                }
                .id(selection)
                .padding(24)
                .frame(maxWidth: 920, alignment: .leading)
            }
            .background(.linearGradient(
                colors: [
                    Color(nsColor: .windowBackgroundColor),
                    Color.cyan.opacity(0.10),
                    Color.indigo.opacity(0.10),
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            ))
            .onChange(of: selection) { newValue in
                withAnimation(.easeInOut(duration: 0.18)) {
                    proxy.scrollTo(newValue, anchor: .top)
                }
            }
        }
    }
}

private struct HeroPanel: View {
    @ObservedObject var store: BridgeStore

    var body: some View {
        HStack(spacing: 18) {
            BridgeLogo()
                .frame(width: 86, height: 86)

            VStack(alignment: .leading, spacing: 8) {
                Text(VoiceClawBranding.companionDisplayName)
                    .font(.system(size: 34, weight: .semibold, design: .rounded))
                Text("Install and manage the private Mac companion that lets VoiceClaw Realtime on your phone or watch reach OpenClaw, Hermes Agent, or Codex on this Mac through Tailscale or an HTTPS tunnel.")
                    .font(.title3)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Spacer(minLength: 24)

            StatusPill(status: store.status)
        }
        .panelStyle()
    }
}

private struct StatusPill: View {
    let status: BridgeStore.BridgeStatus

    var body: some View {
        Label(status.title, systemImage: symbol)
            .font(.headline)
            .foregroundStyle(color)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(color.opacity(0.14), in: Capsule())
            .overlay(Capsule().stroke(color.opacity(0.30)))
    }

    private var symbol: String {
        switch status {
        case .idle:
            "circle"
        case .working:
            "hourglass"
        case .ready:
            "checkmark.circle.fill"
        case .warning:
            "exclamationmark.triangle.fill"
        case .failed:
            "xmark.octagon.fill"
        }
    }

    private var color: Color {
        switch status {
        case .idle:
            .secondary
        case .working:
            .yellow
        case .ready:
            .green
        case .warning:
            .orange
        case .failed:
            .red
        }
    }
}

private struct StatusBanner: View {
    @ObservedObject var store: BridgeStore

    var body: some View {
        switch store.status {
        case .idle:
            EmptyView()
        case let .working(message):
            BannerContent(symbol: "hourglass", title: message, bodyText: "Installing the LaunchAgent and checking Tailscale Serve.", color: .yellow)
        case .ready:
            EmptyView()
        case let .warning(message):
            BannerContent(symbol: "exclamationmark.triangle.fill", title: message, bodyText: store.lastLog, color: .orange)
        case let .failed(message):
            BannerContent(symbol: "xmark.octagon.fill", title: message, bodyText: store.lastLog.isEmpty ? "The bridge could not be installed or started. Check Diagnostics for details." : store.lastLog, color: .red)
        }
    }
}

private struct RuntimeCheckingBanner: View {
    @ObservedObject var store: BridgeStore

    var body: some View {
        if store.isCheckingBridgeRuntime {
            BannerContent(
                symbol: "bolt.horizontal.circle.fill",
                title: "Checking Bridge Runtime",
                bodyText: store.bridgeRuntimeCheckSummary,
                color: .orange)
        }
    }
}

private struct UpdateAvailableBanner: View {
    @ObservedObject var store: BridgeStore

    var body: some View {
        if store.updateAvailable {
            HStack(alignment: .center, spacing: 14) {
                Image(systemName: "arrow.down.circle.fill")
                    .font(.system(size: 32, weight: .semibold))
                    .foregroundStyle(.cyan)
                    .frame(width: 40)

                VStack(alignment: .leading, spacing: 4) {
                    Text(updateTitle)
                        .font(.title3.weight(.semibold))
                    Text(store.updateSummary)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Spacer(minLength: 16)

                Button {
                    store.installLatestUpdate()
                } label: {
                    Label("Install Update", systemImage: "arrow.down.circle.fill")
                }
                .buttonStyle(.borderedProminent)

                Button {
                    Task { await store.checkForUpdates() }
                } label: {
                    Label("Check Again", systemImage: "arrow.clockwise")
                }
                .buttonStyle(.bordered)
                .disabled(store.isCheckingForUpdates)
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.cyan.opacity(0.14), in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(.cyan.opacity(0.45), lineWidth: 1))
            .shadow(color: .cyan.opacity(0.12), radius: 12, y: 4)
            .accessibilityElement(children: .combine)
        }
    }

    private var updateTitle: String {
        if store.latestReleaseTag.isEmpty {
            return "VoiceClaw Realtime Companion Update Available"
        }
        return "VoiceClaw Realtime Companion \(store.latestReleaseTag) Is Available"
    }
}

private struct LaunchAtStartupPanel: View {
    @ObservedObject var store: BridgeStore

    var body: some View {
        HStack(alignment: .center, spacing: 14) {
            Image(systemName: store.launchAtStartupEnabled ? "power.circle.fill" : "power.circle")
                .font(.system(size: 30, weight: .semibold))
                .foregroundStyle(store.launchAtStartupEnabled ? .green : .orange)
                .frame(width: 40)

            VStack(alignment: .leading, spacing: 4) {
                Text("Launch upon Startup")
                    .font(.title3.weight(.semibold))
                Text(store.launchAtStartupSummary)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }

            Spacer(minLength: 16)

            Toggle("Launch upon Startup", isOn: Binding(
                get: { store.launchAtStartupEnabled },
                set: { enabled in
                    Task { await store.setLaunchAtStartupEnabled(enabled) }
                }
            ))
            .toggleStyle(.switch)
            .disabled(store.isUpdatingLaunchAtStartup)
            .help("Open VoiceClaw Realtime Companion automatically when this Mac user logs in.")
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke((store.launchAtStartupEnabled ? Color.green : Color.orange).opacity(0.30)))
        .accessibilityElement(children: .combine)
    }
}

private struct BannerContent: View {
    let symbol: String
    let title: String
    let bodyText: String
    let color: Color

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: symbol)
                .font(.title2)
                .foregroundStyle(color)
                .frame(width: 28)

            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.headline)
                if !bodyText.isEmpty {
                    Text(bodyText)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }
            }

            Spacer(minLength: 0)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(color.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(color.opacity(0.30)))
    }
}

private struct SetupPanel: View {
    @ObservedObject var store: BridgeStore
    @State private var showingNetworkResetConfirmation = false

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            PanelHeader(title: "Mac Setup", subtitle: "Install the local bridge, start it at login, and publish it privately through Tailscale Serve.", symbol: "desktopcomputer")

            Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 12) {
                GridRow {
                    FieldLabel("Bridge Port")
                    VStack(alignment: .leading, spacing: 6) {
                        HStack(spacing: 8) {
                            TextField("12321", text: $store.port)
                                .textFieldStyle(.roundedBorder)
                                .frame(maxWidth: 120)

                            Button("Use Default") {
                                store.useDefaultPort()
                            }
                            .buttonStyle(.bordered)

                            Button {
                                Task { await store.chooseFreshTestPort() }
                            } label: {
                                Label("Fresh Test Port", systemImage: "shuffle")
                            }
                            .buttonStyle(.bordered)
                            .disabled(store.status.isWorking)
                        }

                        Text("Default is 12321. Fresh Test Port chooses an unused high port without changing your Mac, which is useful when you want to test onboarding without reusing an old Tailscale Serve mapping. The phone URL will include this port, and changing it means pairing the phone again.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }

                GridRow {
                    FieldLabel("OpenClaw Install Path")
                    VStack(alignment: .leading, spacing: 6) {
                        TextField("\(NSHomeDirectory())/.openclaw", text: $store.openClawInstallPath)
                            .textFieldStyle(.roundedBorder)
                        Text("Choose the folder that contains openclaw.json. This is only for OpenClaw routes; Hermes Agent routes use the installed hermes command and HERMES_HOME, so no Hermes install path is needed here. On most Macs the OpenClaw path is ~/.openclaw.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                GridRow {
                    FieldLabel("OpenClaw Agent")
                    VStack(alignment: .leading, spacing: 6) {
                        TextField("main", text: $store.openClawAgentName)
                            .textFieldStyle(.roundedBorder)
                            .frame(maxWidth: 260)
                        Text("Leave this as main unless setup fails and you want to try another OpenClaw agent. Hermes routes do not use this field; the Companion resumes Hermes CLI sessions by VoiceClaw Realtime session token.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }

            InfoCallout(symbol: "checkmark.shield", title: "What Install and Start Changes", bodyText: "This button creates VoiceClaw Realtime's local config, installs a LaunchAgent for this user, starts the bridge, and configures Tailscale Serve for the selected port. The same bridge serves OpenClaw routes, Hermes Agent routes, Codex routes, GPT Realtime signaling, and Apple Watch relay. Verify Runtime runs the full readiness check and can refresh VoiceClaw Realtime's own stale LaunchAgent runtime when the installed app safely owns it.")
            InfoCallout(symbol: "sparkles", title: "Hermes Agent Routes", bodyText: "Hermes via Tailscale and Hermes HTTPS Tunnel do not need a Hermes path in this app. The bridge starts normally, then calls the hermes CLI from the user's PATH (or HERMES_BIN) with HERMES_HOME. Use Hermes routes in the phone or watch app after installing Hermes Agent and confirming it works in Terminal.")
            InfoCallout(symbol: "arrow.counterclockwise", title: "Testing First-Run Setup", bodyText: "Reset First-Run State removes only VoiceClaw Realtime's LaunchAgent and local bridge config. Use Reset App + Tailscale Mapping only when Diagnostics says the selected port is a VoiceClaw Realtime mapping; it will refuse to touch other Serve mappings.")
            InfoCallout(symbol: "lightbulb", title: "Recommended Next Step", bodyText: store.setupAdvice)

            HStack(spacing: 10) {
                Button {
                    Task { await store.setupBridge() }
                } label: {
                    Label("Install and Start", systemImage: "play.circle.fill")
                }
                .buttonStyle(.borderedProminent)
                .disabled(store.status.isWorking)

                Button {
                    Task { await store.refreshStatus() }
                } label: {
                    Label(store.isCheckingBridgeRuntime ? "Checking Runtime" : "Verify Runtime", systemImage: "arrow.clockwise")
                }
                .buttonStyle(.bordered)
                .disabled(store.isCheckingBridgeRuntime)
                .help("Re-check status after changing Tailscale, Node.js, OpenClaw, or the port outside this app.")

                Button(role: .destructive) {
                    Task { await store.resetForFirstRun() }
                } label: {
                    Label("Reset First-Run State", systemImage: "arrow.counterclockwise")
                }
                .buttonStyle(.bordered)
                .disabled(store.status.isWorking)

                Button(role: .destructive) {
                    showingNetworkResetConfirmation = true
                } label: {
                    Label("Reset App + Tailscale Mapping", systemImage: "network.slash")
                }
                .buttonStyle(.bordered)
                .disabled(store.status.isWorking || !store.canResetTailscaleMapping)
                .help(store.canResetTailscaleMapping ? "Remove VoiceClaw Realtime's local state and the selected Tailscale Serve mapping." : "Available only when Diagnostics identifies the selected port as a VoiceClaw Realtime Tailscale Serve mapping.")
            }
        }
        .panelStyle()
        .confirmationDialog(
            "Remove the selected VoiceClaw Realtime Tailscale Serve mapping?",
            isPresented: $showingNetworkResetConfirmation,
            titleVisibility: .visible
        ) {
            Button("Reset App + Mapping", role: .destructive) {
                Task { await store.resetForFirstRun(removeTailscaleMapping: true) }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This removes VoiceClaw Realtime's LaunchAgent and local bridge config, then removes only the selected Tailscale Serve port if it maps exactly to the VoiceClaw Realtime bridge. Tailscale, OpenClaw, and Node.js remain installed.")
        }
    }
}

private struct AccessPanel: View {
    @ObservedObject var store: BridgeStore

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            PanelHeader(
                title: "Access and Permissions",
                subtitle: "Prepare this Mac up front so phone and watch sessions do not pause later for missing runtime access, missing folders, or macOS approval.",
                symbol: "checkmark.shield"
            )

            InfoCallout(
                symbol: "hand.raised.fill",
                title: "What macOS requires",
                bodyText: "VoiceClaw Realtime can install local runtimes and open the right settings panes, but macOS still requires the user to approve protected permissions such as Login Items, Microphone, Full Disk Access, Files and Folders, and Local Network when those prompts appear."
            )
            InfoCallout(
                symbol: "externaldrive.connected.to.line.below",
                title: "What VoiceClaw Realtime uses",
                bodyText: "The Companion writes local config under ~/.voiceclaw, starts a per-user LaunchAgent, serves a local bridge on the selected port, and can run OpenClaw, Hermes Agent, or Codex work from this Mac when those routes are selected."
            )

            VStack(alignment: .leading, spacing: 10) {
                Text("Current Readiness")
                    .font(.headline)

                if store.accessItems.isEmpty {
                    StatusRow(title: "Access Summary", value: store.accessSummary, symbol: "checkmark.shield")
                    StatusRow(title: "Launch upon Startup", value: store.launchAtStartupSummary, symbol: store.launchAtStartupEnabled ? "power.circle.fill" : "power.circle")
                    StatusRow(title: "Local Bridge", value: store.localBridgeSummary, symbol: "server.rack")
                    StatusRow(title: "Bridge Runtime", value: store.runtimeIntegritySummary, symbol: "checkmark.seal")
                    StatusRow(title: "Tailscale Serve", value: store.tailscaleSummary, symbol: "network")
                    if VoiceClawProductSurfacePolicy.companionRealtimeVoiceVisible {
                        StatusRow(title: "Companion Realtime Voice", value: store.companionVoiceSummary, symbol: "brain.head.profile")
                    }
                    StatusRow(title: "OpenClaw Folder", value: store.openClawInstallPath, symbol: "folder")
                } else {
                    Text(store.accessSummary)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)

                    ForEach(store.accessItems) { item in
                        AccessItemRow(item: item)
                    }
                }
            }
            .padding(14)
            .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 8))

            VStack(alignment: .leading, spacing: 10) {
                Text("Prepare This Mac")
                    .font(.headline)

                LazyVGrid(columns: [GridItem(.adaptive(minimum: 210), spacing: 10)], alignment: .leading, spacing: 10) {
                    Button {
                        Task { await store.setLaunchAtStartupEnabled(true) }
                    } label: {
                        Label("Enable Login Item", systemImage: "power.circle.fill")
                    }
                    .disabled(store.isUpdatingLaunchAtStartup)

                    Button {
                        store.openLoginItemsSettings()
                    } label: {
                        Label("Open Login Items", systemImage: "gearshape")
                    }

                    Button {
                        store.openFullDiskAccessSettings()
                    } label: {
                        Label("Full Disk Access", systemImage: "lock.shield")
                    }

                    Button {
                        store.openFilesAndFoldersSettings()
                    } label: {
                        Label("Files and Folders", systemImage: "folder.badge.gearshape")
                    }

                    Button {
                        store.openLocalNetworkSettings()
                    } label: {
                        Label("Local Network", systemImage: "network")
                    }

                    Button {
                        store.openMicrophoneSettings()
                    } label: {
                        Label("Microphone", systemImage: "mic.circle")
                    }

                    Button {
                        store.chooseOpenClawInstallFolder()
                    } label: {
                        Label("Choose OpenClaw Folder", systemImage: "folder.badge.plus")
                    }

                    Button {
                        store.openOpenClawFolder()
                    } label: {
                        Label("Open OpenClaw Folder", systemImage: "folder")
                    }

                    Button {
                        store.openVoiceClawSupportFolder()
                    } label: {
                        Label("Open VoiceClaw Realtime Data", systemImage: "externaldrive")
                    }

                    if VoiceClawProductSurfacePolicy.companionRealtimeVoiceVisible {
                        Button {
                            store.openHuggingFaceCacheFolder()
                        } label: {
                            Label("Open HF Model Cache", systemImage: "shippingbox")
                        }
                    }

                    Button {
                        store.openHermesHomeFolder()
                    } label: {
                        Label("Open Hermes Home", systemImage: "terminal")
                    }

                    Button {
                        store.openNodeInstallPage()
                    } label: {
                        Label("Get Node.js", systemImage: "terminal")
                    }

                    Button {
                        store.openTailscaleInstallPage()
                    } label: {
                        Label("Get Tailscale", systemImage: "network")
                    }
                }
                .buttonStyle(.bordered)
            }
            .padding(14)
            .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 8))

            HStack(spacing: 10) {
                Button {
                    Task { await store.refreshStatus() }
                } label: {
                    Label("Verify Everything", systemImage: "arrow.clockwise")
                }
                .buttonStyle(.bordered)

                if VoiceClawProductSurfacePolicy.companionRealtimeVoiceVisible,
                   store.companionVoiceDependencyInstallAvailable {
                    Button {
                        Task { await store.installMissingCompanionVoiceDependencies() }
                    } label: {
                        Label(store.isInstallingCompanionVoiceDependencies ? "Installing Voice Dependencies" : "Install Voice Dependencies", systemImage: "square.and.arrow.down")
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(store.isInstallingCompanionVoiceDependencies || store.status.isWorking)
                }

                Button {
                    Task { await store.setupBridge() }
                } label: {
                    Label("Install and Start Bridge", systemImage: "play.circle.fill")
                }
                .buttonStyle(.borderedProminent)
                .disabled(store.status.isWorking)
            }

            Text("VoiceClaw Realtime does not use or contact unrelated local services outside its own bridge/runtime paths. Personal development services on other ports should remain isolated from Companion setup.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .panelStyle()
    }
}

private struct CompanionVoicePanel: View {
    @ObservedObject var store: BridgeStore

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            PanelHeader(
                title: "Companion Realtime Voice",
                subtitle: "Prepare this Mac to run VoiceClaw Realtime's local speech-to-text, Companion Realtime Voice LLM, and text-to-speech pipeline for the Companion Realtime Voice engine.",
                symbol: "brain.head.profile"
            )

            HStack(alignment: .top, spacing: 14) {
                Image(systemName: statusSymbol)
                    .font(.system(size: 28, weight: .semibold))
                    .foregroundStyle(statusColor)
                    .frame(width: 36)

                VStack(alignment: .leading, spacing: 6) {
                    Text(statusTitle)
                        .font(.title3.weight(.semibold))
                    Text(store.companionVoiceSummary)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                }

                Spacer(minLength: 16)
            }
            .padding(14)
            .background(statusColor.opacity(0.10), in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(statusColor.opacity(0.28)))

            InfoCallout(
                symbol: "point.3.connected.trianglepath.dotted",
                title: "What this powers",
                bodyText: "Companion Realtime Voice keeps the iPhone live voice loop on this Mac: VAD and endpointing, Faster Whisper speech-to-text, the selected Companion Realtime Voice LLM, and local streaming text-to-speech. OpenClaw and Hermes routes still run as the bottom layer when selected on iPhone; watchOS currently uses its GPT-Realtime-2 voice layer for the same route choices."
            )
            InfoCallout(
                symbol: "arrow.triangle.2.circlepath",
                title: "Voice sessions and agent sessions are separate",
                bodyText: "Restarting the VoiceClaw Realtime voice session should restart audio and realtime transport only. It should not reset an OpenClaw or Hermes conversation unless the user explicitly asks to start a new agent session."
            )

            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Powerhouse Mode")
                            .font(.headline)
                        Text("Choose how aggressively this Mac should use CPU, GPU, memory, models, and network readiness for VoiceClaw Realtime.")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    Spacer(minLength: 16)

                    Picker("Powerhouse Mode", selection: $store.powerhouseMode) {
                        ForEach(CompanionPowerhouseMode.allCases) { mode in
                            Text(mode.label).tag(mode)
                        }
                    }
                    .pickerStyle(.segmented)
                    .frame(maxWidth: 520)
                }

                Text(store.powerhouseMode.detail)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)

                StatusRow(
                    title: "\(store.powerhouseMode.label) Runtime",
                    value: store.powerhouseSummary,
                    symbol: "bolt.horizontal.circle"
                )

                if !store.powerhouseJobID.isEmpty {
                    StatusRow(
                        title: "Powerhouse Job",
                        value: "\(store.powerhouseState) • \(store.powerhouseJobID)",
                        symbol: "list.bullet.clipboard"
                    )
                }

                if !store.powerhouseLastError.isEmpty {
                    StatusRow(
                        title: "Last Powerhouse Error",
                        value: store.powerhouseLastError,
                        symbol: "exclamationmark.triangle"
                    )
                }

                StatusRow(
                    title: "Mac Hardware",
                    value: store.powerhouseHardwareSummary,
                    symbol: "cpu"
                )

                StatusRow(
                    title: "Resource Posture",
                    value: store.powerhouseResourcePostureSummary,
                    symbol: "gauge.with.dots.needle.67percent"
                )

                if !store.powerhouseWorkerItems.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(store.isPrewarmingPowerhouseRuntime ? "Powerhouse Progress" : "Worker Plan")
                            .font(.subheadline.weight(.semibold))
                        ForEach(store.powerhouseWorkerItems) { item in
                            PowerhouseWorkerRow(item: item)
                        }
                    }
                }

                HStack(spacing: 10) {
                    Button {
                        Task { await store.prewarmPowerhouseRuntime(install: true) }
                    } label: {
                        Label(store.isPrewarmingPowerhouseRuntime ? "Powerhouse Is Warming" : "Install and Warm Powerhouse", systemImage: "bolt.fill")
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(store.isPrewarmingPowerhouseRuntime)

                    Button {
                        Task { await store.prewarmPowerhouseRuntime(install: false) }
                    } label: {
                        Label("Warm Without Installing", systemImage: "flame")
                    }
                    .buttonStyle(.bordered)
                    .disabled(store.isPrewarmingPowerhouseRuntime)

                    Button {
                        Task { await store.cancelPowerhouseRuntimeWarmPass() }
                    } label: {
                        Label("Cancel", systemImage: "stop.circle")
                    }
                    .buttonStyle(.bordered)
                    .disabled(!store.powerhouseCanCancel)

                    Button {
                        Task { await store.retryPowerhouseRuntimeWarmPass() }
                    } label: {
                        Label("Retry", systemImage: "arrow.clockwise")
                    }
                    .buttonStyle(.bordered)
                    .disabled(store.isPrewarmingPowerhouseRuntime || !store.powerhouseCanRetry)

                    Button {
                        store.recoverPowerhouseRuntimeUI()
                    } label: {
                        Label("Recover UI", systemImage: "lifepreserver")
                    }
                    .buttonStyle(.bordered)
                }
            }
            .padding(14)
            .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 8))

            VStack(alignment: .leading, spacing: 10) {
                Text("Install and Verification")
                    .font(.headline)

                if store.companionVoiceDependencyItems.isEmpty {
                    StatusRow(
                        title: "Install Plan",
                        value: store.companionVoiceDependencyInstallSummary.isEmpty ? "No missing installable voice dependencies are currently reported." : store.companionVoiceDependencyInstallSummary,
                        symbol: "checkmark.seal"
                    )
                } else {
                    ForEach(store.companionVoiceDependencyItems) { item in
                        DependencyItemRow(item: item)
                    }
                }
                if store.isInstallingCompanionVoiceDependencies,
                   !store.companionVoiceDependencyInstallProgress.isEmpty {
                    StatusRow(
                        title: "Install Progress",
                        value: store.companionVoiceDependencyInstallProgress,
                        symbol: "arrow.down.circle")
                }
                StatusRow(
                    title: "Warm Runtime",
                    value: store.isPrewarmingCompanionVoiceRuntime ? "Starting and warming the local Companion Realtime Voice runtime..." : store.companionVoiceWarmSummary,
                    symbol: "flame"
                )
            }
            .padding(14)
            .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 8))

            HStack(spacing: 10) {
                Button {
                    Task { await store.refreshStatus() }
                } label: {
                    Label("Verify Again", systemImage: "arrow.clockwise")
                }
                .buttonStyle(.bordered)

                Button {
                    Task { await store.installMissingCompanionVoiceDependencies() }
                } label: {
                    Label(store.isInstallingCompanionVoiceDependencies ? "Installing Voice Dependencies" : "Install Voice Dependencies", systemImage: "square.and.arrow.down")
                }
                .buttonStyle(.borderedProminent)
                .disabled(!store.companionVoiceDependencyInstallAvailable || store.isInstallingCompanionVoiceDependencies || store.status.isWorking)

                Button {
                    store.openNodeInstallPage()
                } label: {
                    Label("Get Node.js", systemImage: "terminal")
                }
                .buttonStyle(.bordered)
            }

            Text("The install action uses a user-local Python runtime and Hugging Face model cache. It does not change Tailscale, OpenClaw, Hermes, or your phone pairing settings.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .panelStyle()
    }

    private var statusTitle: String {
        switch store.companionVoiceState {
        case "ready":
            "Ready for Companion Realtime Voice"
        case "needs_setup":
            "Setup Needed"
        case "failed":
            "Verification Failed"
        case "not_reported":
            "Runtime Status Not Reported"
        default:
            "Runtime Not Checked"
        }
    }

    private var statusSymbol: String {
        switch store.companionVoiceState {
        case "ready":
            "checkmark.circle.fill"
        case "needs_setup":
            "arrow.down.circle.fill"
        case "failed":
            "xmark.octagon.fill"
        default:
            "questionmark.circle"
        }
    }

    private var statusColor: Color {
        switch store.companionVoiceState {
        case "ready":
            .green
        case "needs_setup":
            .orange
        case "failed":
            .red
        default:
            .secondary
        }
    }
}

private struct DependencyItemRow: View {
    let item: CompanionVoiceDependencyItem

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: item.installable ? "square.and.arrow.down" : "exclamationmark.triangle")
                .foregroundStyle(item.installable ? .cyan : .orange)
                .frame(width: 24)

            VStack(alignment: .leading, spacing: 3) {
                Text(item.label)
                    .font(.headline)
                if !item.detail.isEmpty {
                    Text(item.detail)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if !item.command.isEmpty {
                    Text(item.command)
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                        .textSelection(.enabled)
                }
            }

            Spacer(minLength: 0)
        }
    }
}

private struct PowerhouseWorkerRow: View {
    let item: PowerhouseWorkerItem

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: symbol)
                .foregroundStyle(color)
                .frame(width: 24)

            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    Text(item.label)
                        .font(.headline)
                    Text(stateLabel)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(color)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 3)
                        .background(color.opacity(0.12), in: Capsule())
                }

                if !item.resource.isEmpty {
                    Text(item.resource)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                if !item.summary.isEmpty {
                    Text(item.summary)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                if !item.mode.isEmpty {
                    Text(item.elapsedMs.map { "Mode: \(item.mode) • \($0) ms" } ?? "Mode: \(item.mode)")
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                }
            }

            Spacer(minLength: 0)
        }
    }

    private var normalizedState: String {
        item.state.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    private var stateLabel: String {
        switch normalizedState {
        case "ready":
            "ready"
        case "planned-hot":
            "planned hot"
        case "planned-warm":
            "planned warm"
        case "on-demand":
            "on demand"
        case "cold":
            "cold"
        case "failed", "error":
            "failed"
        case "degraded":
            "degraded"
        default:
            normalizedState.isEmpty ? "unknown" : normalizedState.replacingOccurrences(of: "_", with: " ")
        }
    }

    private var symbol: String {
        switch normalizedState {
        case "ready":
            "checkmark.circle.fill"
        case "planned-hot":
            "flame.fill"
        case "planned-warm":
            "flame"
        case "on-demand", "cold":
            "clock"
        case "failed", "error":
            "xmark.octagon.fill"
        case "degraded":
            "exclamationmark.triangle.fill"
        default:
            "circle.dotted"
        }
    }

    private var color: Color {
        switch normalizedState {
        case "ready", "planned-hot":
            .green
        case "planned-warm":
            .cyan
        case "on-demand", "cold":
            .secondary
        case "failed", "error":
            .red
        case "degraded":
            .orange
        default:
            .secondary
        }
    }
}

private struct AccessItemRow: View {
    let item: CompanionAccessItem

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: symbol)
                .foregroundStyle(color)
                .frame(width: 24)

            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 8) {
                    Text(item.label)
                        .font(.headline)
                    Text(stateLabel)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(color)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 3)
                        .background(color.opacity(0.12), in: Capsule())
                }

                if !item.summary.isEmpty {
                    Text(item.summary)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                }

                if !item.path.isEmpty {
                    Text(item.path)
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                        .textSelection(.enabled)
                }

                if !item.detail.isEmpty {
                    Text(item.detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(3)
                        .textSelection(.enabled)
                }
            }

            Spacer(minLength: 0)
        }
    }

    private var symbol: String {
        switch item.state {
        case "ready":
            "checkmark.circle.fill"
        case "manual":
            "hand.raised.fill"
        case "blocked":
            "xmark.octagon.fill"
        case "needs_action":
            "exclamationmark.triangle.fill"
        default:
            "questionmark.circle"
        }
    }

    private var color: Color {
        switch item.state {
        case "ready":
            .green
        case "manual":
            .cyan
        case "blocked":
            .red
        case "needs_action":
            .orange
        default:
            .secondary
        }
    }

    private var stateLabel: String {
        switch item.state {
        case "ready":
            "Ready"
        case "manual":
            "Manual"
        case "blocked":
            "Blocked"
        case "needs_action":
            "Needs Action"
        default:
            "Unknown"
        }
    }
}

private struct PairingPanel: View {
    @ObservedObject var store: BridgeStore
    @State private var showingLargeQRCode = false

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            PanelHeader(title: "Pair Phone", subtitle: "Scan this QR code in VoiceClaw Realtime Settings. It syncs the bridge URL, OpenClaw settings, Hermes-capable route support, and Realtime authentication preferences.", symbol: "qrcode")

            Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 12) {
                GridRow {
                    FieldLabel("Realtime Auth")
                    VStack(alignment: .leading, spacing: 8) {
                        Picker("Realtime Auth", selection: $store.realtimeAuthMode) {
                            ForEach(CompanionRealtimeAuthMode.allCases) { mode in
                                Text(mode.label).tag(mode)
                            }
                        }
                        .pickerStyle(.segmented)

                        Text(store.realtimeAuthMode.detail)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)

                        Toggle("Fall back to OpenAI API key if OAuth fails", isOn: $store.realtimeAuthFallbackToAPIKey)
                            .toggleStyle(.checkbox)
                            .disabled(store.realtimeAuthMode != .openClawOAuth)

                        Text("Pairing transfers the selected authentication preference and any credentials you explicitly include. When the paired phone has its own setting, the phone's setting takes precedence. Diagnostics reports whether OAuth and API-key credentials are available.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }

                GridRow {
                    FieldLabel("OpenAI API Key")
                    VStack(alignment: .leading, spacing: 6) {
                        SecureField("sk-...", text: $store.openAIAPIKey)
                            .textFieldStyle(.roundedBorder)

                        Toggle("Include API Key in Setup QR", isOn: $store.includeOpenAIAPIKeyInPairing)
                            .toggleStyle(.checkbox)

                        Text("On by default. When enabled, the QR code and setup JSON include this key so VoiceClaw Realtime stores it securely on the paired phone during pairing. The preview below redacts it.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }

                GridRow {
                    FieldLabel("Bridge Credentials")
                    VStack(alignment: .leading, spacing: 6) {
                        Toggle("Include Bridge Credentials in Setup QR", isOn: $store.includeBridgeCredentialsInPairing)
                            .toggleStyle(.checkbox)

                        Text("On by default. The phone needs these credentials to authenticate Companion requests. Turning this off omits them and may require manual setup on the phone.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }

                GridRow {
                    FieldLabel("ChatGPT OAuth")
                    VStack(alignment: .leading, spacing: 6) {
                        Toggle("Include ChatGPT OAuth in Setup QR", isOn: $store.includeChatGPTOAuthInPairing)
                            .toggleStyle(.checkbox)

                        Text("On by default. Includes the Companion-managed ChatGPT OAuth credential set when available. The preview redacts token values.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }

                if VoiceClawProductSurfacePolicy.companionRealtimeVoiceVisible {
                    GridRow {
                        FieldLabel("Cerebras API Key")
                        VStack(alignment: .leading, spacing: 6) {
                            SecureField("csk-...", text: $store.cerebrasAPIKey)
                                .textFieldStyle(.roundedBorder)

                            Toggle("Include Cerebras Key in Setup QR", isOn: $store.includeCerebrasAPIKeyInPairing)
                                .toggleStyle(.checkbox)

                            Text("Used when VoiceClaw Realtime's Companion Realtime Voice engine is set to the Cerebras Companion Realtime Voice LLM. The preview below redacts it.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }

                GridRow {
                    FieldLabel("Non-Tailscale HTTPS Bridge")
                    VStack(alignment: .leading, spacing: 6) {
                        TextField("https://...", text: $store.watchPublicBridgeURL)
                            .textFieldStyle(.roundedBorder)

                        Text("Enter this only when a paired phone or watch should reach OpenClaw or Hermes Agent through a public HTTPS tunnel instead of the private Tailscale bridge. Leave it blank when paired devices use Tailscale, or when Apple Watch agent access always relays through the nearby iPhone.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }

            InfoCallout(symbol: "key.radiowaves.forward", title: "OpenAI Auth Status", bodyText: store.realtimeAuthStatusSummary)
            InfoCallout(symbol: "point.3.connected.trianglepath.dotted", title: "Which Runtime Handles the Work", bodyText: "GPT Realtime handles the live conversation on iPhone or Apple Watch. OpenClaw routes send substantive work to the selected OpenClaw agent, Hermes routes use the Hermes Agent CLI, and Codex routes use Codex app-server. The Companion keeps those route tasks and returned files independent from the live voice connection.")
            InfoCallout(symbol: "square.grid.2x2", title: "iOS Widgets and Watch Extras", bodyText: "For iPhone users, add VoiceClaw Realtime widgets from the iOS Home Screen widget gallery for one-tap route launches. You can also add VoiceClaw Realtime to the iPhone Lock Screen or Control Center for a quick Live launch; those controls open VoiceClaw Realtime directly on the iPhone, while this Companion is needed for OpenClaw and Hermes Bridge/Tunnel routes.")

            HStack(alignment: .top, spacing: 18) {
                Button {
                    showingLargeQRCode = true
                } label: {
                    VStack(spacing: 8) {
                        QRCodeView(value: setupCodeValue)
                            .frame(width: 180, height: 180)
                            .background(.white, in: RoundedRectangle(cornerRadius: 8))
                            .overlay(RoundedRectangle(cornerRadius: 8).stroke(.quaternary))

                        Label("Click to enlarge", systemImage: "arrow.up.left.and.arrow.down.right")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(setupCodeValue.isEmpty)
                .help("Open a larger QR code for scanning from the phone.")

                VStack(alignment: .leading, spacing: 12) {
                    Text(store.bridgeURL.isEmpty ? "Run setup to generate a Tailscale URL." : store.bridgeURL)
                        .font(.headline)
                        .textSelection(.enabled)

                    Text(store.pairingPreview.isEmpty ? "No pairing payload yet." : store.pairingPreview)
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .lineLimit(9)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(12)
                        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 8))

                    HStack(spacing: 10) {
                        Button {
                            store.copyPairingPayload()
                        } label: {
                            Label("Copy Setup JSON", systemImage: "doc.on.doc")
                        }
                        .disabled(store.pairingJSON.isEmpty)

                        Button {
                            store.copyPairingLink()
                        } label: {
                            Label("Copy Setup Link", systemImage: "link")
                        }
                        .disabled(store.pairingURL.isEmpty)
                    }
                    .buttonStyle(.bordered)

                    if !store.pairingQRCodeValue.isEmpty,
                       store.pairingQRCodeValue != store.pairingURL {
                        Text("The QR code uses a compact secure setup link. Copy Setup JSON still contains the full payload shown above.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
        .panelStyle()
        .sheet(isPresented: $showingLargeQRCode) {
            LargeQRCodeSheet(value: setupCodeValue, bridgeURL: store.bridgeURL) {
                showingLargeQRCode = false
            }
        }
        .task {
            store.refreshPairingPayloadForDisplay()
        }
    }

    private var setupCodeValue: String {
        if !store.pairingQRCodeValue.isEmpty { return store.pairingQRCodeValue }
        return store.pairingURL.isEmpty ? store.pairingJSON : store.pairingURL
    }
}

private struct LargeQRCodeSheet: View {
    let value: String
    let bridgeURL: String
    let dismiss: () -> Void

    var body: some View {
        VStack(spacing: 18) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Scan Setup Code")
                        .font(.title2.weight(.semibold))
                    Text(bridgeURL.isEmpty ? "Open VoiceClaw Realtime Settings on your phone and scan this code." : bridgeURL)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }

                Spacer()

                Button("Done", action: dismiss)
                    .keyboardShortcut(.cancelAction)
            }

            QRCodeView(value: value)
                .frame(width: 420, height: 420)
                .background(.white, in: RoundedRectangle(cornerRadius: 14))
                .overlay(RoundedRectangle(cornerRadius: 14).stroke(.quaternary))
                .shadow(color: .black.opacity(0.10), radius: 18, y: 8)
        }
        .padding(28)
        .frame(minWidth: 520, minHeight: 560)
        .background(.regularMaterial)
    }
}

private struct WorkCenterPanel: View {
    @ObservedObject var store: BridgeStore

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            PanelHeader(
                title: "Tasks & Files",
                subtitle: "Monitor work delegated through the Companion and manage files explicitly returned to VoiceClaw Realtime.",
                symbol: "tray.full"
            )

            HStack(spacing: 12) {
                WorkMetric(
                    title: "Active Tasks",
                    value: String(store.routeTasks.filter { !$0.isTerminal }.count),
                    symbol: "bolt.horizontal.circle"
                )
                WorkMetric(
                    title: "Retained Files",
                    value: String(store.artifacts.count),
                    symbol: "doc.on.doc"
                )
                WorkMetric(
                    title: "Inbox Used",
                    value: store.artifactInboxStatus.map {
                        ByteCountFormatter.string(fromByteCount: $0.totalBytes, countStyle: .file)
                    } ?? "Not checked",
                    symbol: "internaldrive"
                )
            }

            if let inbox = store.artifactInboxStatus {
                VStack(alignment: .leading, spacing: 7) {
                    HStack {
                        Text("Artifact Inbox Capacity")
                            .font(.headline)
                        Spacer()
                        Text("\(ByteCountFormatter.string(fromByteCount: inbox.totalBytes, countStyle: .file)) of \(ByteCountFormatter.string(fromByteCount: inbox.inboxLimitBytes, countStyle: .file))")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                    }
                    ProgressView(value: inbox.utilization)
                    Text("Up to \(inbox.filesPerTaskLimit) files per task and \(ByteCountFormatter.string(fromByteCount: inbox.fileLimitBytes, countStyle: .file)) per file. VoiceClaw Realtime Companion never evicts files automatically.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            HStack(spacing: 10) {
                Button {
                    Task { await store.refreshWorkCenter() }
                } label: {
                    Label(store.isRefreshingWorkCenter ? "Refreshing" : "Refresh", systemImage: "arrow.clockwise")
                }
                .buttonStyle(.bordered)
                .disabled(store.isRefreshingWorkCenter)

                Button {
                    store.openArtifactInbox()
                } label: {
                    Label("Open Inbox", systemImage: "folder")
                }
                .buttonStyle(.borderedProminent)

                Button(role: .destructive) {
                    Task { await store.emptyArtifactInbox() }
                } label: {
                    Label("Empty Inbox", systemImage: "trash")
                }
                .buttonStyle(.bordered)
                .disabled(store.artifacts.isEmpty)

                Spacer()

                if store.isRefreshingWorkCenter {
                    ProgressView()
                        .controlSize(.small)
                }
            }

            if !store.workCenterError.isEmpty {
                BannerContent(
                    symbol: "exclamationmark.triangle.fill",
                    title: "Tasks & Files Needs Attention",
                    bodyText: store.workCenterError,
                    color: .orange
                )
            } else {
                Text(store.workCenterSummary)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            VStack(alignment: .leading, spacing: 12) {
                Text("Route Tasks")
                    .font(.title3.weight(.semibold))

                if store.routeTasks.isEmpty {
                    WorkEmptyState(
                        title: "No Route Tasks",
                        symbol: "checklist",
                        detail: "Tasks delegated from VoiceClaw Realtime will appear here without changing the selected voice route."
                    )
                } else {
                    ForEach(Array(store.routeTasks.enumerated()), id: \.element.id) { index, task in
                        if index > 0 { Divider() }
                        RouteTaskRow(task: task) {
                            Task { await store.cancelRouteTask(task) }
                        }
                    }
                }
            }

            VStack(alignment: .leading, spacing: 12) {
                Text("Artifact Inbox")
                    .font(.title3.weight(.semibold))

                if store.artifacts.isEmpty {
                    WorkEmptyState(
                        title: "Inbox Empty",
                        symbol: "tray",
                        detail: "Files appear only when you explicitly ask an OpenClaw, Hermes, or Codex task to return them to VoiceClaw Realtime."
                    )
                } else {
                    ForEach(Array(store.artifacts.enumerated()), id: \.element.id) { index, artifact in
                        if index > 0 { Divider() }
                        ArtifactInboxRow(artifact: artifact) {
                            Task { await store.deleteArtifact(artifact) }
                        }
                    }
                }
            }

            if let lastRefresh = store.lastWorkCenterRefreshDate {
                Text("Last refreshed \(lastRefresh.formatted(date: .abbreviated, time: .standard)).")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
        }
        .panelStyle()
    }
}

private struct WorkMetric: View {
    let title: String
    let value: String
    let symbol: String

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: symbol)
                .font(.title2)
                .foregroundStyle(.cyan)
                .frame(width: 28)
            VStack(alignment: .leading, spacing: 2) {
                Text(value)
                    .font(.title3.weight(.semibold))
                    .lineLimit(1)
                Text(title)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct WorkEmptyState: View {
    let title: String
    let symbol: String
    let detail: String

    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: symbol)
                .font(.system(size: 28))
                .foregroundStyle(.secondary)
            Text(title)
                .font(.headline)
            Text(detail)
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, minHeight: 120)
    }
}

private struct RouteTaskRow: View {
    let task: CompanionRouteTask
    let cancel: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: stateSymbol)
                .font(.title3)
                .foregroundStyle(stateColor)
                .frame(width: 28)

            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 8) {
                    Text(task.request.summary)
                        .font(.headline)
                        .lineLimit(2)
                    TaskStateBadge(state: task.state)
                }

                Text("\(task.target.runtime.capitalized) • \(task.target.route) • Agent \(task.target.agentID)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)

                if let progress = task.progress?.summary, !progress.isEmpty {
                    Text(progress)
                        .font(.callout)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let result = task.result?.text, !result.isEmpty {
                    Text(result)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .lineLimit(4)
                }
                if let error = task.error?.message, !error.isEmpty {
                    Text(error)
                        .font(.callout)
                        .foregroundStyle(.red)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Text("Updated \(task.updatedDate.formatted(date: .abbreviated, time: .standard)) • \(task.taskID)")
                    .font(.caption2.monospaced())
                    .foregroundStyle(.tertiary)
                    .textSelection(.enabled)
            }

            Spacer(minLength: 12)

            if !task.isTerminal {
                Button(role: .destructive, action: cancel) {
                    Label("Cancel", systemImage: "stop.circle")
                }
                .buttonStyle(.bordered)
            }
        }
        .padding(.vertical, 4)
    }

    private var stateSymbol: String {
        switch task.state {
        case "completed", "completedWithArtifactWarning": "checkmark.circle.fill"
        case "failed": "xmark.octagon.fill"
        case "cancelled": "slash.circle.fill"
        case "awaitingApproval", "waitingForUser": "person.crop.circle.badge.questionmark"
        default: "clock.arrow.circlepath"
        }
    }

    private var stateColor: Color {
        switch task.state {
        case "completed": .green
        case "completedWithArtifactWarning", "awaitingApproval", "waitingForUser": .orange
        case "failed": .red
        case "cancelled": .secondary
        default: .cyan
        }
    }
}

private struct TaskStateBadge: View {
    let state: String

    var body: some View {
        Text(label)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .background(.quaternary, in: Capsule())
    }

    private var label: String {
        state
            .replacingOccurrences(of: "completedWithArtifactWarning", with: "Completed with file warning")
            .replacingOccurrences(of: "awaitingApproval", with: "Awaiting approval")
            .replacingOccurrences(of: "waitingForUser", with: "Waiting for you")
            .replacingOccurrences(of: "_", with: " ")
            .capitalized
    }
}

private struct ArtifactInboxRow: View {
    let artifact: CompanionArtifact
    let delete: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "doc.fill")
                .font(.title3)
                .foregroundStyle(.cyan)
                .frame(width: 28)

            VStack(alignment: .leading, spacing: 5) {
                Text(artifact.displayName)
                    .font(.headline)
                    .textSelection(.enabled)
                Text("\(ByteCountFormatter.string(fromByteCount: artifact.byteCount, countStyle: .file)) • \(artifact.contentType) • Task \(artifact.taskID)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                Text("SHA-256 \(artifact.sha256)")
                    .font(.caption2.monospaced())
                    .foregroundStyle(.tertiary)
                    .lineLimit(2)
                    .textSelection(.enabled)
                Text("Admitted \(artifact.admittedDate.formatted(date: .abbreviated, time: .standard))")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }

            Spacer(minLength: 12)

            Button(role: .destructive, action: delete) {
                Label("Delete", systemImage: "trash")
            }
            .buttonStyle(.bordered)
        }
        .padding(.vertical, 4)
    }
}

private struct TailscalePanel: View {
    @ObservedObject var store: BridgeStore

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            PanelHeader(title: "Tailscale", subtitle: "VoiceClaw Realtime uses Tailscale Serve so the paired phone can reach this Mac on your private network for OpenClaw and Hermes Agent routes.", symbol: "network")

            InfoCallout(symbol: "network.badge.shield.half.filled", title: "What Tailscale Serve Is", bodyText: "Tailscale Serve is a private HTTPS reverse proxy: it takes a Tailscale URL on this Mac and forwards it to the local VoiceClaw Realtime bridge running on 127.0.0.1. It is private to devices in your tailnet, not a public internet link.")
            InfoCallout(symbol: "number", title: "Why the URL has a port", bodyText: "The port selects the VoiceClaw Realtime bridge service on this Mac. With the default, the paired phone connects to a URL ending in :12321. If you choose another free port, run Install and Start again and pair the phone with the new QR code.")
            InfoCallout(symbol: "lock", title: "What Must Be Allowed", bodyText: "Tailscale must be installed and signed in, and HTTPS certificates must be enabled for your tailnet. If you are not the tailnet owner or admin, ask that person to enable HTTPS certificates. VoiceClaw Realtime configures Serve only when you click Install and Start. Verify Runtime checks the bridge and may refresh VoiceClaw Realtime's own stale LaunchAgent runtime, but it does not reset Tailscale mappings.")
            InfoCallout(symbol: "trash.slash", title: "Why VoiceClaw Realtime Does Not Use Serve Reset", bodyText: "Tailscale's full Serve reset clears every Serve mapping on this Mac. VoiceClaw Realtime only offers a guarded cleanup for the selected port, and only when the mapping looks exactly like VoiceClaw Realtime's own bridge.")

            StatusRow(title: "Tailscale Serve", value: store.tailscaleSummary, symbol: "network")

            HStack(spacing: 10) {
                Button {
                    store.openTailscaleInstallPage()
                } label: {
                    Label("Get Tailscale", systemImage: "arrow.down.circle")
                }
                .buttonStyle(.bordered)

                Button {
                    store.openTailscaleAdminConsole()
                } label: {
                    Label("Admin Console", systemImage: "gearshape")
                }
                .buttonStyle(.bordered)

                Button {
                    store.openTailscaleServeDocs()
                } label: {
                    Label("Serve Help", systemImage: "questionmark.circle")
                }
                .buttonStyle(.bordered)

                Button {
                    Task { await store.refreshStatus() }
                } label: {
                    Label(store.isCheckingBridgeRuntime ? "Checking Runtime" : "Verify Runtime", systemImage: "arrow.clockwise")
                }
                .buttonStyle(.bordered)
                .disabled(store.isCheckingBridgeRuntime)
            }
        }
        .panelStyle()
    }
}

private struct StatusPanel: View {
    @ObservedObject var store: BridgeStore

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            PanelHeader(title: "Diagnostics", subtitle: "Use this when setup fails, pairing fails, or the phone cannot reach the Mac. Verify Runtime runs the full readiness check and updates Last Checked when the cycle completes.", symbol: "checklist")

            DiagnosticSummaryCard(store: store)

            StatusRow(title: "Local Bridge", value: store.localBridgeSummary, symbol: "server.rack")
            StatusRow(title: "Bridge Runtime", value: store.runtimeIntegritySummary, symbol: "checkmark.seal")
            StatusRow(title: "Tailscale Serve", value: store.tailscaleSummary, symbol: "network")
            StatusRow(title: "Realtime Runtime", value: store.realtimeRuntimeSummary, symbol: "waveform.path.ecg")
            StatusRow(title: "Realtime Auth", value: "\(store.realtimeAuthMode.label), OpenAI API-key fallback \(store.realtimeAuthFallbackToAPIKey ? "on" : "off"). \(store.realtimeAuthStatusSummary)", symbol: "key.horizontal")
            if VoiceClawProductSurfacePolicy.companionRealtimeVoiceVisible {
                StatusRow(title: "Companion Realtime Voice", value: store.companionVoiceSummary, symbol: "brain.head.profile")
                StatusRow(title: "Companion Voice Warm Runtime", value: store.companionVoiceWarmSummary, symbol: "flame")
            }
            if VoiceClawProductSurfacePolicy.powerhouseVisible {
                StatusRow(title: "\(store.powerhouseMode.label) Powerhouse Runtime", value: store.powerhouseSummary, symbol: "bolt.horizontal.circle")
                StatusRow(title: "Mac Hardware Profile", value: store.powerhouseHardwareSummary, symbol: "cpu")
            }
            StatusRow(title: "Access and Permissions", value: store.accessSummary, symbol: "checkmark.shield")
            if VoiceClawProductSurfacePolicy.companionRealtimeVoiceVisible,
               !store.companionVoiceDependencyInstallSummary.isEmpty {
                StatusRow(title: "Voice Dependency Install", value: store.companionVoiceDependencyInstallSummary, symbol: "square.and.arrow.down")
            }
            if VoiceClawProductSurfacePolicy.powerhouseVisible,
               !store.powerhouseWorkerItems.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Powerhouse Worker Plan")
                        .font(.headline)
                    ForEach(store.powerhouseWorkerItems) { item in
                        PowerhouseWorkerRow(item: item)
                            .padding(12)
                            .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 8))
                    }
                }
            }
            StatusRow(title: "Recommended Next Step", value: store.setupAdvice, symbol: "lightbulb")
            StatusRow(title: "App Updates", value: store.updateSummary, symbol: store.updateAvailable ? "arrow.down.circle.fill" : "checkmark.seal")
            StatusRow(title: "Launch upon Startup", value: store.launchAtStartupSummary, symbol: store.launchAtStartupEnabled ? "power.circle.fill" : "power.circle")
            StatusRow(title: "Update Checks", value: store.automaticUpdateChecksEnabled ? "Automatic checks are on. VoiceClaw Realtime Companion checks at launch, when its main window is reopened or restored, and every \(store.automaticUpdateCheckInterval.shortLabel) while it remains open." : "Automatic checks are off. Use Check Updates when you want to compare against the latest signed GitHub Release.", symbol: "clock.arrow.circlepath")
            StatusRow(
                title: "Update Install",
                value: store.automaticUpdateInstallsEnabled
                    ? "Automatic Sparkle downloads are on. Visible Install Update buttons open the signed updater so VoiceClaw Realtime can download, verify, replace, and relaunch the app."
                    : "Automatic install is off. VoiceClaw Realtime will still show available updates, but you decide when to install them.",
                symbol: store.automaticUpdateInstallsEnabled ? "arrow.down.app.fill" : "arrow.down.app"
            )

            if let lastUpdateCheckDate = store.lastUpdateCheckDate {
                StatusRow(title: "Updates Checked", value: lastUpdateCheckDate.formatted(date: .abbreviated, time: .standard), symbol: "calendar.badge.clock")
            }

            StatusRow(title: "Last Checked", value: lastCheckedText, symbol: "clock")

            if !store.accessItems.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Detailed Readiness Checks")
                        .font(.headline)
                    ForEach(store.accessItems) { item in
                        AccessItemRow(item: item)
                            .padding(12)
                            .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 8))
                    }
                }
            }

            if !store.lastLog.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Latest Action Log")
                        .font(.headline)
                    Text(store.lastLog)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(12)
                .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 8))
            }

            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 10) {
                    Button {
                        Task { await store.refreshStatus() }
                    } label: {
                        Label(store.isCheckingBridgeRuntime ? "Checking Runtime" : "Verify Runtime", systemImage: "arrow.clockwise")
                    }
                    .buttonStyle(.bordered)
                    .disabled(store.isCheckingBridgeRuntime)

                    Button {
                        store.openNodeInstallPage()
                    } label: {
                        Label("Get Node.js", systemImage: "terminal")
                    }
                    .buttonStyle(.bordered)

                    Button {
                        store.openOpenClawFolder()
                    } label: {
                        Label("Open OpenClaw Folder", systemImage: "folder")
                    }
                    .buttonStyle(.bordered)

                    if VoiceClawProductSurfacePolicy.companionRealtimeVoiceVisible,
                       store.companionVoiceDependencyInstallAvailable {
                        Button {
                            Task { await store.installMissingCompanionVoiceDependencies() }
                        } label: {
                            Label(store.isInstallingCompanionVoiceDependencies ? "Installing Voice Dependencies" : "Install Voice Dependencies", systemImage: "square.and.arrow.down")
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(store.isInstallingCompanionVoiceDependencies || store.status.isWorking)
                    }
                }

                HStack(spacing: 10) {
                    Button {
                        Task { await store.checkForUpdates() }
                    } label: {
                        Label(store.isCheckingForUpdates ? "Checking" : "Check Updates", systemImage: "arrow.down.circle")
                    }
                    .buttonStyle(.bordered)
                    .disabled(store.isCheckingForUpdates)

                    if store.updateAvailable {
                        Button {
                            store.installLatestUpdate()
                        } label: {
                            Label("Install Update", systemImage: "arrow.down.circle.fill")
                        }
                        .buttonStyle(.borderedProminent)

                        Button {
                            store.openLatestRelease()
                        } label: {
                            Label("Open Release", systemImage: "safari")
                        }
                        .buttonStyle(.bordered)
                    }
                }

                Toggle("Automatically check GitHub Releases for notarized DMG updates", isOn: $store.automaticUpdateChecksEnabled)
                    .toggleStyle(.checkbox)
                    .font(.caption)
                    .foregroundStyle(.secondary)

                Picker("Check Frequency", selection: $store.automaticUpdateCheckInterval) {
                    ForEach(CompanionUpdateCheckInterval.allCases) { interval in
                        Text(interval.shortLabel).tag(interval)
                    }
                }
                .pickerStyle(.segmented)
                .frame(maxWidth: 360)
                .disabled(!store.automaticUpdateChecksEnabled)

                Text("VoiceClaw Realtime Companion checks at launch, whenever its main window is reopened or restored, and then repeats at this interval while the app remains open.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)

                Text("Verify Runtime checks the installed bridge runtime identity, local bridge process, Tailscale Serve mapping, Realtime endpoints, and Mac access. It updates Last Checked when the cycle completes and may refresh VoiceClaw Realtime's own stale LaunchAgent runtime when safe.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)

                Toggle("Allow Sparkle to automatically download signed updates", isOn: $store.automaticUpdateInstallsEnabled)
                    .toggleStyle(.checkbox)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .disabled(!store.automaticUpdateChecksEnabled)
            }

            DiagnosticsVersionFooter()
        }
        .panelStyle()
    }

    private var lastCheckedText: String {
        if store.isCheckingBridgeRuntime {
            return "Checking now. This timestamp updates when Verify Runtime finishes."
        }
        if let lastRefreshDate = store.lastRefreshDate {
            return lastRefreshDate.formatted(date: .abbreviated, time: .standard)
        }
        return "Not checked yet. Click Verify Runtime to run the full Companion readiness check."
    }
}

private struct DiagnosticSummaryCard: View {
    @ObservedObject var store: BridgeStore

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            if store.isCheckingBridgeRuntime {
                ProgressView()
                    .controlSize(.small)
                    .frame(width: 28)
            } else {
                Image(systemName: symbol)
                    .font(.title2)
                    .foregroundStyle(color)
                    .frame(width: 28)
            }

            VStack(alignment: .leading, spacing: 6) {
                Text(store.isCheckingBridgeRuntime ? "Checking Bridge Runtime" : store.status.title)
                    .font(.title3.weight(.semibold))
                Text(store.bridgeRuntimeCheckSummary)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Spacer(minLength: 0)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(color.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(color.opacity(0.35), lineWidth: 1))
    }

    private var symbol: String {
        switch store.status {
        case .idle:
            "circle"
        case .working:
            "hourglass"
        case .ready:
            "checkmark.circle.fill"
        case .warning:
            "exclamationmark.triangle.fill"
        case .failed:
            "xmark.octagon.fill"
        }
    }

    private var color: Color {
        if store.isCheckingBridgeRuntime { return .orange }
        switch store.status {
        case .idle:
            return .gray
        case .working:
            return .yellow
        case .ready:
            return .green
        case .warning:
            return .orange
        case .failed:
            return .red
        }
    }
}

private struct InfoCallout: View {
    let symbol: String
    let title: String
    let bodyText: String

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: symbol)
                .font(.title3)
                .foregroundStyle(.cyan)
                .frame(width: 24)

            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.headline)
                Text(bodyText)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(14)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 8))
    }
}

private struct PanelHeader: View {
    let title: String
    let subtitle: String
    let symbol: String

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: symbol)
                .font(.title2)
                .foregroundStyle(.cyan)
                .frame(width: 28)
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.title3.weight(.semibold))
                Text(subtitle)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

private struct FieldLabel: View {
    let text: String

    init(_ text: String) {
        self.text = text
    }

    var body: some View {
        Text(text)
            .font(.subheadline.weight(.medium))
            .foregroundStyle(.secondary)
            .frame(width: 170, alignment: .trailing)
    }
}

private struct StatusRow: View {
    let title: String
    let value: String
    let symbol: String

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: symbol)
                .foregroundStyle(.secondary)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.headline)
                Text(value)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
            Spacer(minLength: 0)
        }
    }
}

private struct DiagnosticsVersionFooter: View {
    private var versionText: String {
        let info = Bundle.main.infoDictionary
        let version = info?["CFBundleShortVersionString"] as? String
        let build = info?["CFBundleVersion"] as? String

        switch (version?.isEmpty == false ? version : nil, build?.isEmpty == false ? build : nil) {
        case let (.some(version), .some(build)):
            return "VoiceClaw Realtime Companion \(version) (\(build))"
        case let (.some(version), .none):
            return "VoiceClaw Realtime Companion \(version)"
        case let (.none, .some(build)):
            return "VoiceClaw Realtime Companion build \(build)"
        case (.none, .none):
            return "VoiceClaw Realtime Companion version unavailable"
        }
    }

    var body: some View {
        Text(versionText)
            .font(.callout.monospaced().weight(.semibold))
            .foregroundStyle(.secondary)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .center)
            .padding(.top, 8)
            .accessibilityLabel("App Version")
            .accessibilityValue(versionText)
    }
}

private struct BridgeLogo: View {
    var body: some View {
        if let icon = Self.appIcon {
            Image(nsImage: icon)
                .resizable()
                .scaledToFit()
                .shadow(color: .black.opacity(0.16), radius: 10, y: 5)
        } else {
            ZStack {
                RoundedRectangle(cornerRadius: 20)
                    .fill(.linearGradient(colors: [.cyan, .indigo, .purple], startPoint: .topLeading, endPoint: .bottomTrailing))
                Image(systemName: "waveform.path.ecg")
                    .font(.system(size: 42, weight: .semibold))
                    .foregroundStyle(.white)
                    .shadow(radius: 12)
            }
        }
    }

    private static var appIcon: NSImage? {
        NSImage(named: "AppIcon")
            ?? Bundle.main.url(forResource: "AppIcon", withExtension: "icns").flatMap(NSImage.init(contentsOf:))
    }
}

private struct QRCodeView: View {
    let value: String

    var body: some View {
        if let image = makeQRCode(from: value) {
            Image(nsImage: image)
                .interpolation(.none)
                .resizable()
                .scaledToFit()
                .padding(14)
        } else {
            VStack(spacing: 8) {
                Image(systemName: "qrcode")
                    .font(.largeTitle)
                    .foregroundStyle(.secondary)
                Text(value.isEmpty ? "No Setup Code" : "Setup Code Too Large")
                    .font(.headline)
                    .foregroundStyle(.secondary)
                if !value.isEmpty {
                    Text("Use Copy Setup JSON or Copy Setup Link.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func makeQRCode(from value: String) -> NSImage? {
        guard !value.isEmpty else { return nil }
        let context = CIContext()
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(value.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage,
              let cgImage = context.createCGImage(output.transformed(by: CGAffineTransform(scaleX: 10, y: 10)), from: output.extent.applying(CGAffineTransform(scaleX: 10, y: 10)))
        else { return nil }
        return NSImage(cgImage: cgImage, size: NSSize(width: 220, height: 220))
    }
}

private extension View {
    func panelStyle() -> some View {
        self
            .padding(18)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(.white.opacity(0.12)))
    }
}

#Preview {
    ContentView(store: BridgeStore())
}
