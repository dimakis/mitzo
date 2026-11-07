import Foundation

/// WatchConnectivity accepts property lists, whose dictionaries cannot contain
/// JSON nulls. Keep complete source packets as encoded Data at that boundary.
public enum WatchSourceRelayJSON {
    public static func payload(data: Data) throws -> [String: Data] {
        guard data.count < 55000 else { throw WatchSourceRelayError.tooLarge }
        return ["_json": data]
    }
    public static func decode<T: Decodable>(_ payload: [String: Any], as type: T.Type) throws -> T {
        guard let data = payload["_json"] as? Data, data.count < 55000 else { throw WatchSourceRelayError.invalidPayload }
        return try JSONDecoder().decode(type, from: data)
    }
}
public enum WatchSourceRelayError: LocalizedError {
    case tooLarge, invalidPayload
    public var errorDescription: String? {
        switch self {
        case .tooLarge: "This source page is too large for the Watch relay."
        case .invalidPayload: "The source page could not be decoded. Refresh before responding."
        }
    }
}

/// Preserve the host's complete proposal/preview without manufacturing source bytes.
public indirect enum ReviewValue: Codable, Sendable, Equatable {
    case object([String: ReviewValue]), array([ReviewValue]), string(String), number(Double), bool(Bool), null
    public init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        if value.decodeNil() { self = .null }
        else if let item = try? value.decode(Bool.self) { self = .bool(item) }
        else if let item = try? value.decode(String.self) { self = .string(item) }
        else if let item = try? value.decode(Double.self) { self = .number(item) }
        else if let item = try? value.decode([ReviewValue].self) { self = .array(item) }
        else { self = .object(try value.decode([String: ReviewValue].self)) }
    }
    public func encode(to encoder: Encoder) throws {
        var value = encoder.singleValueContainer()
        switch self {
        case .object(let item): try value.encode(item)
        case .array(let item): try value.encode(item)
        case .string(let item): try value.encode(item)
        case .number(let item): try value.encode(item)
        case .bool(let item): try value.encode(item)
        case .null: try value.encodeNil()
        }
    }
    public var readable: String {
        switch self {
        case .string(let item): item
        case .number(let item): String(item)
        case .bool(let item): item ? "Yes" : "No"
        case .null: "—"
        case .array(let items): items.map(\.readable).joined(separator: "\n\n")
        case .object(let items): items.keys.sorted().map { "\($0): \(items[$0]!.readable)" }.joined(separator: "\n\n")
        }
    }
}

public struct WatchSourceReview: Codable, Sendable {
    public let permId: String
    public let sessionId: String
    public let toolUseId: String?
    public let proposalSha256: String
    public let materialScopeSha256: String?
    public let expiresAt: Double
    public let operation: ReviewValue
    public private(set) var messages: [Message]
    public private(set) var artifacts: [Artifact]
    public let cursor: Int?
    public let hasMore: Bool
    public private(set) var earlierCursor: Int?
    public private(set) var artifactCursor: ReviewValue?
    public private(set) var artifactsHasMore: Bool?
    public let recovery: Recovery?

