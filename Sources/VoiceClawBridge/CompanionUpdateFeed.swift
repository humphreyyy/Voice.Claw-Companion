import AppKit
import Foundation
import Sparkle

struct CompanionAppcastItem: Equatable {
    let shortVersion: String
    let build: String
    let enclosureURL: URL
}

enum CompanionUpdateFeed {
    static let appcastURL = URL(
        string: "https://github.com/bdjben/Voice.Claw-Companion/releases/latest/download/appcast.xml"
    )!

    static func cacheBustedAppcastURL(
        now: Date = Date(),
        nonce: UUID = UUID()
    ) -> URL {
        var components = URLComponents(url: appcastURL, resolvingAgainstBaseURL: false)!
        let timestamp = Int(now.timeIntervalSince1970 * 1_000)
        components.queryItems = [
            URLQueryItem(
                name: "voiceclaw_update_check",
                value: "\(timestamp)-\(nonce.uuidString.lowercased())"
            ),
        ]
        return components.url!
    }

    static func request(now: Date = Date(), nonce: UUID = UUID()) -> URLRequest {
        var request = URLRequest(url: cacheBustedAppcastURL(now: now, nonce: nonce))
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        request.timeoutInterval = 20
        request.setValue("application/rss+xml, application/xml;q=0.9, */*;q=0.1", forHTTPHeaderField: "Accept")
        request.setValue("no-cache, no-store, max-age=0", forHTTPHeaderField: "Cache-Control")
        request.setValue("no-cache", forHTTPHeaderField: "Pragma")
        request.setValue("VoiceClawCompanion", forHTTPHeaderField: "User-Agent")
        return request
    }

    static func latestItem(from data: Data) throws -> CompanionAppcastItem {
        let delegate = CompanionAppcastParser()
        let parser = XMLParser(data: data)
        parser.delegate = delegate

        guard parser.parse() else {
            throw CompanionUpdateFeedError.invalidXML(
                parser.parserError?.localizedDescription ?? "The appcast could not be parsed."
            )
        }
        guard let item = delegate.latestItem else {
            throw CompanionUpdateFeedError.missingLatestItem
        }
        return item
    }

    static func confirms(
        releaseVersion: String,
        releaseDMGURL: URL,
        appcastItem: CompanionAppcastItem
    ) -> Bool {
        normalizedVersion(releaseVersion) == normalizedVersion(appcastItem.shortVersion)
            && Int(appcastItem.build) != nil
            && releaseDMGURL.absoluteString == appcastItem.enclosureURL.absoluteString
    }

    private static func normalizedVersion(_ value: String) -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.hasPrefix("v") ? String(trimmed.dropFirst()) : trimmed
    }
}

@MainActor
final class CompanionSparkleUpdaterDelegate: NSObject, SPUUpdaterDelegate {
    func feedURLString(for updater: SPUUpdater) -> String? {
        CompanionUpdateFeed.cacheBustedAppcastURL().absoluteString
    }

    func updaterWillShowModalAlert(_ updater: SPUUpdater) {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
    }
}

private enum CompanionUpdateFeedError: LocalizedError {
    case invalidXML(String)
    case missingLatestItem

    var errorDescription: String? {
        switch self {
        case let .invalidXML(detail):
            "The signed updater feed is invalid: \(detail)"
        case .missingLatestItem:
            "The signed updater feed does not contain a release."
        }
    }
}

private final class CompanionAppcastParser: NSObject, XMLParserDelegate {
    private var isReadingLatestItem = false
    private var didReadLatestItem = false
    private var currentElement = ""
    private var currentText = ""
    private var title = ""
    private var shortVersion = ""
    private var build = ""
    private var enclosureURL: URL?

    private(set) var latestItem: CompanionAppcastItem?

    func parser(
        _ parser: XMLParser,
        didStartElement elementName: String,
        namespaceURI: String?,
        qualifiedName qName: String?,
        attributes attributeDict: [String: String] = [:]
    ) {
        let name = localName(elementName)
        if name == "item" {
            guard !didReadLatestItem else { return }
            isReadingLatestItem = true
            return
        }

        guard isReadingLatestItem else { return }
        if name == "enclosure", let rawURL = attributeDict["url"] {
            enclosureURL = URL(string: rawURL)
            return
        }
        if name == "title" || name == "shortVersionString" || name == "version" {
            currentElement = name
            currentText = ""
        }
    }

    func parser(_ parser: XMLParser, foundCharacters string: String) {
        guard isReadingLatestItem, !currentElement.isEmpty else { return }
        currentText += string
    }

    func parser(
        _ parser: XMLParser,
        didEndElement elementName: String,
        namespaceURI: String?,
        qualifiedName qName: String?
    ) {
        let name = localName(elementName)
        guard isReadingLatestItem else { return }

        if name == currentElement {
            let value = currentText.trimmingCharacters(in: .whitespacesAndNewlines)
            switch name {
            case "title":
                title = value
            case "shortVersionString":
                shortVersion = value
            case "version":
                build = value
            default:
                break
            }
            currentElement = ""
            currentText = ""
        }

        if name == "item" {
            let resolvedVersion = shortVersion.isEmpty ? title : shortVersion
            if !resolvedVersion.isEmpty, !build.isEmpty, let enclosureURL {
                latestItem = CompanionAppcastItem(
                    shortVersion: resolvedVersion,
                    build: build,
                    enclosureURL: enclosureURL
                )
            }
            isReadingLatestItem = false
            didReadLatestItem = true
        }
    }

    private func localName(_ value: String) -> String {
        value.split(separator: ":").last.map(String.init) ?? value
    }
}
