import Foundation

/// Stored reconnect identity excludes request inputs and never authorizes a retry.
public struct NativeApprovalIdentity: Codable, Sendable {
    public let requestId: String
    public let notificationId: String
    public let sessionId: String
    public let actionID: String
    public func matches(_ receipt: NativeApprovalReceipt) -> Bool {
        requestId == receipt.requestId && notificationId == receipt.notificationId &&
        sessionId == receipt.sessionId && actionID == receipt.nativeAction &&
        receipt.decision == (actionID == "DENY_PERMISSION_ACTION" ? .deny : actionID == "ALLOW_ONCE_ACTION" ? .once : .session)
    }
}

public struct NativeApprovalAction: Sendable {
    public let requestId: String
    public let notificationId: String
    public let sessionId: String
    public let actionID: String
    public let reviewedToolName: String?
    public let reviewedInput: String?
    public let reviewedSessionGrantDescription: String?
    public init(notificationId: String, sessionId: String, actionID: String,
                reviewedToolName: String?, reviewedInput: String?, reviewedSessionGrantDescription: String? = nil) {
        requestId = UUID().uuidString.lowercased()
        self.notificationId = notificationId; self.sessionId = sessionId; self.actionID = actionID
        self.reviewedToolName = reviewedToolName; self.reviewedInput = reviewedInput
        self.reviewedSessionGrantDescription = reviewedSessionGrantDescription
    }
    public var identity: NativeApprovalIdentity {
        NativeApprovalIdentity(requestId: requestId, notificationId: notificationId, sessionId: sessionId, actionID: actionID)
    }
}

public struct NativeApprovalReceipt: Codable, Sendable {
    public let requestId: String
    public let notificationId: String
    public let sessionId: String
    public let nativeAction: String
    public let decision: NotificationResponse.Decision
    public let status: String
    public let resolution: String?
    public var confirmsDecision: Bool {
        status == "settled" && resolution == (decision == .deny ? "denied" : "allowed")
    }
}

public struct BackgroundApprovalFailure: Error {
    public let code: String
    public let cause: (any Error)?
    public let recoveryCause: (any Error)?
    public init(code: String, cause: (any Error)? = nil, recoveryCause: (any Error)? = nil) {
        self.code = code; self.cause = cause; self.recoveryCause = recoveryCause
    }
}

public func backgroundApprovalErrorCode(_ error: any Error) -> String {
    if let error = error as? BackgroundApprovalFailure { return error.code }
    if error is CancellationError { return "approval_cancelled" }
    if let error = error as? URLError {
        return error.code == .timedOut ? "approval_deadline" : "approval_unreachable"
    }
    return "approval_unconfirmed"
}

public protocol BackgroundApprovalTransport: Sendable {
    func fetchNotification(id: String) async throws -> MitzoNotification
    func submitApproval(_ action: NativeApprovalAction, response: NotificationResponse) async throws -> NativeApprovalReceipt
    func approvalReceipt(_ identity: NativeApprovalIdentity) async throws -> NativeApprovalReceipt
}

/// The native action owns submission. Recovery only reads its exact receipt.
public func submitBackgroundApproval(_ action: NativeApprovalAction, using api: any BackgroundApprovalTransport) async throws -> NativeApprovalReceipt {
    let item = try await api.fetchNotification(id: action.notificationId)
    try Task.checkCancellation()
    guard item.id == action.notificationId,
          let response = backgroundApprovalResponse(actionID: action.actionID, item: item, expectedSessionID: action.sessionId,
            reviewedToolName: action.reviewedToolName, reviewedInput: action.reviewedInput,
            reviewedSessionGrantDescription: action.reviewedSessionGrantDescription) else {
        throw BackgroundApprovalFailure(code: "approval_scope_changed")
    }
    let receipt: NativeApprovalReceipt
    do {
        try Task.checkCancellation()
        receipt = try await api.submitApproval(action, response: response)
    } catch {
        let original = error
        try Task.checkCancellation()
        // A lost HTTP reply can follow a successful settlement. Never POST again.
        do { receipt = try await api.approvalReceipt(action.identity) }
        catch { throw BackgroundApprovalFailure(code: "approval_unconfirmed", cause: original, recoveryCause: error) }
    }
    try Task.checkCancellation()
    guard action.identity.matches(receipt), receipt.confirmsDecision else {
        throw BackgroundApprovalFailure(code: receipt.status == "rejected" || receipt.resolution == "denied"
            ? "approval_rejected" : receipt.resolution == "expired" ? "approval_expired" : "approval_unconfirmed")
    }
    return receipt
}
