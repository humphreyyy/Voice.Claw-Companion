import XCTest
@testable import VoiceClawBridge

final class SetupContractTests: XCTestCase {
    func testDecorationUpgradesLegacyPayloadWithoutDroppingUnknownNestedFields() {
        let decorated = VoiceClawSetupContract.decorating([
            "VoiceClawSetupVersion": 1,
            "FutureTopLevel": "kept",
            "capabilities": ["futureRuntime": 7],
            "limits": ["futureLimitBytes": 123],
            "productSurfaces": ["futureSurfaceVisible": true],
        ])

        XCTAssertEqual(decorated["VoiceClawSetupVersion"] as? Int, 3)
        XCTAssertEqual(decorated["setupSchemaVersion"] as? Int, 3)
        XCTAssertEqual(decorated["FutureTopLevel"] as? String, "kept")
        XCTAssertEqual((decorated["capabilities"] as? [String: Any])?["futureRuntime"] as? Int, 7)
        XCTAssertEqual((decorated["capabilities"] as? [String: Any])?["routeTasks"] as? Int, 1)
        XCTAssertEqual((decorated["limits"] as? [String: Any])?["futureLimitBytes"] as? Int, 123)
        XCTAssertEqual((decorated["productSurfaces"] as? [String: Any])?["futureSurfaceVisible"] as? Bool, true)
    }

    func testIncludedSecretsAndDormantFieldsSurviveRegenerationWithoutLocalOverrides() {
        let result = VoiceClawSetupContract.applyingPairingSecretPolicy(
            [
                "openAIApiKey": "existing-openai",
                "cerebrasApiKey": "existing-cerebras",
                "gatewayPassword": "existing-gateway",
                "openAIOAuthRefreshToken": "existing-refresh",
                "PowerhouseMode": "legacy-mode",
                "FutureNonSecret": ["nested": true],
            ],
            includeOpenAIAPIKey: true,
            localOpenAIAPIKey: "",
            includeCerebrasAPIKey: true,
            localCerebrasAPIKey: "",
            includeBridgeCredentials: true,
            includeChatGPTOAuth: true)

        XCTAssertEqual(result["openAIApiKey"] as? String, "existing-openai")
        XCTAssertEqual(result["cerebrasApiKey"] as? String, "existing-cerebras")
        XCTAssertEqual(result["gatewayPassword"] as? String, "existing-gateway")
        XCTAssertEqual(result["openAIOAuthRefreshToken"] as? String, "existing-refresh")
        XCTAssertEqual(result["PowerhouseMode"] as? String, "legacy-mode")
        XCTAssertEqual((result["FutureNonSecret"] as? [String: Any])?["nested"] as? Bool, true)
    }

    func testExcludedSecretFamiliesRemoveEveryKnownAliasOnly() {
        let result = VoiceClawSetupContract.applyingPairingSecretPolicy(
            [
                "OpenAIAPIKey": "canonical-openai",
                "openaiApiKey": "legacy-openai",
                "CerebrasAPIKey": "canonical-cerebras",
                "gatewayToken": "gateway",
                "ChatGPTOAuthAccessToken": "access",
                "openAIOAuthRefreshToken": "refresh",
                "FutureNonSecret": "kept",
            ],
            includeOpenAIAPIKey: false,
            localOpenAIAPIKey: "unused",
            includeCerebrasAPIKey: false,
            localCerebrasAPIKey: "unused",
            includeBridgeCredentials: false,
            includeChatGPTOAuth: false)

        for key in [
            "OpenAIAPIKey", "openaiApiKey", "CerebrasAPIKey", "gatewayToken",
            "ChatGPTOAuthAccessToken", "openAIOAuthRefreshToken",
        ] {
            XCTAssertNil(result[key], "\(key) should be removed by its explicit toggle")
        }
        XCTAssertEqual(result["FutureNonSecret"] as? String, "kept")
    }
}
