import Foundation

/// Reconnect evidence only. Never stores input, credentials, or executable grants.
public struct NativeApprovalAttempt: Codable, Sendable {
    public let identity: NativeApprovalIdentity
    public let origin: String
    public let deliveredID: String
    public var code: String
    private var terminal: Bool?
    public var isTerminal: Bool { terminal == true || code == "approval_confirmed" }
    public init(identity: NativeApprovalIdentity, origin: String, deliveredID: String, code: String) {
        self.identity = identity; self.origin = origin; self.deliveredID = deliveredID; self.code = code
    }
    public mutating func markConfirmed() { code = "approval_confirmed"; terminal = true }
    @discardableResult public mutating func apply(_ receipt: NativeApprovalReceipt) -> Bool {
        guard identity.matches(receipt) else { return false }
        code = receipt.outcomeCode
        terminal = receipt.status == "rejected" || receipt.confirmsDecision ||
            (receipt.status == "settled" && ["denied", "expired"].contains(receipt.resolution ?? ""))
        return true
    }
}

/// New activity cannot erase an uncertain outcome's original recovery identity.
public func retainingNativeApprovalAttempt(_ attempt: NativeApprovalAttempt, in stored: [NativeApprovalAttempt]) -> [NativeApprovalAttempt] {
    var updated = stored.filter { $0.identity.requestId != attempt.identity.requestId }
    updated.append(attempt)
    return updated.filter { !$0.isTerminal } + updated.filter(\.isTerminal).suffix(50)
}
