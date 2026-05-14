import SwiftUI

@main
struct VoiceClawBridgeApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var store = BridgeStore()

    var body: some Scene {
        WindowGroup("VoiceClaw Bridge") {
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
            }
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
    }
}