    public struct Message: Codable, Sendable, Identifiable, Equatable {
        public let messageId: String
        public var id: String { messageId }
        public let sequence: Int
        public let author: ReviewValue
        public let blocks: [Block]
        public let unavailableReason: String?
        public struct Block: Codable, Sendable, Equatable { public let content: String }
    }
    public struct Artifact: Codable, Sendable, Identifiable, Equatable {
        public let artifactId: String
        public var id: String { "\(artifactId):\(revision)" }
        public let revision: Int
        public let sha256: String
        public let title: String
        public let filename: String
    }
    public struct Recovery: Codable, Sendable {
        public let requestId: String
        public let proposalSha256: String
        public let selection: WatchSourceSelection
        public let previewSha256: String
        public let preview: WatchSourcePreview.Packet
        public let receipt: ReviewValue?
    }
    public func selection(messageIDs: Set<String>, artifactIDs: Set<String>) throws -> WatchSourceInput {
        let chosen = messages.filter { messageIDs.contains($0.id) }
        let files = artifacts.filter { artifactIDs.contains($0.id) }
        guard let last = chosen.max(by: { $0.sequence < $1.sequence }),
              chosen.count == messageIDs.count, chosen.allSatisfy({ $0.unavailableReason == nil }),
              files.count == artifactIDs.count, chosen.count <= 500, files.count <= 100 else { throw MitzoAPIClient.APIError.invalidResponse }
        return WatchSourceInput(sessionId: sessionId, requestId: UUID().uuidString.lowercased(),
            proposalSha256: proposalSha256, materialScopeSha256: materialScopeSha256,
            selection: WatchSourceSelection(boundary: .init(sequence: last.sequence, messageId: last.messageId),
                mode: "selected", messageIds: chosen.map(\.id), artifacts: files.map { .init(artifactId: $0.artifactId, revision: $0.revision, sha256: $0.sha256) }), previewSha256: nil)
    }
    /// A later read may not replace bytes already reviewed or selected.
    private func union<T: Identifiable & Equatable>(_ existing: [T], _ page: [T]) throws -> [T] where T.ID: Hashable {
        var byID: [T.ID: T] = [:]
        var result: [T] = []
        for value in existing + page {
            if let previous = byID[value.id] {
                guard previous == value else { throw MitzoAPIClient.APIError.invalidResponse }
            } else { byID[value.id] = value; result.append(value) }
        }
        return result
    }
    public func mergingEarlier(_ page: WatchSourceReview) throws -> WatchSourceReview {
        try mergingMessages(page, earlier: true)
    }
    public func mergingLatest(_ page: WatchSourceReview) throws -> WatchSourceReview {
        try mergingMessages(page, earlier: false)
    }
    private func mergingMessages(_ page: WatchSourceReview, earlier: Bool) throws -> WatchSourceReview {
        guard permId == page.permId, sessionId == page.sessionId, toolUseId == page.toolUseId,
              proposalSha256 == page.proposalSha256, materialScopeSha256 == page.materialScopeSha256,
              expiresAt == page.expiresAt, operation == page.operation, recovery == nil, page.recovery == nil,
              !earlier || page.earlierCursor == nil || (earlierCursor != nil && page.earlierCursor! < earlierCursor!) else {
            throw MitzoAPIClient.APIError.invalidResponse
        }
        var result = self
        result.messages = try union(messages, page.messages).sorted { $0.sequence < $1.sequence }
        result.artifacts = try union(artifacts, page.artifacts)
        if earlier { result.earlierCursor = page.earlierCursor }
        return result
    }
    public var nextMaterialsInput: WatchSourceMaterialsInput? {
        guard recovery == nil, artifactsHasMore == true, let after = artifactCursor, let toolUseId else { return nil }
        return .init(sessionId: sessionId, toolUseId: toolUseId, proposalSha256: proposalSha256, after: after)
    }
    public func mergingMaterials(_ page: WatchSourceMaterialsPage, input: WatchSourceMaterialsInput) throws -> WatchSourceReview {
        guard let expected = nextMaterialsInput, expected == input,
              page.permId == permId, page.sessionId == sessionId, page.toolUseId == toolUseId,
              page.proposalSha256 == proposalSha256, page.materialScopeSha256 == materialScopeSha256,
              !page.hasMore || (page.cursor != nil && page.cursor != artifactCursor) else {
            throw MitzoAPIClient.APIError.invalidResponse
        }
        var result = self
        result.artifacts = try union(artifacts, page.artifacts)
        result.artifactCursor = page.cursor
        result.artifactsHasMore = page.hasMore
        return result
    }
    public var restoredApproval: WatchSourceInput? {
        guard let recovery, recovery.proposalSha256 == proposalSha256 else { return nil }
        let originalMaterialScope: String?
        if case .object(let packet) = recovery.preview.packet,
           case .string(let scope) = packet["materialScopeSha256"] { originalMaterialScope = scope }
        else { originalMaterialScope = nil }
        return WatchSourceInput(sessionId: sessionId, requestId: recovery.requestId,
            proposalSha256: proposalSha256, materialScopeSha256: originalMaterialScope,
            selection: recovery.selection, previewSha256: recovery.previewSha256)
    }
}

public struct WatchSourceMaterialsInput: Codable, Sendable, Equatable {
    public let sessionId: String
    public let toolUseId: String
    public let proposalSha256: String
    public let after: ReviewValue
}
public struct WatchSourceMaterialsPage: Codable, Sendable {
    public let permId: String
    public let sessionId: String
    public let toolUseId: String
    public let proposalSha256: String
    public let materialScopeSha256: String?
    public let artifacts: [WatchSourceReview.Artifact]
    public let cursor: ReviewValue?
    public let hasMore: Bool
}

public struct WatchSourceSelection: Codable, Sendable {
    public struct Boundary: Codable, Sendable { public let sequence: Int; public let messageId: String? }
    public struct Artifact: Codable, Sendable { public let artifactId: String; public let revision: Int; public let sha256: String }
    public let boundary: Boundary
    public let mode: String
    public let messageIds: [String]
    public let artifacts: [Artifact]
}
/// The same immutable request is retained when an attempted save is uncertain.
public struct WatchSourceInput: Codable, Sendable {
    public let sessionId: String
    public let requestId: String
    public let proposalSha256: String
    public let materialScopeSha256: String?
    public let selection: WatchSourceSelection
    public var previewSha256: String?
}
public struct WatchSourcePreview: Codable, Sendable {
    public let permId: String
    public let sessionId: String
    public let requestId: String
    public let proposalSha256: String
    public let preview: Packet
    public struct Packet: Codable, Sendable { public let sha256: String; public let packet: ReviewValue }
    public func approval(for review: WatchSourceReview, input: WatchSourceInput) -> WatchSourceInput? {
        guard permId == review.permId, sessionId == review.sessionId, requestId == input.requestId,
              proposalSha256 == review.proposalSha256, proposalSha256 == input.proposalSha256,
              input.sessionId == sessionId else { return nil }
        var approved = input
        approved.previewSha256 = preview.sha256
        return approved
    }
}
public struct WatchSourceReceipt: Codable, Sendable {
    public let permId: String
    public let sessionId: String
    public let sourceSnapshotId: String
}
