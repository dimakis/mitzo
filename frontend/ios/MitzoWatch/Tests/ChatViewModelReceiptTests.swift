// Offline harness compiles the real Watch view model with only its relay owner stubbed.
// No app, WatchConnectivity, provider, network or simulator is started.
import Foundation
import MitzoShared

@MainActor
final class AppState {
    enum ConnectionMode { case relay }
    var connectionMode: ConnectionMode = .relay
    var sent: [ClientMessage] = []
    func setActiveChatVM(_ vm: ChatViewModel?) {}
    func loadMessages(sessionId: String) async throws -> [FinishedMessage] { [] }
    func sendMessage(_ message: ClientMessage) async throws { sent.append(message) }
}

@main
struct ChatViewModelReceiptTests {
    @MainActor static func main() async throws {
        try await assignedStartupFailureRetriesOnlyExplicitlyInNewSession()
        try await newChatCorrelatedAssignmentRejectsForeignReceipts()
        try await forkRoutesEchoAndReply()
        try await startupRefusalPreservesNewerDraftAndActiveStream()
        try await acceptedInputIsNotRestoredByLaterErrors()
        guard CommandLine.arguments.count == 3 else { throw Failure.missingFixture }
        try await backendStartupRoutesExactEchoAndReply(fixturePath: CommandLine.arguments[1], newerEdit: false, requireBareAssignment: false)
        try await backendStartupRoutesExactEchoAndReply(fixturePath: CommandLine.arguments[1], newerEdit: true, requireBareAssignment: false)
        try await backendStartupRoutesExactEchoAndReply(fixturePath: CommandLine.arguments[2], newerEdit: false, requireBareAssignment: true)
        try await backendStartupRoutesExactEchoAndReply(fixturePath: CommandLine.arguments[2], newerEdit: true, requireBareAssignment: true)
        try await foreignTerminalPreservesActiveSelectedStream(fixturePath: CommandLine.arguments[1])
        try await foreignTerminalPreservesActiveSelectedStream(fixturePath: CommandLine.arguments[2])
        try await selectedRuntimeErrorAfterAcceptancePreservesInputAndRouting(fixturePath: CommandLine.arguments[1])
        try await selectedRuntimeErrorAfterAcceptancePreservesInputAndRouting(fixturePath: CommandLine.arguments[2])
        print("13 offline Watch view-model receipt cases passed")
    }

    static func decode(_ json: String) throws -> ServerMessage {
        var wire = try JSONSerialization.jsonObject(with: Data(json.utf8)) as! [String: Any]
        wire["seq"] = 1
        wire["ts"] = 1
        let received = try JSONDecoder().decode(ServerMessage.self, from: JSONSerialization.data(withJSONObject: wire))
        // Mirror the phone relay's ServerMessage round trip.
        return try JSONDecoder().decode(ServerMessage.self, from: JSONEncoder().encode(received))
    }

    @MainActor static func pendingId(_ vm: ChatViewModel) throws -> String {
        guard let id = vm.sendDraft.pending?.clientMsgId else { throw Failure.missingPending }
        return id
    }

