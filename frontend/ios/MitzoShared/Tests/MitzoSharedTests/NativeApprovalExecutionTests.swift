import Foundation
import Testing
@testable import MitzoShared

private actor ApprovalFixture: BackgroundApprovalTransport {
    let item: MitzoNotification
    let failAfterSubmit: Bool
    private(set) var submissions = 0
    private(set) var sentDecision: NotificationResponse.Decision?
    private(set) var reads = 0
    private var saved: NativeApprovalReceipt?
    init(scope: String = "request", failAfterSubmit: Bool = false) throws {
        self.failAfterSubmit = failAfterSubmit
        let json = """
        {"id":"permission:p1","kind":"approval","title":"Approval","body":"Session","sessionId":"s1","createdAt":1,
        "request":{"permId":"p1","toolName":"Bash","toolInput":"npm test","approvalScope":"\(scope)"}}
        """
        item = try JSONDecoder().decode(MitzoNotification.self, from: Data(json.utf8))
    }
    func fetchNotification(id: String) async throws -> MitzoNotification { item }
    func submitApproval(_ action: NativeApprovalAction, response: NotificationResponse) async throws -> NativeApprovalReceipt {
        submissions += 1
        sentDecision = response.decision
        let receipt = NativeApprovalReceipt(requestId: action.requestId, notificationId: action.notificationId,
            sessionId: action.sessionId, nativeAction: action.actionID, decision: response.decision,
            status: "settled", resolution: response.decision == .deny ? "denied" : "allowed")
        saved = receipt
        if failAfterSubmit { throw URLError(.networkConnectionLost) }
        return receipt
    }
    func approvalReceipt(_ identity: NativeApprovalIdentity) async throws -> NativeApprovalReceipt {
        reads += 1
        return try #require(saved)
    }
}

private func nativeAction(_ actionID: String) -> NativeApprovalAction {
    NativeApprovalAction(notificationId: "permission:p1", sessionId: "s1", actionID: actionID,
        reviewedToolName: "Bash", reviewedInput: "npm test")
}

