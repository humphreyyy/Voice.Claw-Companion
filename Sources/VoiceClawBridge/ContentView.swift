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

                    Button {
                        Task { await store.setupBridge() }
                    } label: {
                        Label("Install and Start", systemImage: "bolt.horizontal.circle.fill")
                    }
                    .disabled(store.status.isWorking)
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
            "Pair iPhone"
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
        .navigationTitle("Voice.Claw")
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
                Text("Voice.Claw Companion")
                    .font(.system(size: 34, weight: .semibold, design: .rounded))
                Text("Install the private Mac bridge that lets VoiceClaw on iPhone reach OpenClaw on this Mac through Tailscale.")
                    .font(.title3)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Spacer(minLength: 24)

            Button {
                Task { await store.setupBridge() }
            } label: {
                Label(store.status.isWorking ? "Working" : "Set Up Bridge", systemImage: "bolt.horizontal.circle.fill")
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(store.status.isWorking)
        }
        .panelStyle()
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

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            PanelHeader(title: "Mac Setup", subtitle: "Install the local bridge, start it at login, and publish it privately through Tailscale Serve.", symbol: "desktopcomputer")

            Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 12) {
                GridRow {
                    FieldLabel("Bridge Port")
                    VStack(alignment: .leading, spacing: 6) {
                        HStack(spacing: 8) {
                            TextField("3191", text: $store.port)
                                .textFieldStyle(.roundedBorder)
                                .frame(maxWidth: 120)

                            Button("Use Default") {
                                store.useDefaultPort()
                            }
                            .buttonStyle(.bordered)
                        }

                        Text("Default is 3191. Change it only if that port is already in use, or if you intentionally want a separate test bridge. Use 1024-65535. The iPhone URL will include this port, and changing it means pairing the phone again.")
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
                        Text("Choose the folder that contains openclaw.json. On most Macs this is ~/.openclaw.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }

            InfoCallout(symbol: "checkmark.shield", title: "What Install and Start Changes", bodyText: "This button creates Voice.Claw's local config, installs a LaunchAgent for this user, starts the bridge, and configures Tailscale Serve for the selected port. The Check Again buttons only read status.")
            InfoCallout(symbol: "arrow.counterclockwise", title: "Testing First-Run Setup", bodyText: "Use Reset First-Run State when you want to experience setup from scratch. It removes only Voice.Claw's LaunchAgent and local bridge config. It does not uninstall Tailscale, change OpenClaw, remove Node.js, or erase tailnet settings.")

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
            }
        }
        .panelStyle()
    }
}

private struct PairingPanel: View {
    @ObservedObject var store: BridgeStore

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            PanelHeader(title: "Pair iPhone", subtitle: "Copy the setup payload into VoiceClaw Settings, or scan the QR code with Camera to open VoiceClaw.", symbol: "qrcode")

            HStack(alignment: .top, spacing: 18) {
                QRCodeView(value: store.pairingURL.isEmpty ? store.pairingJSON : store.pairingURL)
                    .frame(width: 180, height: 180)
                    .background(.white, in: RoundedRectangle(cornerRadius: 8))
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(.quaternary))

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
    }
}

private struct TailscalePanel: View {
    @ObservedObject var store: BridgeStore

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            PanelHeader(title: "Tailscale", subtitle: "Voice.Claw uses Tailscale Serve so the iPhone can reach this Mac on your private network.", symbol: "network")

            InfoCallout(symbol: "network.badge.shield.half.filled", title: "What Tailscale Serve Is", bodyText: "Tailscale Serve is a private HTTPS reverse proxy: it takes a Tailscale URL on this Mac and forwards it to the local Voice.Claw bridge running on 127.0.0.1. It is private to devices in your tailnet, not a public internet link.")
            InfoCallout(symbol: "number", title: "Why the URL has a port", bodyText: "The port selects the Voice.Claw bridge service on this Mac. With the default, the iPhone connects to a URL ending in :3191. If you choose another free port, run Install and Start again and pair the iPhone with the new QR code.")
            InfoCallout(symbol: "lock", title: "What Must Be Allowed", bodyText: "Tailscale must be installed and signed in, and HTTPS certificates must be enabled for your tailnet. If you are not the tailnet owner or admin, ask that person to enable HTTPS certificates. Voice.Claw configures Serve only when you click Install and Start; Check Again is read-only.")

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

private struct BridgeLogo: View {
    var body: some View {
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