    @MainActor static func newChatCorrelatedAssignmentRejectsForeignReceipts() async throws {
        let app = AppState()
        let vm = ChatViewModel(sessionId: nil, appState: app)
        vm.sendDraft.edit("Initial Watch input")
        await vm.send()
        let id = try pendingId(vm)
        guard case .send(let first) = app.sent.last else { throw Failure.missingPending }
        precondition(first.sessionId == nil && first.clientMsgId == id)
        vm.handleMessage(try decode("{\"type\":\"session_id\",\"sessionId\":\"uncorrelated-child\"}"))
        vm.handleMessage(try decode("{\"type\":\"session_id\",\"sessionId\":\"foreign-child\",\"clientMsgId\":\"foreign-command\"}"))
        precondition(vm.sendDraft.pending?.sessionId == nil && !vm.sendDraft.canSubmit)
        vm.handleMessage(try decode("{\"type\":\"user_message\",\"sessionId\":\"uncorrelated-child\",\"messageId\":\"f841c8af-fb49-4df9-ae0b-c68f289887cb\",\"text\":\"Initial Watch input\"}"))
        precondition(vm.sendDraft.pending?.clientMsgId == id && vm.sendDraft.text == "Initial Watch input")
        vm.handleMessage(try decode("{\"type\":\"session_id\",\"sessionId\":\"watch-child\",\"clientMsgId\":\"\(id)\"}"))
        precondition(vm.sendDraft.pending?.sessionId == "watch-child" && !vm.sendDraft.canSubmit)
        vm.handleMessage(try decode("{\"type\":\"user_message\",\"sessionId\":\"watch-child\",\"messageId\":\"\(id)\",\"text\":\"Initial Watch input\"}"))
        precondition(vm.sendDraft.pending == nil && vm.sendDraft.text.isEmpty)
        precondition(vm.messages.filter { $0.id == id }.count == 1)
        vm.handleMessage(try decode("{\"type\":\"message_start\",\"sessionId\":\"watch-child\",\"messageId\":\"reply\"}"))
        precondition(vm.isStreaming && vm.currentStream?.messageId == "reply")
        vm.handleMessage(try decode("{\"type\":\"block_start\",\"sessionId\":\"watch-child\",\"messageId\":\"reply\",\"blockId\":\"text\",\"blockType\":\"text\"}"))
        vm.handleMessage(try decode("{\"type\":\"block_delta\",\"sessionId\":\"watch-child\",\"messageId\":\"reply\",\"blockId\":\"text\",\"blockType\":\"text\",\"delta\":\"Visible reply\"}"))
        vm.handleMessage(try decode("{\"type\":\"message_end\",\"sessionId\":\"watch-child\",\"messageId\":\"reply\"}"))
        precondition(vm.messages.last?.text == "Visible reply" && !vm.isStreaming)
        vm.sendDraft.edit("Next input")
        precondition(vm.sendDraft.canSubmit)
        await vm.send()
        guard case .send(let next) = app.sent.last else { throw Failure.missingPending }
        precondition(next.sessionId == "watch-child" && next.clientMsgId != id && app.sent.count == 2)
    }

    @MainActor static func forkRoutesEchoAndReply() async throws {
        let app = AppState()
        let vm = ChatViewModel(sessionId: "ended-reasoning", appState: app)
        vm.sendDraft.edit("Continue")
        await vm.send()
        let id = try pendingId(vm)
        vm.handleMessage(try decode("{\"type\":\"session_id\",\"sessionId\":\"foreign\",\"clientMsgId\":\"stale\"}"))
        vm.handleMessage(try decode("{\"type\":\"session_id\",\"sessionId\":\"ordinary-child\",\"clientMsgId\":\"\(id)\"}"))
        vm.handleMessage(try decode("{\"type\":\"user_message\",\"sessionId\":\"ordinary-child\",\"messageId\":\"\(id)\",\"text\":\"Continue\"}"))
        precondition(vm.sendDraft.pending == nil && vm.sendDraft.text.isEmpty)
        precondition(vm.messages.filter { $0.id == id }.count == 1)
        vm.handleMessage(try decode("{\"type\":\"message_start\",\"sessionId\":\"ordinary-child\",\"messageId\":\"reply\"}"))
        precondition(vm.isStreaming && vm.currentStream?.messageId == "reply")
        vm.handleMessage(try decode("{\"type\":\"block_start\",\"sessionId\":\"ordinary-child\",\"messageId\":\"reply\",\"blockId\":\"text\",\"blockType\":\"text\"}"))
        vm.handleMessage(try decode("{\"type\":\"block_delta\",\"sessionId\":\"ordinary-child\",\"messageId\":\"reply\",\"blockId\":\"text\",\"blockType\":\"text\",\"delta\":\"Reply\"}"))
        vm.handleMessage(try decode("{\"type\":\"message_end\",\"sessionId\":\"ordinary-child\",\"messageId\":\"reply\"}"))
        precondition(vm.messages.last?.text == "Reply" && !vm.isStreaming)
        vm.sendDraft.edit("Next input")
        await vm.send()
        precondition(vm.sendDraft.pending?.sessionId == "ordinary-child")
    }

