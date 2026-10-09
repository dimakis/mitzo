import Foundation
import Testing
@testable import MitzoShared

@Test func watchReviewOpensTheExactNotificationEvenOutsideTheLatestFeed() {
    #expect(WatchNotificationDestination(actionID: "REVIEW_PERMISSION_ACTION", notificationID: "permission:old", sessionID: "s1") == .notification("permission:old"))
    #expect(WatchNotificationDestination(actionID: "com.apple.UNNotificationDefaultActionIdentifier", notificationID: "permission:p1", sessionID: "s1") == .notification("permission:p1"))
    #expect(WatchNotificationDestination(actionID: "VIEW_ACTION", notificationID: nil, sessionID: "s1") == .session("s1"))
}

@Test func watchBackgroundActionsNeverNavigateOrSubmitTwice() {
    for action in ["ALLOW_ONCE_ACTION", "ALLOW_SEARCH_SESSION_ACTION", "DENY_PERMISSION_ACTION", "LATER_ACTION", "com.apple.UNNotificationDismissActionIdentifier", "unknown"] {
        #expect(WatchNotificationDestination(actionID: action, notificationID: "permission:p1", sessionID: "s1") == nil)
    }
    #expect(WatchNotificationDestination(actionID: "VIEW_ACTION", notificationID: "", sessionID: "") == nil)
}

@Test func watchReplyPreservesDictationAndDoesNotTreatItAsApproval() {
    #expect(WatchNotificationDestination(actionID: "REPLY_ACTION", notificationID: "turn:s1:3", sessionID: "s1", userText: "Continue with tests") == .reply(sessionID: "s1", text: "Continue with tests"))
    #expect(WatchNotificationDestination(actionID: "REPLY_ACTION", notificationID: nil, sessionID: "s1", userText: "  ") == .session("s1"))
    #expect(WatchNotificationDestination(actionID: "REPLY_ACTION", notificationID: "permission:p1", sessionID: nil, userText: "yes") == nil)
}

@Test func notificationRelayUsesOnlyTheConfiguredOrigin() {
    #expect(notificationServerURL("https://mitzo.example:3190/")?.host == "mitzo.example")
    #expect(notificationServerURL("http://mitzo-staging.localhost:3190")?.port == 3190)
    for origin in [nil, "", "file:///tmp/mitzo", "https://user:secret@mitzo.example", "https://mitzo.example/api", "https://mitzo.example?token=x", "https://mitzo.example/#x"] {
        #expect(notificationServerURL(origin) == nil)
    }
}

private func watchApproval(input: String = "npm test", session: String = "s1", scope: String = "request", resolved: Bool = false) throws -> MitzoNotification {
    let object: [String: Any] = ["id": "permission:p1", "kind": "approval", "title": "Run tests?", "body": "Session",
        "sessionId": session, "createdAt": 1, "expiresAt": 1000, "resolvedAt": resolved ? 1 : NSNull(),
        "request": ["permId": "p1", "toolName": "Bash", "toolInput": input, "approvalScope": scope]]
    return try JSONDecoder().decode(MitzoNotification.self, from: JSONSerialization.data(withJSONObject: object))
}

@Test func watchApprovalRevalidatesTheRequestReviewedOnTheWrist() throws {
    let reviewed = try watchApproval()
    #expect(watchNotificationResponse(reviewed: reviewed, current: reviewed, decision: .once, at: 999)?.decision == .once)
    for changed in [try watchApproval(input: "rm changed"), try watchApproval(session: "s2"), try watchApproval(resolved: true), try watchApproval(scope: "conversation")] {
        #expect(watchNotificationResponse(reviewed: reviewed, current: changed, decision: .once, at: 999) == nil)
    }
    #expect(watchNotificationResponse(reviewed: reviewed, current: reviewed, decision: .once, at: 1000) == nil)
    #expect(watchNotificationResponse(reviewed: reviewed, current: reviewed, decision: .session, at: 999) == nil)
}
