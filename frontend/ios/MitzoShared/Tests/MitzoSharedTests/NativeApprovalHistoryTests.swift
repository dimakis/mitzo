import Foundation
import Testing
@testable import MitzoShared

private func historyAttempt() -> NativeApprovalAttempt {
    let action = NativeApprovalAction(notificationId: "permission:p1", sessionId: "s1", actionID: "ALLOW_SESSION_ACTION",
        reviewedToolName: "Bash", reviewedInput: "private command")
    return NativeApprovalAttempt(identity: action.identity, origin: "https://offline.invalid/", deliveredID: UUID().uuidString, code: "approval_unconfirmed")
}

@Test func historyNeverEvictsAnUnconfirmedNativeIdentityForNewerTerminalActions() throws {
    let uncertain = historyAttempt()
    var history = [uncertain]
    for _ in 0..<70 {
        var terminal = historyAttempt()
        let receipt = NativeApprovalReceipt(requestId: terminal.identity.requestId, notificationId: terminal.identity.notificationId,
            sessionId: "s1", nativeAction: terminal.identity.actionID, decision: .session, status: "settled", resolution: "allowed")
        let matched = terminal.apply(receipt)
        #expect(matched)
        history = retainingNativeApprovalAttempt(terminal, in: history)
    }
    #expect(history.count == 51)
    #expect(history.contains { $0.identity.requestId == uncertain.identity.requestId })
    let restored = try JSONDecoder().decode([NativeApprovalAttempt].self, from: JSONEncoder().encode(history))
    #expect(restored.contains { $0.identity.requestId == uncertain.identity.requestId && !$0.isTerminal })
    #expect(!String(decoding: try JSONEncoder().encode(restored), as: UTF8.self).contains("private command"))
}

@Test func onlyAnExactTerminalReceiptStopsNativeRecovery() {
    var attempt = historyAttempt()
    for (requestID, status, resolution, expectedTerminal) in [
        ("other", "settled", "allowed", false),
        (attempt.identity.requestId, "received", "", false),
        (attempt.identity.requestId, "unconfirmed", "", false),
        (attempt.identity.requestId, "rejected", "expired", true),
    ] {
        let receipt = NativeApprovalReceipt(requestId: requestID, notificationId: attempt.identity.notificationId,
            sessionId: "s1", nativeAction: attempt.identity.actionID, decision: .session,
            status: status, resolution: resolution.isEmpty ? nil : resolution)
        _ = attempt.apply(receipt)
        #expect(attempt.isTerminal == expectedTerminal)
    }
    #expect(attempt.code == "approval_expired")
}
