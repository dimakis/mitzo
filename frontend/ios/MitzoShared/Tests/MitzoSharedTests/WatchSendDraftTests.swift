import Foundation
import Testing
@testable import MitzoShared

private func receipt(_ json: String) throws -> ServerMessage {
    try JSONDecoder().decode(ServerMessage.self, from: Data(json.utf8))
}

@Test func watchOrdinaryRefusalRetainsExactDraftAndSettlesOnce() throws {
    var draft = WatchSendDraft()
    draft.edit("  Submitted input  ")
    let proposed = draft.begin(sessionId: "child", clientMsgId: "send-1")
    let sent = try #require(proposed)
    #expect(sent.prompt == "Submitted input")
    #expect(draft.text == "  Submitted input  ")
    #expect(!draft.canSubmit)
    let refusal = try receipt("""
    {"type":"session_control_rejected","sessionId":"child","control":"send","clientMsgId":"send-1","error":"Use contributor controls"}
    """)
    let observed1 = draft.receive(refusal)
    #expect(observed1 == .rejected(clientMsgId: "send-1"))
    #expect(draft.pending == nil)
    #expect(draft.text == "  Submitted input  ")
    #expect(draft.canSubmit)
    let observed2 = draft.receive(refusal)
    #expect(observed2 == nil)
}

@Test func watchNewerDraftSurvivesRefusalWithExplicitRecoveryAndDiscard() throws {
    var draft = WatchSendDraft()
    draft.edit("Original input")
    _ = draft.begin(sessionId: "child", clientMsgId: "old")
    draft.edit("Newer input")
    _ = draft.receive(try receipt("""
    {"type":"session_control_rejected","sessionId":"child","control":"send","clientMsgId":"old","error":"Refused"}
    """))
    #expect(draft.text == "Newer input")
    #expect(draft.rejectedText == "Original input")
    #expect(!draft.canSubmit)
    let observed3 = draft.restoreRejected()
    #expect(!observed3)
    #expect(draft.text == "Newer input")
    var discarded = draft
    discarded.discardRejected()
    #expect(discarded.text == "Newer input")
    #expect(discarded.rejectedText == nil)
    #expect(discarded.canSubmit)
    draft.edit("")
    let observed4 = draft.restoreRejected()
    #expect(observed4)
    #expect(draft.text == "Original input")
    #expect(draft.rejectedText == nil)
    #expect(draft.pending == nil) // Restoring never dispatches.
}

@Test(arguments: ["foreign", "wrong-control", "wrong-id", "missing-id"])
func watchRefusalMustMatchSessionControlAndCommand(kind: String) throws {
    var draft = WatchSendDraft()
    draft.edit("Keep input")
    _ = draft.begin(sessionId: "child", clientMsgId: "send-1")
    let session = kind == "foreign" ? "other" : "child"
    let control = kind == "wrong-control" ? "interrupt" : "send"
    let id = kind == "wrong-id" ? "other" : "send-1"
    let field = kind == "missing-id" ? "" : ",\"clientMsgId\":\"\(id)\""
    let observed5 = try draft.receive(receipt("{\"type\":\"session_control_rejected\",\"sessionId\":\"\(session)\",\"control\":\"\(control)\"\(field),\"error\":\"Refused\"}"))
    #expect(observed5 == nil)
    #expect(draft.pending?.clientMsgId == "send-1")
    #expect(draft.text == "Keep input")
}

@Test func watchOnlyExactSavedEchoAcceptsAndClearsUnchangedInputOnce() throws {
    var draft = WatchSendDraft()
    draft.edit("Submitted input")
    _ = draft.begin(sessionId: "child", clientMsgId: "send-1")
    let observed6 = try draft.receive(receipt("{\"type\":\"user_message\",\"sessionId\":\"other\",\"messageId\":\"send-1\",\"text\":\"Foreign\"}"))
    #expect(observed6 == nil)
    let echo = try receipt("{\"type\":\"user_message\",\"sessionId\":\"child\",\"messageId\":\"send-1\",\"text\":\"Submitted input\"}")
    let observed7 = draft.receive(echo)
    #expect(observed7 == .accepted(clientMsgId: "send-1"))
    #expect(draft.text.isEmpty)
    #expect(draft.pending == nil)
    let observed8 = draft.receive(echo)
    #expect(observed8 == nil)
}

