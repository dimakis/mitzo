import Foundation
import Testing
@testable import MitzoShared

private func approval(operation: String = "search", scope: String = "session", resolved: Bool = false) throws -> MitzoNotification {
    let input = try JSONSerialization.data(withJSONObject: ["operation": operation])
    let object: [String: Any] = ["id": "permission:p1", "kind": "approval", "title": "Search?", "body": "Session",
        "sessionId": "s1", "createdAt": 1, "expiresAt": 1000, "resolvedAt": resolved ? 1 : NSNull(),
        "request": ["permId": "p1", "toolName": "RequestWebAccess", "toolInput": String(data: input, encoding: .utf8)!, "approvalScope": scope]]
    return try JSONDecoder().decode(MitzoNotification.self, from: JSONSerialization.data(withJSONObject: object))
}

@Test func backgroundSearchApprovalSupportsOnceSessionAndDenial() throws {
    let item = try approval()
    for (action, decision) in [("ALLOW_ONCE_ACTION", "once"), ("ALLOW_SEARCH_SESSION_ACTION", "always"), ("DENY_PERMISSION_ACTION", "deny")] {
        let response = backgroundApprovalResponse(actionID: action, item: item, expectedSessionID: "s1", at: 999)
        #expect(response?.decision.rawValue == decision)
        #expect(response?.sessionId == "s1")
    }
}
@Test func backgroundApprovalRejectsExpiredResolvedAndCrossSessionRequests() throws {
    #expect(backgroundApprovalResponse(actionID: "ALLOW_ONCE_ACTION", item: try approval(), expectedSessionID: "s1", at: 1000) == nil)
    #expect(backgroundApprovalResponse(actionID: "ALLOW_ONCE_ACTION", item: try approval(resolved: true), expectedSessionID: "s1", at: 999) == nil)
    #expect(backgroundApprovalResponse(actionID: "ALLOW_ONCE_ACTION", item: try approval(), expectedSessionID: "other", at: 999) == nil)
    #expect(backgroundApprovalResponse(actionID: "REVIEW_PERMISSION_ACTION", item: try approval(), expectedSessionID: "s1", at: 999) == nil)
}
@Test func backgroundSessionGrantCannotAuthorizeWebsiteReadsOrConversationAccess() throws {
    #expect(backgroundApprovalResponse(actionID: "ALLOW_SEARCH_SESSION_ACTION", item: try approval(operation: "fetch", scope: "request"), expectedSessionID: "s1", at: 999) == nil)
    #expect(backgroundApprovalResponse(actionID: "ALLOW_SEARCH_SESSION_ACTION", item: try approval(scope: "conversation"), expectedSessionID: "s1", at: 999) == nil)
    #expect(backgroundApprovalResponse(actionID: "ALLOW_ONCE_ACTION", item: try approval(scope: "conversation"), expectedSessionID: "s1", at: 999) == nil)
}
