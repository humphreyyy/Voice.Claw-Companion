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
                        Label("Check Status", systemImage: "arrow.clockwise")
                    }
                    .help("Re-check the local bridge and Tailscale Serve status. The app also checks automatically after setup and at launch.")

                }
            }
        }
    }
}

private enum CompanionSection: String, CaseIterable, Identifiable {
    case setup
    case pair
    case tailscale
    case diagnostics

    var id: String { rawValue }

    var title: String {
        switch self {
        case .setup:
            "Set Up"
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
                    StatusBanner(store: store)

                    switch selection {
                    case .setup:
                        SetupPanel(store: store)
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

            InfoCallout(symbol: "checkmark.shield", title: "What Install and Start Changes", bodyText: "This button creates VoiceClaw's local config, installs a LaunchAgent for this user, starts the bridge, and configures Tailscale Serve for the selected port. The same bridge serves OpenClaw routes, Hermes Agent routes, GPT-Realtime-2 signaling, and Apple Watch relay. Check Again only reads status.")
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
                    Label("Check Again", systemImage: "arrow.clockwise")
                }
                .buttonStyle(.bordered)
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
            InfoCallout(symbol: "point.3.connected.trianglepath.dotted", title: "Which Runtime Handles the Work", bodyText: "The selected iOS voice engine handles live speech. GPT-Realtime-2 uses OpenAI Realtime directly; Companion Realtime Voice uses this Mac for speech-to-text, the selected middle brain, and text-to-speech. OpenClaw routes send substantive work to OpenClaw using the OpenClaw path and agent above. Hermes routes send substantive work to Hermes Agent through the hermes CLI; the OpenClaw path is not used for Hermes.")
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
        store.pairingURL.isEmpty ? store.pairingJSON : store.pairingURL
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
            InfoCallout(symbol: "lock", title: "What Must Be Allowed", bodyText: "Tailscale must be installed and signed in, and HTTPS certificates must be enabled for your tailnet. If you are not the tailnet owner or admin, ask that person to enable HTTPS certificates. VoiceClaw configures Serve only when you click Install and Start; Check Again is read-only.")
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
                    Label("Check Again", systemImage: "arrow.clockwise")
                }
                .buttonStyle(.bordered)
            }
        }
        .panelStyle()
    }
}

private struct StatusPanel: View {
    @ObservedObject var store: BridgeStore

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            PanelHeader(title: "Diagnostics", subtitle: "Use this when setup fails, pairing fails, or the phone cannot reach the Mac. Status checks also run automatically at launch and after setup.", symbol: "checklist")

            StatusRow(title: "Local Bridge", value: store.localBridgeSummary, symbol: "server.rack")
            StatusRow(title: "Tailscale Serve", value: store.tailscaleSummary, symbol: "network")
            StatusRow(title: "Realtime Runtime", value: store.realtimeRuntimeSummary, symbol: "waveform.path.ecg")
            StatusRow(title: "Realtime Auth", value: "\(store.realtimeAuthMode.label), OpenAI API-key fallback \(store.realtimeAuthFallbackToAPIKey ? "on" : "off"). \(store.realtimeAuthStatusSummary)", symbol: "key.horizontal")
            StatusRow(title: "Companion Realtime Voice", value: store.companionVoiceSummary, symbol: "brain.head.profile")
            StatusRow(title: "Recommended Next Step", value: store.setupAdvice, symbol: "lightbulb")
            StatusRow(title: "App Updates", value: store.updateSummary, symbol: store.updateAvailable ? "arrow.down.circle.fill" : "checkmark.seal")
            StatusRow(title: "Launch upon Startup", value: store.launchAtStartupSummary, symbol: store.launchAtStartupEnabled ? "power.circle.fill" : "power.circle")
            StatusRow(title: "Update Checks", value: store.automaticUpdateChecksEnabled ? "Automatic checks are on. VoiceClaw checks for signed GitHub Release updates every \(store.automaticUpdateCheckInterval.shortLabel)." : "Automatic checks are off. The menu bar icon shows an update warning; use Check Updates when you want to compare against the latest release.", symbol: "clock.arrow.circlepath")
            StatusRow(title: "Update Install", value: store.automaticUpdateInstallsEnabled ? "Automatic install is on. When Sparkle finds a signed update, it can download and install it in-app instead of making you open a DMG manually." : "Automatic install is off. VoiceClaw will still show available updates, but you decide when to install them.", symbol: store.automaticUpdateInstallsEnabled ? "arrow.down.app.fill" : "arrow.down.app")

            if let lastUpdateCheckDate = store.lastUpdateCheckDate {
                StatusRow(title: "Updates Checked", value: lastUpdateCheckDate.formatted(date: .abbreviated, time: .standard), symbol: "calendar.badge.clock")
            }

            if let lastRefreshDate = store.lastRefreshDate {
                StatusRow(title: "Last Checked", value: lastRefreshDate.formatted(date: .abbreviated, time: .standard), symbol: "clock")
            }

            if !store.lastLog.isEmpty {
                Text(store.lastLog)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
                    .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 8))
            }

            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 10) {
                    Button {
                        Task { await store.refreshStatus() }
                    } label: {
                        Label("Check Again", systemImage: "arrow.clockwise")
                    }
                    .buttonStyle(.bordered)

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

                Toggle("Automatically download and install signed updates", isOn: $store.automaticUpdateInstallsEnabled)
                    .toggleStyle(.checkbox)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .disabled(!store.automaticUpdateChecksEnabled)
            }

            DiagnosticsVersionFooter()
        }
        .panelStyle()
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
                Text("No Setup Code")
                    .font(.headline)
                    .foregroundStyle(.secondary)
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
