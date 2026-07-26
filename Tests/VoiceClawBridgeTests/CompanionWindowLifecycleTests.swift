import AppKit
import XCTest
@testable import VoiceClawBridge

@MainActor
final class CompanionWindowLifecycleTests: XCTestCase {
    func testKeyWindowActivationRequestsUpdateCheckForCompanionWindow() {
        let center = NotificationCenter()
        let monitor = CompanionWindowLifecycleMonitor(notificationCenter: center)
        monitor.start()

        let expectation = expectation(description: "Companion window requests update check")
        let token = center.addObserver(
            forName: .voiceClawCompanionMainWindowActivated,
            object: nil,
            queue: .main
        ) { _ in
            expectation.fulfill()
        }
        defer { center.removeObserver(token) }

        let window = NSWindow()
        window.title = VoiceClawBranding.companionDisplayName
        center.post(name: NSWindow.didBecomeKeyNotification, object: window)

        wait(for: [expectation], timeout: 1)
    }

    func testDeminiaturizingCompanionWindowRequestsUpdateCheck() {
        let center = NotificationCenter()
        let monitor = CompanionWindowLifecycleMonitor(notificationCenter: center)
        monitor.start()

        let expectation = expectation(description: "Restored window requests update check")
        let token = center.addObserver(
            forName: .voiceClawCompanionMainWindowActivated,
            object: nil,
            queue: .main
        ) { _ in
            expectation.fulfill()
        }
        defer { center.removeObserver(token) }

        let window = NSWindow()
        window.title = VoiceClawBranding.companionDisplayName
        center.post(name: NSWindow.didDeminiaturizeNotification, object: window)

        wait(for: [expectation], timeout: 1)
    }

    func testOtherWindowsDoNotRequestUpdateCheck() {
        let center = NotificationCenter()
        let monitor = CompanionWindowLifecycleMonitor(notificationCenter: center)
        monitor.start()

        let expectation = expectation(description: "Unrelated window does not request update check")
        expectation.isInverted = true
        let token = center.addObserver(
            forName: .voiceClawCompanionMainWindowActivated,
            object: nil,
            queue: .main
        ) { _ in
            expectation.fulfill()
        }
        defer { center.removeObserver(token) }

        let window = NSWindow()
        window.title = "Unrelated Window"
        center.post(name: NSWindow.didBecomeKeyNotification, object: window)

        wait(for: [expectation], timeout: 0.1)
    }

    func testExplicitReopenRequestsUpdateCheck() {
        let center = NotificationCenter()
        let monitor = CompanionWindowLifecycleMonitor(notificationCenter: center)

        let expectation = expectation(description: "Explicit reopen requests update check")
        let token = center.addObserver(
            forName: .voiceClawCompanionMainWindowActivated,
            object: nil,
            queue: .main
        ) { _ in
            expectation.fulfill()
        }
        defer { center.removeObserver(token) }

        monitor.requestUpdateCheck()

        wait(for: [expectation], timeout: 1)
    }
}
