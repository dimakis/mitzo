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

@Test func watchExactForkAssignmentTransfersExistingSubmissionOnce() throws {
    var draft = WatchSendDraft()
    draft.edit("Continue reasoning")
    _ = draft.begin(sessionId: "ended-reasoning", clientMsgId: "fork")
    let assignment = try receipt("""
    {"type":"session_id","sessionId":"ordinary-child","clientMsgId":"fork"}
    """)
    let assigned = draft.receive(assignment)
    #expect(assigned == .assigned(sessionId: "ordinary-child"))
    #expect(draft.pending?.sessionId == "ordinary-child")
    #expect(draft.pending?.prompt == "Continue reasoning")
    #expect(draft.text == "Continue reasoning")
    #expect(!draft.canSubmit)
    let duplicate = draft.receive(assignment)
    #expect(duplicate == nil)
    let stale = try draft.receive(receipt("""
    {"type":"session_id","sessionId":"ended-reasoning","clientMsgId":"fork"}
    """))
    #expect(stale == nil)
    #expect(draft.pending?.sessionId == "ordinary-child")
    let oldEcho = try draft.receive(receipt("""
    {"type":"user_message","sessionId":"ended-reasoning","messageId":"fork","text":"Continue reasoning"}
    """))
    #expect(oldEcho == nil)
    let accepted = try draft.receive(receipt("""
    {"type":"user_message","sessionId":"ordinary-child","messageId":"fork","text":"Continue reasoning"}
    """))
    #expect(accepted == .accepted(clientMsgId: "fork"))
    #expect(draft.pending == nil)
    #expect(draft.text.isEmpty)
}

@Test(arguments: ["foreign-command", "missing-command"])
func watchExistingSessionIgnoresUncorrelatedAssignment(kind: String) throws {
    var draft = WatchSendDraft()
    draft.edit("Continue")
    _ = draft.begin(sessionId: "ended-reasoning", clientMsgId: "fork")
    let field = kind == "foreign-command" ? ",\"clientMsgId\":\"foreign\"" : ""
    let observed = try draft.receive(receipt("{\"type\":\"session_id\",\"sessionId\":\"other\"\(field)}"))
    #expect(observed == nil)
    #expect(draft.pending?.sessionId == "ended-reasoning")
    #expect(draft.text == "Continue")
}