@Test(arguments: [false, true]) func watchAcceptanceKeepsNewerEditsEvenWhenTextMatches(sameText: Bool) throws {
    var draft = WatchSendDraft()
    draft.edit("Original")
    _ = draft.begin(sessionId: "child", clientMsgId: "send-1")
    draft.edit("Intermediate")
    draft.edit(sameText ? "Original" : "Newer")
    _ = draft.receive(try receipt("{\"type\":\"user_message\",\"sessionId\":\"child\",\"messageId\":\"send-1\",\"text\":\"Original\"}"))
    #expect(draft.text == (sameText ? "Original" : "Newer"))
    #expect(draft.pending == nil)
}

@Test func watchAssignmentIsNotAcceptanceAndCannotAssignAnotherCommand() throws {
    var draft = WatchSendDraft()
    draft.edit("New conversation")
    _ = draft.begin(sessionId: nil, clientMsgId: "send-1")
    let observed9 = try draft.receive(receipt("{\"type\":\"session_id\",\"sessionId\":\"foreign\",\"clientMsgId\":\"other\"}"))
    #expect(observed9 == nil)
    let observed10 = try draft.receive(receipt("{\"type\":\"session_id\",\"sessionId\":\"legacy\"}"))
    #expect(observed10 == nil)
    let observed11 = try draft.receive(receipt("{\"type\":\"session_id\",\"sessionId\":\"assigned\",\"clientMsgId\":\"send-1\"}"))
    #expect(observed11 == .assigned(sessionId: "assigned"))
    #expect(draft.pending?.sessionId == "assigned")
    #expect(draft.text == "New conversation")
    #expect(!draft.canSubmit)
    _ = draft.receive(try receipt("{\"type\":\"user_message\",\"sessionId\":\"assigned\",\"messageId\":\"send-1\",\"text\":\"New conversation\"}"))
    #expect(draft.text.isEmpty)
}

@Test func watchUnknownOrLostReceiptKeepsPendingAndStaleReceiptCannotSettleRetry() throws {
    var draft = WatchSendDraft()
    draft.edit("Uncertain input")
    _ = draft.begin(sessionId: "child", clientMsgId: "old")
    let observed12 = draft.receive(.unknown(type: "relay_sent"))
    #expect(observed12 == nil)
    #expect(draft.pending?.clientMsgId == "old")
    let observed13 = draft.begin(sessionId: "child", clientMsgId: "duplicate")
    #expect(observed13 == nil)
    let oldRefusal = try receipt("{\"type\":\"session_control_rejected\",\"sessionId\":\"child\",\"control\":\"send\",\"clientMsgId\":\"old\",\"error\":\"Refused\"}")
    _ = draft.receive(oldRefusal)
    #expect(draft.pending == nil)
    _ = draft.begin(sessionId: "child", clientMsgId: "retry") // Explicit retry only.
    let observed14 = draft.receive(oldRefusal)
    #expect(observed14 == nil)
    let observed15 = try draft.receive(receipt("{\"type\":\"user_message\",\"sessionId\":\"child\",\"messageId\":\"old\",\"text\":\"Uncertain input\"}"))
    #expect(observed15 == nil)
    #expect(draft.pending?.clientMsgId == "retry")
}

@Test func watchNativeResultRequiresExactNullableSessionAndCommand() throws {
    var draft = WatchSendDraft()
    draft.edit("/skills")
    _ = draft.begin(sessionId: nil, clientMsgId: "native")
    let observed16 = try draft.receive(receipt("{\"type\":\"native_command_result\",\"clientMsgId\":\"native\",\"command\":\"skills\",\"content\":\"Legacy\"}"))
    #expect(observed16 == nil)
    let observed17 = try draft.receive(receipt("{\"type\":\"native_command_result\",\"sessionId\":\"foreign\",\"clientMsgId\":\"native\",\"command\":\"skills\",\"content\":\"Foreign\"}"))
    #expect(observed17 == nil)
    let observed18 = try draft.receive(receipt("{\"type\":\"native_command_result\",\"sessionId\":null,\"clientMsgId\":\"native\",\"command\":\"skills\",\"content\":\"Available\"}"))
    #expect(observed18 == .accepted(clientMsgId: "native"))
    #expect(draft.text.isEmpty)
    #expect(draft.pending == nil)
}
