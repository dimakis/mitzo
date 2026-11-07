import Foundation
import Testing
@testable import MitzoShared

private func notification(tool: String, scope: String = "request", retain: Bool = false) throws -> MitzoNotification {
    let object: [String: Any] = ["id": "permission:all", "kind": "approval", "title": "Approve?", "body": "Watch", "sessionId": "s1", "createdAt": 1,
        "request": ["permId": "all", "toolName": tool, "toolInput": "{\"target\":\"/workspace\"}", "approvalScope": scope, "allowSessionGrant": retain]]
    return try JSONDecoder().decode(MitzoNotification.self, from: JSONSerialization.data(withJSONObject: object))
}

@Test func allToolTypesCanBeApprovedFromTheBannerWithoutRetainingAccess() throws {
    for tool in ["NativeCommandApproval", "NativeFileApproval", "NativePermissionsApproval", "TaskExecution", "ConnectionRequest", "GitHubRead", "GoogleWorkspaceRead", "RequestGithubPublish", "CustomGrant"] {
        let item = try notification(tool: tool)
        #expect(backgroundApprovalResponse(actionID: "ALLOW_ONCE_ACTION", item: item, expectedSessionID: "s1", reviewedToolName: tool, reviewedInput: item.request?.toolInput)?.decision == .once)
        #expect(backgroundApprovalResponse(actionID: "ALLOW_SESSION_ACTION", item: item, expectedSessionID: "s1", reviewedToolName: tool, reviewedInput: item.request?.toolInput) == nil)
    }
}

@Test func conversationAccessRequiresTheExplicitConversationAction() throws {
    let item = try notification(tool: "ConnectionRequest", scope: "conversation", retain: true)
    #expect(backgroundApprovalResponse(actionID: "ALLOW_CONVERSATION_ACTION", item: item, expectedSessionID: "s1", reviewedToolName: "ConnectionRequest", reviewedInput: item.request?.toolInput)?.decision == .session)
    for action in ["ALLOW_ONCE_ACTION", "ALLOW_SESSION_ACTION", "ALLOW_SEARCH_SESSION_ACTION"] {
        #expect(backgroundApprovalResponse(actionID: action, item: item, expectedSessionID: "s1", reviewedToolName: "ConnectionRequest", reviewedInput: item.request?.toolInput) == nil)
    }
}
