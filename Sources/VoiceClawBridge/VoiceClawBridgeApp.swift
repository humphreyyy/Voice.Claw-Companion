import SwiftUI

@main
struct VoiceClawBridgeApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var store = BridgeStore()

    var body: some Scene {
        WindowGroup("VoiceClaw Bridge", id: "main") {
            ContentView(store: store)
                .frame(minWidth: 920, minHeight: 660)
        }
        .commands {
            CommandMenu("Bridge") {
                Button("Refresh Status") {
                    Task { await store.refreshStatus() }
                }
                .keyboardShortcut("r", modifiers: [.command])

                Button("Copy iPhone Setup") {
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

        MenuBarExtra("Voice.Claw", systemImage: "waveform.circle.fill") {
            CompanionMenuBarView(store: store)
        }
        .menuBarExtraStyle(.menu)
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
        Button {
            openMainWindow()
        } label: {
            Label("Show Voice.Claw", systemImage: "macwindow")
        }

        Button {
            Task { await store.refreshStatus() }
        } label: {
            Label("Check Status", systemImage: "arrow.clockwise")
        }

        Button {
            store.copyPairingPayload()
        } label: {
            Label("Copy iPhone Setup", systemImage: "doc.on.doc")
        }
        .disabled(store.pairingJSON.isEmpty)

        Button {
            Task { await store.checkForUpdates() }
        } label: {
            Label("Check for Updates", systemImage: "arrow.down.circle")
        }

        if store.updateAvailable {
            Button {
                store.openLatestDMG()
            } label: {
                Label("Download \(store.latestReleaseTag.isEmpty ? "Update" : store.latestReleaseTag) DMG", systemImage: "arrow.down.circle.fill")
            }
        } else {
            Label("Updates \(store.automaticUpdateChecksEnabled ? "check automatically" : "manual only")", systemImage: "checkmark.seal")
        }

        Divider()

        Label(store.status.title, systemImage: statusSymbol)

        Divider()

        Button("Quit Voice.Claw") {
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

    private func openMainWindow() {
        NSApp.setActivationPolicy(.regular)
        openWindow(id: "main")
        NSApp.activate(ignoringOtherApps: true)
    }
}
