import Foundation

/// One Watch composer submission. Transport completion is deliberately not a receipt.
public struct WatchSendDraft: Sendable {
    public enum Receipt: Equatable, Sendable {
        case assigned(sessionId: String)
        case accepted(clientMsgId: String)
        case rejected(clientMsgId: String)
    }

    private struct Submission: Sendable {
        var params: SendParams
        let originalDraft: String
        let revision: UInt64
        var assignmentReceived = false
    }

    public private(set) var text = ""
    public private(set) var rejectedText: String?
    private var revision: UInt64 = 0
    private var submission: Submission?
    public var pending: SendParams? { submission?.params }
    public var canSubmit: Bool {
        submission == nil && rejectedText == nil &&
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    public init() {}

    public mutating func edit(_ text: String) {
        self.text = text
        revision &+= 1
    }

    public mutating func begin(sessionId: String?, clientMsgId: String) -> SendParams? {
        guard canSubmit else { return nil }
        let params = SendParams(sessionId: sessionId,
                                prompt: text.trimmingCharacters(in: .whitespacesAndNewlines),
                                clientMsgId: clientMsgId)
        submission = Submission(params: params, originalDraft: text, revision: revision)
        return params
    }

    /// Only explicit operator recovery changes the composer; it never dispatches.
    @discardableResult public mutating func restoreRejected() -> Bool {
        guard text.isEmpty, submission == nil, let rejectedText else { return false }
        edit(rejectedText)
        self.rejectedText = nil
        return true
    }

    public mutating func discardRejected() { rejectedText = nil }

    public mutating func receive(_ message: ServerMessage) -> Receipt? {
        guard var submitted = submission else { return nil }
        let id = submitted.params.clientMsgId
        switch message {
        case .sessionId(let sessionId, _, _, let clientMsgId):
            // Following up on ended reasoning can fork an existing conversation.
            guard clientMsgId == id, !submitted.assignmentReceived else { return nil }
            submitted.params = SendParams(sessionId: sessionId, prompt: submitted.params.prompt,
                                          clientMsgId: id)
            submitted.assignmentReceived = true
            submission = submitted
            return .assigned(sessionId: sessionId)
        case .userMessage(let params):
            // Legacy SDK fan-out can omit the command ID from session_id.
            // Its exact persisted echo may bind only an otherwise unassigned send.
            guard params.messageId == id,
                  !params.sessionId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  submitted.params.sessionId == nil || params.sessionId == submitted.params.sessionId else { return nil }
            return settle(submitted, accepted: true)
        case .nativeCommandResult(let params):
            guard params.hasSessionId, params.clientMsgId == id,
                  params.sessionId == submitted.params.sessionId else { return nil }
            return settle(submitted, accepted: true)
        case .sessionControlRejected(let params):
            guard params.control == .send, params.clientMsgId == id,
                  params.sessionId == submitted.params.sessionId else { return nil }
            return settle(submitted, accepted: false)
        case .error(_, let sessionId, let clientMsgId):
            // Startup validation can reject before a session is assigned.
            guard clientMsgId == id,
                  sessionId == nil || sessionId == submitted.params.sessionId else { return nil }
            return settle(submitted, accepted: false)
        default:
            // Lost/unknown transport receipts retain this command and prohibit replay.
            return nil
        }
    }

    private mutating func settle(_ submitted: Submission, accepted: Bool) -> Receipt {
        submission = nil
        if accepted {
            if revision == submitted.revision { edit("") }
            return .accepted(clientMsgId: submitted.params.clientMsgId)
        }
        if revision != submitted.revision { rejectedText = submitted.originalDraft }
        return .rejected(clientMsgId: submitted.params.clientMsgId)
    }
}