private actor HTTPFixture {
    private(set) var requests: [URLRequest] = []
    private(set) var tokenReads = 0
    var loggedOut = false
    let action: NativeApprovalAction
    let item: MitzoNotification
    init(action: NativeApprovalAction, item: MitzoNotification) { self.action = action; self.item = item }
    func token() throws -> String {
        tokenReads += 1
        if loggedOut { throw AuthManager.AuthError.noToken }
        return "offline-fixture"
    }
    func send(_ request: URLRequest) throws -> (Data, URLResponse) {
        requests.append(request)
        let url = request.url!
        let body: Data
        if url.path.hasSuffix("/respond") { throw URLError(.networkConnectionLost) }
        if url.path.contains("/responses/") {
            let receipt = NativeApprovalReceipt(requestId: action.requestId, notificationId: action.notificationId,
                sessionId: action.sessionId, nativeAction: action.actionID, decision: .session, status: "settled", resolution: "allowed")
            struct Reply: Encodable { let receipt: NativeApprovalReceipt }
            body = try JSONEncoder().encode(Reply(receipt: receipt))
        } else { body = try JSONEncoder().encode(item) }
        return (body, HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    }
    func logout() { loggedOut = true }
}

@Test func actualNativeHTTPAdapterKeepsActionScopeIdentityAndReadsReceiptAfterLostResponse() async throws {
    let item = try ApprovalFixture().item
    let action = nativeAction("ALLOW_SESSION_ACTION")
    let fixture = HTTPFixture(action: action, item: item)
    let api = MitzoAPIClient(baseURL: URL(string: "https://offline.invalid")!, currentToken: { try await fixture.token() },
        transport: { try await fixture.send($0) })
    _ = try await submitBackgroundApproval(action, using: api)
    let requests = await fixture.requests
    #expect(requests.map(\.httpMethod) == ["GET", "POST", "GET"])
    let posted = try #require(requests[1].httpBody)
    let json = try #require(JSONSerialization.jsonObject(with: posted) as? [String: Any])
    #expect(json["decision"] as? String == "always")
    #expect(json["nativeAction"] as? String == "ALLOW_SESSION_ACTION")
    #expect(json["requestId"] as? String == action.requestId)
    #expect(requests[2].url?.path.hasSuffix(action.requestId) == true)
    #expect(await fixture.tokenReads == 3)
    await fixture.logout()
    await #expect(throws: (any Error).self) { try await api.submitApproval(action, response: NotificationResponse(sessionId: "s1", decision: .session)) }
    #expect(await fixture.requests.count == 3)
}

@Test func nativeActionsPreserveEveryDecisionThroughTheOwningTransport() async throws {
    for (actionID, scope, decision) in [("ALLOW_ONCE_ACTION", "request", NotificationResponse.Decision.once),
        ("ALLOW_SESSION_ACTION", "request", .session), ("ALLOW_CONVERSATION_ACTION", "conversation", .session),
        ("DENY_PERMISSION_ACTION", "request", .deny)] {
        let api = try ApprovalFixture(scope: scope)
        let receipt = try await submitBackgroundApproval(nativeAction(actionID), using: api)
        #expect(receipt.nativeAction == actionID)
        #expect(await api.sentDecision == decision)
        #expect(await api.submissions == 1)
    }
}

@Test func uncertainNativePostRecoversItsOwnReceiptWithoutRepeatingApproval() async throws {
    let api = try ApprovalFixture(failAfterSubmit: true)
    let action = nativeAction("ALLOW_SESSION_ACTION")
    let receipt = try await submitBackgroundApproval(action, using: api)
    #expect(receipt.requestId == action.requestId)
    #expect(receipt.decision == .session)
    #expect(await api.submissions == 1)
    #expect(await api.reads == 1)
    // The reconnect identity retains scope but no command, credential or grant.
    let encoded = try JSONEncoder().encode(action.identity)
    #expect(!String(decoding: encoded, as: UTF8.self).contains("npm test"))
    let retained = try JSONDecoder().decode(NativeApprovalIdentity.self, from: encoded)
    #expect(retained.matches(receipt))
    let wrong = NativeApprovalReceipt(requestId: "other", notificationId: action.notificationId,
        sessionId: "s1", nativeAction: action.actionID, decision: .session, status: "settled", resolution: "allowed")
    #expect(!retained.matches(wrong))
}

private final class CompletionProbe: @unchecked Sendable {
    private let lock = NSLock()
    private var results: [Result<Void, Error>] = []
    func record(_ result: Result<Void, Error>) { lock.withLock { results.append(result) } }
    var count: Int { lock.withLock { results.count } }
    var code: String? { lock.withLock {
        guard let first = results.first, case .failure(let error) = first else { return nil }
        return backgroundApprovalErrorCode(error)
    } }
}

private actor StalledOperation {
    var continuation: CheckedContinuation<Void, Never>?
    func wait() async { await withCheckedContinuation { continuation = $0 } }
    func release() { continuation?.resume(); continuation = nil }
}

@Test func callbackDeadlineAndExpirationCompleteOnceEvenWhenWorkIgnoresCancellation() async throws {
    for cancel in [false, true] {
        let stalled = StalledOperation(), probe = CompletionProbe()
        let execution = BackgroundApprovalExecution(timeout: 0.03, completion: { probe.record($0) })
        execution.start { await stalled.wait() }
        if cancel { execution.cancel() }
        let deadline = Date().addingTimeInterval(1)
        while probe.count == 0 && Date() < deadline { try await Task.sleep(nanoseconds: 2_000_000) }
        #expect(probe.count == 1)
        #expect(probe.code == (cancel ? "approval_cancelled" : "approval_deadline"))
        await stalled.release()
        execution.cancel()
        #expect(probe.count == 1)
    }
}

@Test func nativeFailureDiagnosticsUseStableCodesAndRetainOriginalCause() {
    let original = URLError(.cannotConnectToHost, userInfo: [NSLocalizedDescriptionKey: "private credential URL"])
    let error = BackgroundApprovalFailure(code: "approval_unconfirmed", cause: original)
    #expect(backgroundApprovalErrorCode(error) == "approval_unconfirmed")
    #expect((error.cause as? URLError)?.code == .cannotConnectToHost)
    #expect(!backgroundApprovalErrorCode(original).contains("private"))
}
