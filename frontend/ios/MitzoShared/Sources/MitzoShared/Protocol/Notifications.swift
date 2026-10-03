import Foundation

/// Shared feed from the authenticated operator API. Reading never grants permission.
public struct MitzoNotification: Codable, Sendable, Identifiable {
    public let id: String
    public let kind: String
    public let title: String
    public let body: String
    public let sessionId: String?
    public let createdAt: Double
    public let expiresAt: Double?
    public let readAt: Double?
    public let resolvedAt: Double?
    public let resolution: String?
    public let request: PermissionRequest?

    public func isActionable(at milliseconds: Double = Date().timeIntervalSince1970 * 1000) -> Bool {
        (kind == "approval" || kind == "question") && resolvedAt == nil && resolution == nil &&
        (expiresAt == nil || expiresAt! > milliseconds)
    }
}

public struct NotificationFeed: Codable, Sendable {
    public let items: [MitzoNotification]
    public let needsYou: Int
    public let total: Int
}

public struct NotificationResponse: Encodable, Sendable {
    public enum Decision: String, Sendable, Codable { case once, deny }
    public let sessionId: String
    public let decision: Decision
    public init(sessionId: String, decision: Decision) {
        self.sessionId = sessionId
        self.decision = decision
    }
}


public struct NotificationQuestion: Codable, Sendable, Identifiable {
    public let id: String
    public let question: String
    public let options: [Option]
    public let multiSelect: Bool?
    public let allowFreeform: Bool?
    public let isSecret: Bool?

    public struct Option: Codable, Sendable {
        public let label: String
        public let description: String?
    }
}
