import Foundation

struct CompanionRouteTask: Decodable, Identifiable, Equatable {
    struct Target: Decodable, Equatable {
        let runtime: String
        let route: String
        let agentID: String
        let model: String?
        let reasoning: String?
    }

    struct Request: Decodable, Equatable {
        let summary: String
        let fullText: String
        let artifactReturnRequested: Bool
        let delivery: String
    }

    struct Progress: Decodable, Equatable {
        let summary: String
        let updatedAt: Double?
    }

    struct Result: Decodable, Equatable {
        let text: String?
        let source: String?
        let artifactWarning: String?
    }

    struct Failure: Decodable, Equatable {
        let code: String?
        let message: String?
    }

    struct Timestamps: Decodable, Equatable {
        let createdAt: Double
        let updatedAt: Double
        let startedAt: Double?
        let completedAt: Double?
    }

    let taskID: String
    let target: Target
    let request: Request
    let state: String
    let stateVersion: Int
    let progress: Progress?
    let result: Result?
    let artifactIDs: [String]
    let error: Failure?
    let timestamps: Timestamps

    var id: String { taskID }

    var isTerminal: Bool {
        ["completed", "completedWithArtifactWarning", "failed", "cancelled"].contains(state)
    }

    var updatedDate: Date {
        Date(timeIntervalSince1970: timestamps.updatedAt / 1_000)
    }
}

struct CompanionArtifact: Decodable, Identifiable, Equatable {
    let artifactID: String
    let taskID: String
    let displayName: String
    let originalName: String
    let byteCount: Int64
    let sha256: String
    let contentType: String
    let admittedAt: Double
    let sourceModifiedAt: Double

    var id: String { artifactID }

    var admittedDate: Date {
        Date(timeIntervalSince1970: admittedAt / 1_000)
    }
}

struct CompanionArtifactInboxStatus: Decodable, Equatable {
    let fileLimitBytes: Int64
    let inboxLimitBytes: Int64
    let filesPerTaskLimit: Int
    let totalBytes: Int64
    let availableBytes: Int64
    let artifactCount: Int
    let rootPath: String

    var utilization: Double {
        guard inboxLimitBytes > 0 else { return 0 }
        return min(1, max(0, Double(totalBytes) / Double(inboxLimitBytes)))
    }
}

struct CompanionRouteTaskListResponse: Decodable {
    let tasks: [CompanionRouteTask]
}

struct CompanionArtifactListResponse: Decodable {
    let artifacts: [CompanionArtifact]
}

struct CompanionArtifactStatusResponse: Decodable {
    let fileLimitBytes: Int64
    let inboxLimitBytes: Int64
    let filesPerTaskLimit: Int
    let totalBytes: Int64
    let availableBytes: Int64
    let artifactCount: Int
    let rootPath: String

    var status: CompanionArtifactInboxStatus {
        CompanionArtifactInboxStatus(
            fileLimitBytes: fileLimitBytes,
            inboxLimitBytes: inboxLimitBytes,
            filesPerTaskLimit: filesPerTaskLimit,
            totalBytes: totalBytes,
            availableBytes: availableBytes,
            artifactCount: artifactCount,
            rootPath: rootPath
        )
    }
}

struct CompanionArtifactEmptyConfirmationResponse: Decodable {
    let confirmationToken: String
    let expiresAt: Double
}
