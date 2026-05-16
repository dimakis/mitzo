// Chat view model — manages a single session's message stream

import SwiftUI
import MitzoShared

@MainActor
final class ChatViewModel: ObservableObject {
    @Published var messages: [ChatMessage] = []
    @Published var currentStream: StreamingMessage?
    @Published var isStreaming = false
    @Published var permissionRequest: PermissionRequestParams?
    @Published var toolStatus: String?

    let sessionId: String?
    private var resolvedSessionId: String?
    private(set) weak var appState: AppState?

    init(sessionId: String?, appState: AppState? = nil) {
        self.sessionId = sessionId
        self.resolvedSessionId = sessionId
        self.appState = appState
    }

    func configure(appState: AppState) {
        self.appState = appState
        appState.setActiveChatVM(self)
    }

    deinit {
        // Can't call appState methods from deinit in actor context,
        // but weak reference means AppState won't retain us
    }

    // MARK: - Load History

    func loadHistory() async {
        guard let sessionId = resolvedSessionId,
              let appState else { return }

        do {
            let finished = try await appState.loadMessages(sessionId: sessionId)
            messages = finished.map { ChatMessage(from: $0) }
        } catch {
            print("[Watch] loadHistory failed: \(error)")
        }

        // Watch this session for live updates
        try? await appState.sendMessage(.watch(sessionId: sessionId))
    }

    // MARK: - Send Message

    func send(text: String) async {
        guard let appState else { return }

        let userMsg = ChatMessage(role: .user, text: text)
        messages.append(userMsg)

        let params = SendParams(
            sessionId: resolvedSessionId,
            prompt: text
        )

        do {
            try await appState.sendMessage(.send(params))
            isStreaming = true
        } catch {
            let errorMsg = ChatMessage(role: .assistant, text: "Send failed: \(error.localizedDescription)")
            messages.append(errorMsg)
        }
    }

    // MARK: - Permission

    func respondToPermission(decision: PermissionDecision) async {
        guard let perm = permissionRequest,
              let appState else { return }

        let params = PermissionResponseParams(
            sessionId: resolvedSessionId,
            permId: perm.permId,
            decision: decision
        )

        try? await appState.sendMessage(.permissionResponse(params))
        permissionRequest = nil
    }

    // MARK: - Stop

    func stop() async {
        guard let sessionId = resolvedSessionId,
              let appState else { return }

        try? await appState.sendMessage(.stop(sessionId: sessionId))
    }

    // MARK: - Process Server Messages

    func handleMessage(_ message: ServerMessage) {
        switch message {
        case .sessionId(let sid, _, _):
            resolvedSessionId = sid

        case .messageStart(let params):
            guard params.sessionId == resolvedSessionId else { return }
            currentStream = StreamingMessage(messageId: params.messageId)
            isStreaming = true
            toolStatus = nil

        case .blockStart(let params):
            guard params.sessionId == resolvedSessionId,
                  var stream = currentStream else { return }

            var block = StreamingBlock(
                blockId: params.blockId,
                blockType: params.blockType,
                toolName: params.toolName
            )
            stream.blocks[params.blockId] = block
            stream.blockOrder.append(params.blockId)
            currentStream = stream

            // Update tool status
            if params.blockType == .toolUse, let name = params.toolName {
                toolStatus = formatToolStatus(name)
            } else if params.blockType == .thinking {
                toolStatus = "Thinking..."
            }

        case .blockDelta(let params):
            guard params.sessionId == resolvedSessionId,
                  var stream = currentStream,
                  var block = stream.blocks[params.blockId] else { return }

            block.content += params.delta
            stream.blocks[params.blockId] = block
            currentStream = stream

        case .blockEnd(let params):
            guard params.sessionId == resolvedSessionId,
                  var stream = currentStream,
                  var block = stream.blocks[params.blockId] else { return }

            block.done = true
            if let toolName = params.toolName { block.toolName = toolName }
            if let toolId = params.toolId { block.toolId = toolId }
            if let input = params.input { block.toolInput = input }
            stream.blocks[params.blockId] = block
            currentStream = stream

        case .messageEnd(let params):
            guard params.sessionId == resolvedSessionId else { return }

            // Finalize streaming message into messages array
            if let stream = currentStream {
                let chatMsg = ChatMessage(from: stream)
                messages.append(chatMsg)
            }
            currentStream = nil
            isStreaming = false
            toolStatus = nil

        case .sessionEnd:
            isStreaming = false
            toolStatus = nil

        case .permissionRequest(let params):
            permissionRequest = params

        case .toolResult(let params):
            // Update the block with tool result if we're tracking it
            if var stream = currentStream,
               var block = stream.blocks.values.first(where: { $0.toolId == params.toolId }) {
                block.toolResult = params.result
                block.toolError = params.isError
                stream.blocks[block.blockId] = block
                currentStream = stream
            }

        default:
            break
        }
    }

    // MARK: - Helpers

    private func formatToolStatus(_ toolName: String) -> String {
        switch toolName {
        case "Read": return "Reading file..."
        case "Write": return "Writing file..."
        case "Edit": return "Editing..."
        case "Bash": return "Running command..."
        case "Grep": return "Searching..."
        case "Glob": return "Finding files..."
        case "Agent": return "Delegating..."
        default: return toolName
        }
    }
}

// MARK: - Chat Message Model

struct ChatMessage: Identifiable {
    let id = UUID()
    let role: MessageRole
    let text: String
    let blocks: [ChatBlock]
    let timestamp: Date

    init(role: MessageRole, text: String) {
        self.role = role
        self.text = text
        self.blocks = [ChatBlock(type: .text, content: text)]
        self.timestamp = Date()
    }

    init(from finished: FinishedMessage) {
        self.role = finished.role
        self.blocks = finished.blocks.map { ChatBlock(from: $0) }
        self.text = blocks.first(where: { $0.type == .text })?.content ?? ""
        if let ts = finished.timestamp {
            self.timestamp = Date(timeIntervalSince1970: TimeInterval(ts) / 1000)
        } else {
            self.timestamp = Date()
        }
    }

    init(from streaming: StreamingMessage) {
        self.role = .assistant
        self.blocks = streaming.blockOrder.compactMap { id in
            guard let block = streaming.blocks[id] else { return nil }
            return ChatBlock(from: block)
        }
        self.text = blocks.first(where: { $0.type == .text })?.content ?? ""
        self.timestamp = Date()
    }
}

struct ChatBlock: Identifiable {
    let id = UUID()
    let type: BlockType
    let content: String
    let toolName: String?

    init(type: BlockType, content: String, toolName: String? = nil) {
        self.type = type
        self.content = content
        self.toolName = toolName
    }

    init(from finished: FinishedBlock) {
        self.type = finished.blockType
        self.content = finished.content
        self.toolName = finished.toolName
    }

    init(from streaming: StreamingBlock) {
        self.type = streaming.blockType
        self.content = streaming.content
        self.toolName = streaming.toolName
    }
}
