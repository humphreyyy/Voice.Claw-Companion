import Foundation
import XCTest
@testable import VoiceClawBridge

final class CompanionUpdateFeedTests: XCTestCase {
    func testCacheBustedRequestAvoidsStoredAndRemoteCaches() {
        let date = Date(timeIntervalSince1970: 1_700_000_000)
        let nonce = UUID(uuidString: "11111111-2222-3333-4444-555555555555")!

        let request = CompanionUpdateFeed.request(now: date, nonce: nonce)

        XCTAssertEqual(request.cachePolicy, .reloadIgnoringLocalAndRemoteCacheData)
        XCTAssertEqual(request.url?.host, "github.com")
        XCTAssertEqual(
            request.url?.path,
            "/bdjben/Voice.Claw-Companion/releases/latest/download/appcast.xml"
        )
        XCTAssertEqual(request.value(forHTTPHeaderField: "Pragma"), "no-cache")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Cache-Control"), "no-cache, no-store, max-age=0")
        XCTAssertEqual(
            URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?
                .queryItems?
                .first(where: { $0.name == "voiceclaw_update_check" })?
                .value,
            "1700000000000-11111111-2222-3333-4444-555555555555"
        )
    }

    func testLatestItemParsesVersionBuildAndEnclosure() throws {
        let data = Data(
            """
            <?xml version="1.0"?>
            <rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
              <channel>
                <item>
                  <title>0.1.149</title>
                  <sparkle:version>202607301000</sparkle:version>
                  <sparkle:shortVersionString>0.1.149</sparkle:shortVersionString>
                  <enclosure url="https://example.com/VoiceClawCompanion-0.1.149.dmg" />
                </item>
                <item>
                  <title>0.1.148</title>
                  <sparkle:version>202607300926</sparkle:version>
                  <sparkle:shortVersionString>0.1.148</sparkle:shortVersionString>
                  <enclosure url="https://example.com/VoiceClawCompanion-0.1.148.dmg" />
                </item>
              </channel>
            </rss>
            """.utf8
        )

        let item = try CompanionUpdateFeed.latestItem(from: data)

        XCTAssertEqual(item.shortVersion, "0.1.149")
        XCTAssertEqual(item.build, "202607301000")
        XCTAssertEqual(
            item.enclosureURL.absoluteString,
            "https://example.com/VoiceClawCompanion-0.1.149.dmg"
        )
    }

    func testReleaseConfirmationRejectsStaleOrDifferentAppcast() {
        let releaseURL = URL(string: "https://example.com/VoiceClawCompanion-0.1.149.dmg")!
        let matching = CompanionAppcastItem(
            shortVersion: "0.1.149",
            build: "202607301000",
            enclosureURL: releaseURL
        )
        let stale = CompanionAppcastItem(
            shortVersion: "0.1.148",
            build: "202607300926",
            enclosureURL: URL(string: "https://example.com/VoiceClawCompanion-0.1.148.dmg")!
        )
        let wrongAsset = CompanionAppcastItem(
            shortVersion: "0.1.149",
            build: "202607301000",
            enclosureURL: URL(string: "https://example.com/other.dmg")!
        )

        XCTAssertTrue(
            CompanionUpdateFeed.confirms(
                releaseVersion: "v0.1.149",
                releaseDMGURL: releaseURL,
                appcastItem: matching
            )
        )
        XCTAssertFalse(
            CompanionUpdateFeed.confirms(
                releaseVersion: "0.1.149",
                releaseDMGURL: releaseURL,
                appcastItem: stale
            )
        )
        XCTAssertFalse(
            CompanionUpdateFeed.confirms(
                releaseVersion: "0.1.149",
                releaseDMGURL: releaseURL,
                appcastItem: wrongAsset
            )
        )
    }
}
