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
        try await forkRoutesEchoAndReply()
        try await startupRefusalPreservesNewerDraftAndActiveStream()
        try await acceptedInputIsNotRestoredByLaterErrors()
        print("3 offline Watch view-model receipt cases passed")
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

    enum Failure: Error { case missingPending }
}