    @MainActor static func startupRefusalPreservesNewerDraftAndActiveStream() async throws {
        let app = AppState()
        let vm = ChatViewModel(sessionId: "child", appState: app)
        vm.sendDraft.edit("Rejected startup")
        await vm.send()
        let id = try pendingId(vm)
        vm.sendDraft.edit("Newer draft")
        vm.handleMessage(try decode("{\"type\":\"permission_request\",\"permId\":\"retained-permission\",\"toolName\":\"Bash\",\"toolInput\":\"retained input\"}"))
        vm.handleMessage(try decode("{\"type\":\"message_start\",\"sessionId\":\"child\",\"messageId\":\"active\"}"))
        vm.handleMessage(try decode("{\"type\":\"error\",\"sessionId\":\"foreign\",\"clientMsgId\":\"\(id)\",\"error\":\"Foreign\"}"))
        precondition(vm.sendDraft.pending?.clientMsgId == id && vm.sendError == nil)
        vm.handleMessage(try decode("{\"type\":\"error\",\"clientMsgId\":\"\(id)\",\"error\":\"Startup rejected\"}"))
        precondition(vm.sendDraft.pending == nil)
        precondition(vm.sendDraft.text == "Newer draft" && vm.sendDraft.rejectedText == "Rejected startup")
        precondition(vm.sendError == "Startup rejected")
        precondition(!vm.messages.contains { $0.id == id })
        precondition(vm.isStreaming && vm.currentStream?.messageId == "active")
        precondition(vm.permissionRequest?.permId == "retained-permission")
        let count = vm.messages.count
        vm.handleMessage(try decode("{\"type\":\"error\",\"clientMsgId\":\"\(id)\",\"error\":\"Duplicate\"}"))
        precondition(vm.messages.count == count && vm.sendError == "Startup rejected")
    }

    @MainActor static func acceptedInputIsNotRestoredByLaterErrors() async throws {
        let app = AppState()
        let vm = ChatViewModel(sessionId: "child", appState: app)
        vm.sendDraft.edit("Accepted")
        await vm.send()
        let id = try pendingId(vm)
        vm.handleMessage(try decode("{\"type\":\"user_message\",\"sessionId\":\"child\",\"messageId\":\"\(id)\",\"text\":\"Accepted\"}"))
        vm.handleMessage(try decode("{\"type\":\"error\",\"sessionId\":\"child\",\"clientMsgId\":\"\(id)\",\"error\":\"Late\"}"))
        precondition(vm.sendDraft.text.isEmpty && vm.sendDraft.rejectedText == nil && vm.sendError == nil)
        precondition(vm.messages.contains { $0.id == id })
    }

    @MainActor static func assignedStartupFailureRetriesOnlyExplicitlyInNewSession() async throws {
        let app = AppState()
        let vm = ChatViewModel(sessionId: "ended-reasoning", appState: app)
        vm.sendDraft.edit("Forked input")
        await vm.send()
        let id = try pendingId(vm)
        vm.handleMessage(try decode("{\"type\":\"session_id\",\"sessionId\":\"ordinary-child\",\"clientMsgId\":\"\(id)\"}"))
        precondition(vm.sendDraft.pending?.sessionId == "ordinary-child" && !vm.sendDraft.canSubmit)
        vm.sendDraft.edit("Newer draft")
        vm.handleMessage(try decode("{\"type\":\"error\",\"clientMsgId\":\"\(id)\",\"error\":\"Startup rejected\"}"))
        precondition(vm.sendDraft.pending == nil && app.sent.count == 1)
        precondition(vm.sendDraft.text == "Newer draft" && vm.sendDraft.rejectedText == "Forked input")
        precondition(vm.sendError == "Startup rejected" && !vm.messages.contains { $0.id == id })
        vm.handleMessage(try decode("{\"type\":\"session_id\",\"sessionId\":\"ended-reasoning\",\"clientMsgId\":\"\(id)\"}"))
        precondition(vm.sendDraft.text == "Newer draft" && app.sent.count == 1)
        vm.sendDraft.edit("")
        precondition(vm.sendDraft.restoreRejected())
        precondition(app.sent.count == 1) // Restoring is not authorization to dispatch.
        await vm.send() // Explicit operator retry.
        guard case .send(let retry) = app.sent.last else { throw Failure.missingPending }
        precondition(retry.sessionId == "ordinary-child" && retry.clientMsgId != id)
        precondition(retry.prompt == "Forked input" && app.sent.count == 2)
        vm.handleMessage(try decode("{\"type\":\"error\",\"clientMsgId\":\"\(id)\",\"error\":\"Old refusal\"}"))
        vm.handleMessage(try decode("{\"type\":\"session_id\",\"sessionId\":\"ended-reasoning\",\"clientMsgId\":\"\(id)\"}"))
        precondition(vm.sendDraft.pending?.clientMsgId == retry.clientMsgId && vm.sendError == nil)
        vm.handleMessage(try decode("{\"type\":\"user_message\",\"sessionId\":\"ordinary-child\",\"messageId\":\"\(retry.clientMsgId)\",\"text\":\"Forked input\"}"))
        precondition(vm.sendDraft.pending == nil && vm.sendDraft.text.isEmpty)
        precondition(vm.messages.filter { $0.id == retry.clientMsgId }.count == 1)
    }

