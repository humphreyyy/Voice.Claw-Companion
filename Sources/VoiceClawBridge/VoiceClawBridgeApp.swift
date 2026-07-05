import SwiftUI

@main
struct VoiceClawBridgeApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var store = BridgeStore()

    var body: some Scene {
        WindowGroup("VoiceClaw Companion", id: "main") {
            ContentView(store: store)
                .frame(minWidth: 920, minHeight: 660)
        }
        .commands {
            CommandMenu("Companion") {
                Button("Refresh Status") {
                    Task { await store.refreshStatus() }
                }
                .keyboardShortcut("r", modifiers: [.command])

                Button("Copy Phone Setup") {
                    store.copyPairingPayload()
                }
                .keyboardShortcut("c", modifiers: [.command, .shift])
                .disabled(store.pairingJSON.isEmpty)

                Button("Check for Updates") {
                    Task { await store.checkForUpdates() }
                }
                .keyboardShortcut("u", modifiers: [.command, .shift])
            }
        }

        MenuBarExtra(menuBarTitle, systemImage: menuBarSystemImage) {
            CompanionMenuBarView(store: store)
        }
        .menuBarExtraStyle(.menu)
    }

    private var menuBarTitle: String {
        store.updateAvailable ? "Update" : "VoiceClaw"
    }

    private var menuBarSystemImage: String {
        if store.updateAvailable {
            return "arrow.down.circle.fill"
        }
        if !store.automaticUpdateChecksEnabled || !store.automaticUpdateInstallsEnabled {
            return "exclamationmark.arrow.trianglehead.2.clockwise.rotate.90"
        }
        return "waveform.circle.fill"
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
    }
}

private struct CompanionMenuBarView: View {
    @ObservedObject var store: BridgeStore
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        if store.updateAvailable {
            Label("Update Available", systemImage: "arrow.down.circle.fill")
                .font(.headline)

            if !store.latestReleaseTag.isEmpty {
                Text(store.latestReleaseTag)
            }

            Button {
                Task { await store.downloadLatestDMG() }
            } label: {
                Label("Install Update", systemImage: "arrow.down.circle.fill")
            }
            .disabled(store.isDownloadingUpdate)

            Button {
                store.openLatestRelease()
            } label: {
                Label("Open Release", systemImage: "safari")
            }

            Divider()
        }

        Button {
            openMainWindow()
        } label: {
            Label("Show VoiceClaw Companion", systemImage: "macwindow")
        }

        Button {
            Task { await store.refreshStatus() }
        } label: {
            Label("Check Status", systemImage: "arrow.clockwise")
        }

        Button {
            store.copyPairingPayload()
        } label: {
            Label("Copy Phone Setup", systemImage: "doc.on.doc")
        }
        .disabled(store.pairingJSON.isEmpty)

        Button {
            Task { await store.checkForUpdates() }
        } label: {
            Label(store.isCheckingForUpdates ? "Checking Updates" : "Check Updates", systemImage: "arrow.down.circle")
        }
        .disabled(store.isCheckingForUpdates)

        if store.updateAvailable {
            Button {
                Task { await store.downloadLatestDMG() }
            } label: {
                Label("Install \(store.latestReleaseTag.isEmpty ? "Update" : store.latestReleaseTag)", systemImage: "arrow.down.circle.fill")
            }
            .disabled(store.isDownloadingUpdate)
        } else {
            Label(updateModeLabel, systemImage: updateModeSymbol)
        }

        if store.automaticUpdateChecksEnabled {
            Label("Checks: \(store.automaticUpdateCheckInterval.shortLabel)", systemImage: "clock.arrow.circlepath")
        }

        Label(store.launchAtStartupEnabled ? "Launches at login" : "Does not launch at login", systemImage: store.launchAtStartupEnabled ? "power.circle.fill" : "power.circle")

        Divider()

        Label(store.status.title, systemImage: statusSymbol)

        Divider()

        Button("Quit VoiceClaw Companion") {
            NSApp.terminate(nil)
        }
    }

    private var statusSymbol: String {
        switch store.status {
        case .ready:
            "checkmark.circle.fill"
        case .working:
            "hourglass"
        case .failed:
            "xmark.octagon.fill"
        case .warning:
            "exclamationmark.triangle.fill"
        case .idle:
            "circle"
        }
    }

    private var updateModeLabel: String {
        if !store.automaticUpdateChecksEnabled {
            return "Updates are manual only"
        }
        if !store.automaticUpdateInstallsEnabled {
            return "Updates check automatically; install manually"
        }
        return "Updates install automatically"
    }

    private var updateModeSymbol: String {
        if store.automaticUpdateChecksEnabled, store.automaticUpdateInstallsEnabled {
            return "checkmark.seal"
        }
        return "exclamationmark.triangle"
    }

    private func openMainWindow() {
        NSApp.setActivationPolicy(.regular)
        openWindow(id: "main")
        NSApp.activate(ignoringOtherApps: true)
    }
}
