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
                    .help("Run the full Companion readiness check: bridge runtime identity, local bridge, Tailscale Serve, Realtime endpoints, Companion Realtime Voice dependencies, warm runtime status, and required Mac access.")

                }
            }
        }
    }
}

private enum CompanionSection: String, CaseIterable, Identifiable {
    case setup
    case access
    case companionVoice
    case pair
    case tailscale
    case diagnostics

    var id: String { rawValue }

    var title: String {
        switch self {
        case .setup:
            "Set Up"
        case .access:
            "Access"
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
            ForEach(CompanionSection.allCases) { section in
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
        .navigationTitle("VoiceClaw Companion")
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
                Text("VoiceClaw Companion")
                    .font(.system(size: 34, weight: .semibold, design: .rounded))
                Text("Install and manage the private Mac companion that lets VoiceClaw on your phone or watch reach OpenClaw or Hermes Agent on this Mac through Tailscale or an HTTPS tunnel.")
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
            return "VoiceClaw Companion Update Available"
        }
        return "VoiceClaw Companion \(store.latestReleaseTag) Is Available"
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
            .help("Open VoiceClaw Companion automatically when this Mac user logs in.")
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
                        Text("Leave this as main unless setup fails and you want to try another OpenClaw agent. Hermes routes do not use this field; the Companion resumes Hermes CLI sessions by VoiceClaw session token.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }

            InfoCallout(symbol: "checkmark.shield", title: "What Install and Start Changes", bodyText: "This button creates VoiceClaw's local config, installs a LaunchAgent for this user, starts the bridge, and configures Tailscale Serve for the selected port. The same bridge serves OpenClaw routes, Hermes Agent routes, GPT-Realtime-2 signaling, Apple Watch relay, and Companion Realtime Voice. Verify Runtime runs the full readiness check and can refresh VoiceClaw's own stale LaunchAgent runtime when the installed app safely owns it.")
            InfoCallout(symbol: "sparkles", title: "Hermes Agent Routes", bodyText: "Hermes via Tailscale and Hermes HTTPS Tunnel do not need a Hermes path in this app. The bridge starts normally, then calls the hermes CLI from the user's PATH (or HERMES_BIN) with HERMES_HOME. Use Hermes routes in the phone or watch app after installing Hermes Agent and confirming it works in Terminal.")
            InfoCallout(symbol: "arrow.counterclockwise", title: "Testing First-Run Setup", bodyText: "Reset First-Run State removes only VoiceClaw's LaunchAgent and local bridge config. Use Reset App + Tailscale Mapping only when Diagnostics says the selected port is a VoiceClaw mapping; it will refuse to touch other Serve mappings.")
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
                .help(store.canResetTailscaleMapping ? "Remove VoiceClaw's local state and the selected Tailscale Serve mapping." : "Available only when Diagnostics identifies the selected port as a VoiceClaw Tailscale Serve mapping.")
            }
        }
        .panelStyle()
        .confirmationDialog(
            "Remove the selected VoiceClaw Tailscale Serve mapping?",
            isPresented: $showingNetworkResetConfirmation,
            titleVisibility: .visible
        ) {
            Button("Reset App + Mapping", role: .destructive) {
                Task { await store.resetForFirstRun(removeTailscaleMapping: true) }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This removes VoiceClaw's LaunchAgent and local bridge config, then removes only the selected Tailscale Serve port if it maps exactly to the VoiceClaw bridge. Tailscale, OpenClaw, and Node.js remain installed.")
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
                bodyText: "VoiceClaw can install local runtimes and open the right settings panes, but macOS still requires the user to approve protected permissions such as Login Items, Microphone, Full Disk Access, Files and Folders, and Local Network when those prompts appear."
            )
            InfoCallout(
                symbol: "externaldrive.connected.to.line.below",
                title: "What VoiceClaw uses",
                bodyText: "The Companion writes local config under ~/.voiceclaw, stores HF voice models in the Hugging Face cache, starts a per-user LaunchAgent, serves a local bridge on the selected port, and can run OpenClaw or Hermes commands from this Mac when those routes are selected."
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
                    StatusRow(title: "Companion Realtime Voice", value: store.companionVoiceSummary, symbol: "brain.head.profile")
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
                        Label("Open VoiceClaw Data", systemImage: "externaldrive")
                    }

                    Button {
                        store.openHuggingFaceCacheFolder()
                    } label: {
                        Label("Open HF Model Cache", systemImage: "shippingbox")
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

                if store.companionVoiceDependencyInstallAvailable {
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

            Text("VoiceClaw does not use or contact unrelated local services outside its own bridge/runtime paths. Personal development services on other ports should remain isolated from Companion setup.")
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
                subtitle: "Prepare this Mac to run VoiceClaw's local speech-to-text, Companion Realtime Voice LLM, and text-to-speech pipeline for the Companion Realtime Voice engine.",
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
                bodyText: "Restarting the VoiceClaw voice session should restart audio and realtime transport only. It should not reset an OpenClaw or Hermes conversation unless the user explicitly asks to start a new agent session."
            )

            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Powerhouse Mode")
                            .font(.headline)
                        Text("Choose how aggressively this Mac should use CPU, GPU, memory, models, and network readiness for VoiceClaw.")
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
                    value: store.isPrewarmingPowerhouseRuntime ? "Running an aggressive Powerhouse warm/install pass..." : store.powerhouseSummary,
                    symbol: "bolt.horizontal.circle"
                )

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
                        Text("Worker Plan")
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
                    .disabled(store.isPrewarmingPowerhouseRuntime || store.status.isWorking)

                    Button {
                        Task { await store.prewarmPowerhouseRuntime(install: false) }
                    } label: {
                        Label("Warm Without Installing", systemImage: "flame")
                    }
                    .buttonStyle(.bordered)
                    .disabled(store.isPrewarmingPowerhouseRuntime || store.status.isWorking)
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

                if !item.mode.isEmpty {
                    Text("Mode: \(item.mode)")
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
            PanelHeader(title: "Pair Phone", subtitle: "Scan this QR code in VoiceClaw Settings. It syncs the bridge URL, OpenClaw settings, Hermes-capable route support, and Realtime auth preferences. GPT-Realtime-2 currently requires API Key mode until OpenAI re-enables Sign-in-with-ChatGPT access.", symbol: "qrcode")

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

                        Text("When the paired phone sends its own setting, the phone wins. For current GPT-Realtime-2 Live sessions, use API Key mode with an OpenAI API key included in pairing, entered on the phone, or available to the Companion environment. OAuth is kept for future Sign-in-with-ChatGPT Realtime support, but Companion-minted OAuth client secrets are not presently admitted by Realtime signaling.")
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

                        Text("On by default. When enabled, the QR code and setup JSON include this key so VoiceClaw stores it securely on the paired phone during pairing. The preview below redacts it.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }

                GridRow {
                    FieldLabel("Cerebras API Key")
                    VStack(alignment: .leading, spacing: 6) {
                        SecureField("csk-...", text: $store.cerebrasAPIKey)
                            .textFieldStyle(.roundedBorder)

                        Toggle("Include Cerebras Key in Setup QR", isOn: $store.includeCerebrasAPIKeyInPairing)
                            .toggleStyle(.checkbox)

                        Text("Used when VoiceClaw's Companion Realtime Voice engine is set to the Cerebras Companion Realtime Voice LLM. The preview below redacts it.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
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
            InfoCallout(symbol: "point.3.connected.trianglepath.dotted", title: "Which Runtime Handles the Work", bodyText: "The selected iOS voice engine handles live speech. GPT-Realtime-2 uses OpenAI Realtime directly; Companion Realtime Voice uses this Mac for speech-to-text, the selected Companion Realtime Voice LLM, and text-to-speech. OpenClaw routes send substantive work to OpenClaw using the OpenClaw path and agent above. Hermes routes send substantive work to Hermes Agent through the hermes CLI; the OpenClaw path is not used for Hermes.")
            InfoCallout(symbol: "square.grid.2x2", title: "iOS Widgets and Watch Extras", bodyText: "For iPhone users, add VoiceClaw widgets from the iOS Home Screen widget gallery for one-tap route launches. You can also add VoiceClaw to the iPhone Lock Screen or Control Center for a quick Live launch; those controls open VoiceClaw directly on the iPhone, while this Companion is needed for OpenClaw and Hermes Bridge/Tunnel routes.")

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
                    Text(bridgeURL.isEmpty ? "Open VoiceClaw Settings on your phone and scan this code." : bridgeURL)
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

private struct TailscalePanel: View {
    @ObservedObject var store: BridgeStore

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            PanelHeader(title: "Tailscale", subtitle: "VoiceClaw uses Tailscale Serve so the paired phone can reach this Mac on your private network for OpenClaw and Hermes Agent routes.", symbol: "network")

            InfoCallout(symbol: "network.badge.shield.half.filled", title: "What Tailscale Serve Is", bodyText: "Tailscale Serve is a private HTTPS reverse proxy: it takes a Tailscale URL on this Mac and forwards it to the local VoiceClaw bridge running on 127.0.0.1. It is private to devices in your tailnet, not a public internet link.")
            InfoCallout(symbol: "number", title: "Why the URL has a port", bodyText: "The port selects the VoiceClaw bridge service on this Mac. With the default, the paired phone connects to a URL ending in :12321. If you choose another free port, run Install and Start again and pair the phone with the new QR code.")
            InfoCallout(symbol: "lock", title: "What Must Be Allowed", bodyText: "Tailscale must be installed and signed in, and HTTPS certificates must be enabled for your tailnet. If you are not the tailnet owner or admin, ask that person to enable HTTPS certificates. VoiceClaw configures Serve only when you click Install and Start. Verify Runtime checks the bridge and may refresh VoiceClaw's own stale LaunchAgent runtime, but it does not reset Tailscale mappings.")
            InfoCallout(symbol: "trash.slash", title: "Why VoiceClaw Does Not Use Serve Reset", bodyText: "Tailscale's full Serve reset clears every Serve mapping on this Mac. VoiceClaw only offers a guarded cleanup for the selected port, and only when the mapping looks exactly like VoiceClaw's own bridge.")

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
            PanelHeader(title: "Diagnostics", subtitle: "Use this when setup fails, pairing fails, the phone cannot reach the Mac, or Companion Realtime Voice is warming slowly. Verify Runtime runs the full readiness check and updates Last Checked when the cycle completes.", symbol: "checklist")

            DiagnosticSummaryCard(store: store)

            StatusRow(title: "Local Bridge", value: store.localBridgeSummary, symbol: "server.rack")
            StatusRow(title: "Bridge Runtime", value: store.runtimeIntegritySummary, symbol: "checkmark.seal")
            StatusRow(title: "Tailscale Serve", value: store.tailscaleSummary, symbol: "network")
            StatusRow(title: "Realtime Runtime", value: store.realtimeRuntimeSummary, symbol: "waveform.path.ecg")
            StatusRow(title: "Realtime Auth", value: "\(store.realtimeAuthMode.label), OpenAI API-key fallback \(store.realtimeAuthFallbackToAPIKey ? "on" : "off"). \(store.realtimeAuthStatusSummary)", symbol: "key.horizontal")
            StatusRow(title: "Companion Realtime Voice", value: store.companionVoiceSummary, symbol: "brain.head.profile")
            StatusRow(title: "Companion Voice Warm Runtime", value: store.companionVoiceWarmSummary, symbol: "flame")
            StatusRow(title: "\(store.powerhouseMode.label) Powerhouse Runtime", value: store.powerhouseSummary, symbol: "bolt.horizontal.circle")
            StatusRow(title: "Mac Hardware Profile", value: store.powerhouseHardwareSummary, symbol: "cpu")
            StatusRow(title: "Access and Permissions", value: store.accessSummary, symbol: "checkmark.shield")
            if !store.companionVoiceDependencyInstallSummary.isEmpty {
                StatusRow(title: "Voice Dependency Install", value: store.companionVoiceDependencyInstallSummary, symbol: "square.and.arrow.down")
            }
            if !store.powerhouseWorkerItems.isEmpty {
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
            StatusRow(title: "Update Checks", value: store.automaticUpdateChecksEnabled ? "Automatic checks are on. VoiceClaw checks for signed GitHub Release updates every \(store.automaticUpdateCheckInterval.shortLabel)." : "Automatic checks are off. The menu bar icon shows an update warning; use Check Updates when you want to compare against the latest release.", symbol: "clock.arrow.circlepath")
            StatusRow(
                title: "Update Install",
                value: store.automaticUpdateInstallsEnabled
                    ? "Automatic Sparkle downloads are on. Visible Install Update buttons open the signed updater so VoiceClaw can download, verify, replace, and relaunch the app."
                    : "Automatic install is off. VoiceClaw will still show available updates, but you decide when to install them.",
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

                    if store.companionVoiceDependencyInstallAvailable {
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

                Text("VoiceClaw checks once at launch and then repeats at this interval while the companion is open.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)

                Text("Verify Runtime checks the installed bridge runtime identity, local bridge process, Tailscale Serve mapping, Realtime endpoints, Companion Realtime Voice dependencies, warm HF runtime, and Mac access. It updates Last Checked when the cycle completes and may refresh VoiceClaw's own stale LaunchAgent runtime when safe.")
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
            return "VoiceClaw Companion \(version) (\(build))"
        case let (.some(version), .none):
            return "VoiceClaw Companion \(version)"
        case let (.none, .some(build)):
            return "VoiceClaw Companion build \(build)"
        case (.none, .none):
            return "VoiceClaw Companion version unavailable"
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