    struct BackendFixture: Decodable {
        struct Request: Decodable {
            let sessionId: String?
            let clientMsgId: String
            let prompt: String
        }
        let request: Request
        let events: [String]
        let foreignEvents: [String]?
        let sourceCommit: String?
    }

    static func decodeBackendPacket(_ packet: String, fixtureId: String, commandId: String) throws -> ServerMessage {
        var wire = try JSONSerialization.jsonObject(with: Data(packet.utf8)) as! [String: Any]
        // Only correlate the captured request UUID to the UUID from real vm.send().
        // Session IDs, assignment metadata, text and event metadata stay untouched.
        for key in ["clientMsgId", "messageId"] where wire[key] as? String == fixtureId {
            wire[key] = commandId
        }
        let received = try JSONDecoder().decode(ServerMessage.self, from: JSONSerialization.data(withJSONObject: wire))
        return try JSONDecoder().decode(ServerMessage.self, from: JSONEncoder().encode(received))
    }

    @MainActor static func backendStartupRoutesExactEchoAndReply(fixturePath: String, newerEdit: Bool, requireBareAssignment: Bool) async throws {
        let fixture = try JSONDecoder().decode(BackendFixture.self, from: Data(contentsOf: URL(fileURLWithPath: fixturePath)))
        precondition(fixture.request.sessionId == nil && UUID(uuidString: fixture.request.clientMsgId) != nil)
        if requireBareAssignment { precondition(fixture.sourceCommit?.count == 40) }
        let app = AppState()
        let vm = ChatViewModel(sessionId: nil, appState: app)
        vm.sendDraft.edit(fixture.request.prompt)
        await vm.send()
        let id = try pendingId(vm)
        guard case .send(let sent) = app.sent.first else { throw Failure.missingPending }
        let encoded = try JSONEncoder().encode(ClientMessage.send(sent))
        let request = try JSONSerialization.jsonObject(with: encoded) as! [String: Any]
        precondition(request["accountId"] == nil && request["sessionId"] is NSNull)
        precondition(sent.prompt == fixture.request.prompt && UUID(uuidString: id) != nil)
        var sessionId: String?
        var sawAssignment = false
        var sawReply = false
        var expectedReply = ""
        var startupEvents: [ServerMessage] = []
        for packet in fixture.events {
            let relayed = try decodeBackendPacket(packet, fixtureId: fixture.request.clientMsgId, commandId: id)
            startupEvents.append(relayed)
            vm.handleMessage(relayed)
            switch relayed {
            case .sessionId(let assignedSession, _, _, let command):
                precondition(vm.sendDraft.pending?.clientMsgId == id && !vm.sendDraft.canSubmit)
                if let command {
                    precondition(!requireBareAssignment && command == id)
                    precondition(vm.sendDraft.pending?.sessionId == assignedSession)
                } else {
                    precondition(vm.sendDraft.pending?.sessionId == nil)
                }
                sawAssignment = true
                if newerEdit { vm.sendDraft.edit("Newer Watch draft") }
            case .userMessage(let params) where params.messageId == id:
                precondition(sawAssignment)
                sessionId = params.sessionId
                precondition(vm.sendDraft.pending == nil)
                precondition(vm.sendDraft.text == (newerEdit ? "Newer Watch draft" : ""))
                precondition(vm.messages.filter { $0.id == id }.count == 1)
            case .messageStart(let params):
                precondition(params.sessionId == sessionId && vm.isStreaming)
                precondition(vm.currentStream?.messageId == params.messageId)
            case .blockDelta(let params) where params.blockType == .text:
                expectedReply += params.delta
            case .messageEnd(let params):
                precondition(params.sessionId == sessionId && !vm.isStreaming)
                precondition(vm.messages.last?.text == expectedReply)
                sawReply = true
            default: break
            }
        }
        precondition(sawAssignment && sawReply && sessionId != nil && !expectedReply.isEmpty)
        precondition(!vm.isStreaming && vm.currentStream == nil && vm.sendDraft.pending == nil)
        await vm.stop()
        guard case .stop(let stoppedSession) = app.sent.last else { throw Failure.missingPending }
        precondition(stoppedSession == sessionId)
        vm.sendDraft.edit("Explicit next Watch input")
        await vm.send()
        let nextId = try pendingId(vm)
        guard case .send(let next) = app.sent.last else { throw Failure.missingPending }
        precondition(next.sessionId == sessionId && next.clientMsgId == nextId && nextId != id)
        let count = vm.messages.count
        var sawForeignEcho = false
        for packet in fixture.foreignEvents ?? [] {
            let foreign = try decodeBackendPacket(packet, fixtureId: fixture.request.clientMsgId, commandId: nextId)
            guard case .userMessage(let params) = foreign else { continue }
            precondition(params.messageId == nextId && params.sessionId != sessionId)
            vm.handleMessage(foreign)
            precondition(vm.sendDraft.pending?.clientMsgId == nextId && vm.sendDraft.pending?.sessionId == sessionId)
            precondition(vm.sendDraft.text == "Explicit next Watch input" && vm.messages.count == count)
            sawForeignEcho = true
        }
        if fixture.foreignEvents != nil { precondition(sawForeignEcho) }
        for stale in startupEvents {
            switch stale {
            case .sessionId, .userMessage: vm.handleMessage(stale)
            default: break
            }
        }
        precondition(vm.sendDraft.pending?.clientMsgId == nextId && vm.sendDraft.pending?.sessionId == sessionId)
        precondition(vm.sendDraft.text == "Explicit next Watch input" && vm.messages.count == count)
    }