@Test(arguments: [false, true])
func watchStartupErrorRoundTripSettlesExactPendingCommand(scoped: Bool) throws {
    var draft = WatchSendDraft()
    draft.edit("  Invalid startup  ")
    _ = draft.begin(sessionId: "child", clientMsgId: "startup")
    let field = scoped ? ",\"sessionId\":\"child\"" : ""
    let original = try receipt("{\"type\":\"error\",\"error\":\"Startup rejected\",\"clientMsgId\":\"startup\"\(field)}")
    // The iPhone relay decodes then re-encodes ServerMessage before Watch receives it.
    let encoded = try JSONEncoder().encode(original)
    let relayed = try JSONDecoder().decode(ServerMessage.self, from: encoded)
    let fields = try #require(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
    #expect(fields["clientMsgId"] as? String == "startup")
    if scoped { #expect(fields["sessionId"] as? String == "child") }
    let rejected = draft.receive(relayed)
    #expect(rejected == .rejected(clientMsgId: "startup"))
    #expect(draft.pending == nil)
    #expect(draft.text == "  Invalid startup  ")
    #expect(draft.canSubmit)
    let duplicate = draft.receive(relayed)
    #expect(duplicate == nil)
}

@Test func watchStartupErrorPreservesNewerEditsAndExplicitRecovery() throws {
    var draft = WatchSendDraft()
    draft.edit("Original invalid command")
    _ = draft.begin(sessionId: nil, clientMsgId: "startup")
    draft.edit("Newer input")
    let rejected = try draft.receive(receipt("""
    {"type":"error","error":"Startup rejected","clientMsgId":"startup"}
    """))
    #expect(rejected == .rejected(clientMsgId: "startup"))
    #expect(draft.pending == nil)
    #expect(draft.text == "Newer input")
    #expect(draft.rejectedText == "Original invalid command")
    #expect(!draft.canSubmit)
    draft.edit("")
    let restored = draft.restoreRejected()
    #expect(restored)
    #expect(draft.text == "Original invalid command")
    #expect(draft.pending == nil)
}

@Test(arguments: ["foreign-session", "foreign-command", "missing-command"])
func watchStartupErrorMustCorrelateBeforeAcceptance(kind: String) throws {
    var draft = WatchSendDraft()
    draft.edit("Pending input")
    _ = draft.begin(sessionId: "child", clientMsgId: "startup")
    let session = kind == "foreign-session" ? "other" : "child"
    let id = kind == "foreign-command" ? "other" : "startup"
    let field = kind == "missing-command" ? "" : ",\"clientMsgId\":\"\(id)\""
    let observed = try draft.receive(receipt("{\"type\":\"error\",\"sessionId\":\"\(session)\",\"error\":\"Unrelated error\"\(field)}"))
    #expect(observed == nil)
    #expect(draft.pending?.clientMsgId == "startup")
    #expect(draft.text == "Pending input")
}

@Test func watchAcceptedInputCannotBeResurrectedByLateStartupError() throws {
    var draft = WatchSendDraft()
    draft.edit("Accepted input")
    _ = draft.begin(sessionId: "child", clientMsgId: "accepted")
    _ = draft.receive(try receipt("""
    {"type":"user_message","sessionId":"child","messageId":"accepted","text":"Accepted input"}
    """))
    let observed = try draft.receive(receipt("""
    {"type":"error","sessionId":"child","clientMsgId":"accepted","error":"Late error"}
    """))
    #expect(observed == nil)
    #expect(draft.text.isEmpty)
    #expect(draft.rejectedText == nil)
    draft.edit("Next input")
    _ = draft.begin(sessionId: "child", clientMsgId: "next")
    let stale = try draft.receive(receipt("""
    {"type":"error","clientMsgId":"accepted","error":"Duplicate late error"}
    """))
    #expect(stale == nil)
    #expect(draft.pending?.clientMsgId == "next")
    #expect(draft.text == "Next input")
}

@Test func watchForkAcceptanceKeepsSameTextNewerEditRevision() throws {
    var draft = WatchSendDraft()
    draft.edit("Continue")
    _ = draft.begin(sessionId: "ended-reasoning", clientMsgId: "fork")
    draft.edit("Intermediate")
    draft.edit("Continue")
    _ = draft.receive(try receipt("""
    {"type":"session_id","sessionId":"ordinary-child","clientMsgId":"fork"}
    """))
    let accepted = try draft.receive(receipt("""
    {"type":"user_message","sessionId":"ordinary-child","messageId":"fork","text":"Continue"}
    """))
    #expect(accepted == .accepted(clientMsgId: "fork"))
    #expect(draft.text == "Continue")
    #expect(draft.pending == nil)
    #expect(draft.canSubmit)
}

@Test(arguments: ["unchanged", "newer", "same-text-newer"])
func watchFirstExactEchoBindsUnassignedStartupWithoutCorrelatedAssignment(edit: String) throws {
    var draft = WatchSendDraft()
    let id = "501d3b87-baee-42b5-8e98-6b61e2bbeb4a"
    draft.edit("New Watch input")
    _ = draft.begin(sessionId: nil, clientMsgId: id)
    let assignment = try draft.receive(receipt("""
    {"type":"session_id","sessionId":"sdk-child"}
    """))
    #expect(assignment == nil)
    #expect(draft.pending?.sessionId == nil)
    if edit != "unchanged" {
        draft.edit("Newer input")
        if edit == "same-text-newer" { draft.edit("New Watch input") }
    }
    let echo = try receipt("""
    {"type":"user_message","sessionId":"sdk-child","messageId":"\(id)","text":"New Watch input"}
    """)
    let accepted = draft.receive(echo)
    #expect(accepted == .accepted(clientMsgId: id))
    #expect(draft.pending == nil)
    #expect(draft.text == (edit == "unchanged" ? "" : edit == "newer" ? "Newer input" : "New Watch input"))
    let duplicate = draft.receive(echo)
    #expect(duplicate == nil)
}

@Test(arguments: ["", " \n "])
func watchUnassignedEchoRequiresNonemptySessionId(session: String) throws {
    var draft = WatchSendDraft()
    let id = "501d3b87-baee-42b5-8e98-6b61e2bbeb4a"
    draft.edit("Pending input")
    _ = draft.begin(sessionId: nil, clientMsgId: id)
    let data = try JSONSerialization.data(withJSONObject: [
        "type": "user_message", "sessionId": session, "messageId": id, "text": "Pending input",
    ])
    let observed = try draft.receive(JSONDecoder().decode(ServerMessage.self, from: data))
    #expect(observed == nil)
    #expect(draft.pending?.clientMsgId == id)
    #expect(draft.pending?.sessionId == nil)
    #expect(draft.text == "Pending input")
}

@Test func watchUnassignedEchoIgnoresForeignOrMissingCommandAndMissingSession() throws {
    var draft = WatchSendDraft()
    let id = "501d3b87-baee-42b5-8e98-6b61e2bbeb4a"
    draft.edit("Pending input")
    _ = draft.begin(sessionId: nil, clientMsgId: id)
    let foreign = try draft.receive(receipt("""
    {"type":"user_message","sessionId":"foreign","messageId":"f841c8af-fb49-4df9-ae0b-c68f289887cb","text":"Other input"}
    """))
    #expect(foreign == nil)
    #expect(throws: (any Error).self) {
        try receipt("{\"type\":\"user_message\",\"sessionId\":\"child\",\"text\":\"Missing command\"}")
    }
    #expect(throws: (any Error).self) {
        try receipt("{\"type\":\"user_message\",\"messageId\":\"\(id)\",\"text\":\"Missing session\"}")
    }
    #expect(draft.pending?.clientMsgId == id)
    #expect(draft.pending?.sessionId == nil)
    #expect(draft.text == "Pending input")
}

@Test func watchExactEchoCannotOverrideExplicitSessionAssignment() throws {
    var draft = WatchSendDraft()
    let id = "501d3b87-baee-42b5-8e98-6b61e2bbeb4a"
    draft.edit("Assigned input")
    _ = draft.begin(sessionId: nil, clientMsgId: id)
    _ = draft.receive(try receipt("""
    {"type":"session_id","sessionId":"assigned-child","clientMsgId":"\(id)"}
    """))
    let foreign = try draft.receive(receipt("""
    {"type":"user_message","sessionId":"foreign","messageId":"\(id)","text":"Assigned input"}
    """))
    #expect(foreign == nil)
    #expect(draft.pending?.sessionId == "assigned-child")
    #expect(draft.text == "Assigned input")
    let accepted = try draft.receive(receipt("""
    {"type":"user_message","sessionId":"assigned-child","messageId":"\(id)","text":"Assigned input"}
    """))
    #expect(accepted == .accepted(clientMsgId: id))
    #expect(draft.pending == nil)
}
