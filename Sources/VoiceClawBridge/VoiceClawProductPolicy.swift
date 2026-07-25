import Foundation

enum VoiceClawBranding {
    static let productName = "VoiceClaw Realtime"
    static let companionDisplayName = "VoiceClaw Realtime Companion"
}

enum VoiceClawProductSurfacePolicy {
    // The implementation and downloaded assets remain preserved for a future
    // release, but dormant functionality must neither appear nor block setup.
    static let companionRealtimeVoiceVisible = false
    static let powerhouseVisible = false
    static let companionRealtimeVoiceBlocksReadiness = false
    static let powerhouseBlocksReadiness = false

    static var requiresCompanionVoiceReadiness: Bool {
        companionRealtimeVoiceVisible && companionRealtimeVoiceBlocksReadiness
    }
}

enum VoiceClawSetupContract {
    static let schemaVersion = 3
    static let minimumReaderVersion = 2
    static let capabilities: [String: Int] = [
        "routeTasks": 1,
        "taskInputAttachments": 1,
        "artifactInbox": 1,
        "taskEvents": 1,
        "codexThreads": 1,
        "hermesGateway": 1,
    ]
    static let limits: [String: Int] = [
        "artifactFileBytes": 52_428_800,
        "artifactInboxBytes": 524_288_000,
        "inputAttachmentFileBytes": 52_428_800,
        "inputAttachmentStoreBytes": 524_288_000,
        "inputAttachmentsPerTask": 20,
        "inputAttachmentOrphanRetentionSeconds": 86_400,
    ]

    private static let openAIAPIKeyFields = [
        "OpenAIAPIKey", "openAIAPIKey", "openAIApiKey", "openaiAPIKey", "openaiApiKey", "apiKey",
    ]
    private static let cerebrasAPIKeyFields = [
        "CerebrasAPIKey", "cerebrasAPIKey", "cerebrasApiKey",
    ]
    private static let bridgeCredentialFields = [
        "OpenClawGatewayToken", "OpenClawGatewayPassword", "gatewayToken", "gatewayPassword",
    ]
    private static let chatGPTOAuthFields = [
        "ChatGPTOAuthAccessToken", "ChatGPTOAuthRefreshToken", "ChatGPTOAuthExpiresAt", "ChatGPTOAuthAccountID",
        "openAIChatGPTOAuthAccessToken", "openAIChatGPTOAuthRefreshToken", "openAIChatGPTOAuthExpiresAt", "openAIChatGPTOAuthAccountID",
        "openAIOAuthAccessToken", "openAIOAuthRefreshToken", "openAIOAuthExpiresAt", "openAIOAuthAccountID",
    ]

    private static func dictionary(_ value: Any?) -> [String: Any] {
        value as? [String: Any] ?? [:]
    }

    private static func anyDictionary(_ value: [String: Int]) -> [String: Any] {
        value.reduce(into: [:]) { result, entry in result[entry.key] = entry.value }
    }

    static func decorating(_ payload: [String: Any]) -> [String: Any] {
        var result = payload
        result["VoiceClawSetupVersion"] = schemaVersion
        result["setupSchemaVersion"] = schemaVersion
        result["minimumReaderVersion"] = minimumReaderVersion
        result["capabilities"] = dictionary(payload["capabilities"]).merging(anyDictionary(capabilities)) { _, current in current }
        result["limits"] = dictionary(payload["limits"]).merging(anyDictionary(limits)) { _, current in current }
        let currentProductSurfaces: [String: Any] = [
            "companionRealtimeVoiceVisible": VoiceClawProductSurfacePolicy.companionRealtimeVoiceVisible,
            "powerhouseVisible": VoiceClawProductSurfacePolicy.powerhouseVisible,
            "companionRealtimeVoiceBlocksReadiness": VoiceClawProductSurfacePolicy.companionRealtimeVoiceBlocksReadiness,
            "powerhouseBlocksReadiness": VoiceClawProductSurfacePolicy.powerhouseBlocksReadiness,
        ]
        result["productSurfaces"] = dictionary(payload["productSurfaces"]).merging(currentProductSurfaces) { _, current in current }
        return result
    }

    static func applyingPairingSecretPolicy(
        _ payload: [String: Any],
        includeOpenAIAPIKey: Bool,
        localOpenAIAPIKey: String,
        includeCerebrasAPIKey: Bool,
        localCerebrasAPIKey: String,
        includeBridgeCredentials: Bool,
        includeChatGPTOAuth: Bool
    ) -> [String: Any] {
        var result = decorating(payload)

        func remove(_ fields: [String]) {
            for field in fields { result.removeValue(forKey: field) }
        }

        if includeOpenAIAPIKey {
            let local = localOpenAIAPIKey.trimmingCharacters(in: .whitespacesAndNewlines)
            if !local.isEmpty { result["OpenAIAPIKey"] = local }
        } else {
            remove(openAIAPIKeyFields)
        }

        if includeCerebrasAPIKey {
            let local = localCerebrasAPIKey.trimmingCharacters(in: .whitespacesAndNewlines)
            if !local.isEmpty { result["CerebrasAPIKey"] = local }
        } else {
            remove(cerebrasAPIKeyFields)
        }

        if !includeBridgeCredentials { remove(bridgeCredentialFields) }
        if !includeChatGPTOAuth { remove(chatGPTOAuthFields) }
        return result
    }
}