    @MainActor static func foreignTerminalPreservesActiveSelectedStream(fixturePath: String) async throws {
        let fixture = try JSONDecoder().decode(BackendFixture.self, from: Data(contentsOf: URL(fileURLWithPath: fixturePath)))
        let app = AppState()
        let vm = ChatViewModel(sessionId: nil, appState: app)
        vm.sendDraft.edit(fixture.request.prompt)
        await vm.send()
        let id = try pendingId(vm)
        var selectedSession: String?
        var selectedMessage: String?
        for packet in fixture.events {
            let event = try decodeBackendPacket(packet, fixtureId: fixture.request.clientMsgId, commandId: id)
            vm.handleMessage(event)
            if case .messageStart(let params) = event {
                selectedSession = params.sessionId
                selectedMessage = params.messageId
                break
            }
        }
        precondition(selectedSession != nil && selectedMessage != nil && vm.isStreaming)
        // Preserve a current tool indicator while replaying real foreign packets.
        vm.toolStatus = "Running command..."
        let count = vm.messages.count
        let draft = vm.sendDraft.text
        var sawForeignTerminal = false
        for packet in fixture.foreignEvents ?? [] {
            let event = try decodeBackendPacket(packet, fixtureId: fixture.request.clientMsgId, commandId: id)
            if case .sessionEnd(let params) = event {
                precondition(params.sessionId != selectedSession)
                sawForeignTerminal = true
            }
            vm.handleMessage(event)
            precondition(vm.isStreaming && vm.toolStatus == "Running command...")
            precondition(vm.currentStream?.messageId == selectedMessage)
            precondition(vm.messages.count == count && vm.sendDraft.text == draft)
        }
        precondition(sawForeignTerminal)
        // The selected conversation's actual terminal retains its prior behavior.
        var sawSelectedTerminal = false
        for packet in fixture.events {
            let event = try decodeBackendPacket(packet, fixtureId: fixture.request.clientMsgId, commandId: id)
            guard case .sessionEnd(let params) = event else { continue }
            precondition(params.sessionId == selectedSession)
            vm.handleMessage(event)
            precondition(!vm.isStreaming && vm.toolStatus == nil)
            precondition(vm.currentStream?.messageId == selectedMessage)
            precondition(vm.messages.count == count && vm.sendDraft.text == draft)
            sawSelectedTerminal = true
        }
        precondition(sawSelectedTerminal)
    }

    @MainActor static func selectedRuntimeErrorAfterAcceptancePreservesInputAndRouting(fixturePath: String) async throws {
        let fixture = try JSONDecoder().decode(BackendFixture.self, from: Data(contentsOf: URL(fileURLWithPath: fixturePath)))
        let app = AppState()
        let vm = ChatViewModel(sessionId: nil, appState: app)
        vm.sendDraft.edit(fixture.request.prompt)
        await vm.send()
        let id = try pendingId(vm)
        var selectedSession: String?
        var selectedMessage: String?
        for packet in fixture.events {
            let event = try decodeBackendPacket(packet, fixtureId: fixture.request.clientMsgId, commandId: id)
            vm.handleMessage(event)
            if case .messageStart(let params) = event {
                selectedSession = params.sessionId
                selectedMessage = params.messageId
                break
            }
        }
        guard let selectedSession, let selectedMessage else { throw Failure.missingFixture }
        precondition(vm.sendDraft.pending == nil && vm.sendDraft.text.isEmpty && vm.isStreaming)
        vm.sendDraft.edit("Newer Watch draft")
        vm.handleMessage(try decode("{\"type\":\"permission_request\",\"permId\":\"retained-permission\",\"toolName\":\"Bash\",\"toolInput\":\"retained input\"}"))
        let count = vm.messages.count
        vm.handleMessage(try decode("{\"type\":\"error\",\"sessionId\":\"foreign-session\",\"error\":\"Foreign runtime failure\"}"))
        vm.handleMessage(try decode("{\"type\":\"error\",\"sessionId\":\"old-reasoning-session\",\"error\":\"Old runtime failure\"}"))
        vm.handleMessage(try decode("{\"type\":\"error\",\"sessionId\":\"\(selectedSession)\",\"clientMsgId\":\"\(id)\",\"error\":\"Late accepted startup error\"}"))
        vm.handleMessage(try decode("{\"type\":\"error\",\"clientMsgId\":\"\(id)\",\"error\":\"Late unscoped startup error\"}"))
        precondition(vm.messages.count == count && vm.sendError == nil)
        vm.handleMessage(try decode("{\"type\":\"error\",\"sessionId\":\"\(selectedSession)\",\"error\":\"Provider overloaded\"}"))
        precondition(vm.sendError == "Provider overloaded")
        precondition(vm.messages.count == count + 1 && vm.messages.last?.text == "Error: Provider overloaded")
        precondition(vm.messages.filter { $0.id == id }.count == 1)
        precondition(vm.sendDraft.pending == nil && vm.sendDraft.rejectedText == nil && vm.sendDraft.text == "Newer Watch draft")
        precondition(vm.isStreaming && vm.currentStream?.messageId == selectedMessage)
        precondition(vm.permissionRequest?.permId == "retained-permission")
        var foreignTerminals = 0
        for packet in fixture.foreignEvents ?? [] {
            let event = try decodeBackendPacket(packet, fixtureId: fixture.request.clientMsgId, commandId: id)
            guard case .sessionEnd = event else { continue }
            vm.handleMessage(event)
            foreignTerminals += 1
            precondition(vm.isStreaming)
        }
        precondition(foreignTerminals == 1)
        var selectedTerminals = 0
        for packet in fixture.events {
            let event = try decodeBackendPacket(packet, fixtureId: fixture.request.clientMsgId, commandId: id)
            guard case .sessionEnd = event else { continue }
            vm.handleMessage(event)
            selectedTerminals += 1
        }
        precondition(selectedTerminals == 1)
        precondition(!vm.isStreaming && vm.sendDraft.text == "Newer Watch draft" && vm.sendDraft.rejectedText == nil)
        await vm.stop()
        guard case .stop(let stoppedSession) = app.sent.last else { throw Failure.missingPending }
        precondition(stoppedSession == selectedSession)
        await vm.send()
        guard case .send(let next) = app.sent.last else { throw Failure.missingPending }
        precondition(next.sessionId == selectedSession && next.clientMsgId != id && next.prompt == "Newer Watch draft")
        precondition(vm.sendError == nil && vm.sendDraft.pending?.clientMsgId == next.clientMsgId)
        precondition(vm.permissionRequest?.permId == "retained-permission")
        vm.handleMessage(try decode("{\"type\":\"error\",\"sessionId\":\"\(selectedSession)\",\"error\":\"Runtime failed while delivery remains uncertain\"}"))
        precondition(vm.sendError == "Runtime failed while delivery remains uncertain")
        precondition(vm.sendDraft.pending?.clientMsgId == next.clientMsgId && vm.sendDraft.rejectedText == nil)
        precondition(vm.sendDraft.text == "Newer Watch draft" && app.sent.count == 3)
        precondition(vm.permissionRequest?.permId == "retained-permission")
    }

    enum Failure: Error { case missingPending, missingFixture }
}
