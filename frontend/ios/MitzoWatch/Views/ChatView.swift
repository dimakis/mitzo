// Chat view — streaming messages + voice input

import SwiftUI
import MitzoShared

struct ChatView: View {
    @EnvironmentObject var appState: AppState
    @StateObject private var viewModel: ChatViewModel
    @StateObject private var voiceService = VoiceService()
    @State private var scrollProxy: ScrollViewProxy?

    init(sessionId: String?) {
        _viewModel = StateObject(wrappedValue: ChatViewModel(sessionId: sessionId))
    }

    var body: some View {
        VStack(spacing: 0) {
            // Message stream
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 8) {
                        ForEach(viewModel.messages) { message in
                            MessageBubble(message: message)
                                .id(message.id)
                        }

                        // Live streaming content
                        if let stream = viewModel.currentStream {
                            StreamingBubble(stream: stream)
                                .id("streaming")
                        }

                        // Tool status pill
                        if let status = viewModel.toolStatus {
                            ToolPill(status: status)
                                .id("tool")
                        }
                    }
                    .padding(.horizontal, 4)
                    .padding(.bottom, 8)
                }
                .onChange(of: viewModel.messages.count) { _, _ in
                    withAnimation {
                        proxy.scrollTo("streaming", anchor: .bottom)
                    }
                }
                .onAppear { scrollProxy = proxy }
            }

            // Permission banner
            if let perm = viewModel.permissionRequest {
                PermissionBanner(
                    request: perm,
                    onAllow: {
                        Task { await viewModel.respondToPermission(decision: .once) }
                    },
                    onDeny: {
                        Task { await viewModel.respondToPermission(decision: .deny) }
                    }
                )
            }

            Divider()

            // Voice input bar
            VoiceInputBar(voiceService: voiceService) { transcript in
                Task { await viewModel.send(text: transcript) }
            }
        }
        .navigationTitle(viewModel.sessionId?.prefix(6).description ?? "New")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if viewModel.isStreaming {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        Task { await viewModel.stop() }
                    } label: {
                        Image(systemName: "stop.fill")
                            .foregroundStyle(.red)
                            .font(.caption2)
                    }
                }
            }
        }
        .task {
            viewModel.configure(appState: appState)
            await viewModel.loadHistory()
        }
    }
}

// MARK: - Message Bubble

struct MessageBubble: View {
    let message: ChatMessage

    var body: some View {
        HStack {
            if message.role == .user { Spacer(minLength: 20) }

            VStack(alignment: .leading, spacing: 4) {
                ForEach(message.blocks) { block in
                    switch block.type {
                    case .text:
                        Text(block.content)
                            .font(.caption)

                    case .thinking:
                        Text("Thinking...")
                            .font(.caption2)
                            .italic()
                            .foregroundStyle(.secondary)

                    case .toolUse:
                        Label(
                            block.toolName ?? "Tool",
                            systemImage: "gearshape"
                        )
                        .font(.caption2)
                        .foregroundStyle(.secondary)

                    case .redactedThinking:
                        EmptyView()
                    }
                }
            }
            .padding(8)
            .background(message.role == .user ? Color.blue.opacity(0.3) : Color.gray.opacity(0.2))
            .clipShape(RoundedRectangle(cornerRadius: 10))

            if message.role == .assistant { Spacer(minLength: 20) }
        }
    }
}

// MARK: - Streaming Bubble

struct StreamingBubble: View {
    let stream: StreamingMessage

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 4) {
                ForEach(stream.blockOrder, id: \.self) { blockId in
                    if let block = stream.blocks[blockId] {
                        switch block.blockType {
                        case .text:
                            Text(block.content)
                                .font(.caption)
                            + Text(block.done ? "" : " ▊")
                                .font(.caption)
                                .foregroundColor(.blue)

                        case .thinking:
                            HStack(spacing: 4) {
                                ProgressView()
                                    .scaleEffect(0.4)
                                Text("Thinking...")
                                    .font(.caption2)
                                    .italic()
                                    .foregroundStyle(.secondary)
                            }

                        case .toolUse:
                            Label(
                                block.toolName ?? "Tool",
                                systemImage: "gearshape"
                            )
                            .font(.caption2)
                            .foregroundStyle(.orange)

                        case .redactedThinking:
                            EmptyView()
                        }
                    }
                }
            }
            .padding(8)
            .background(Color.gray.opacity(0.2))
            .clipShape(RoundedRectangle(cornerRadius: 10))

            Spacer(minLength: 20)
        }
    }
}

// MARK: - Tool Pill

struct ToolPill: View {
    let status: String

    var body: some View {
        HStack(spacing: 4) {
            ProgressView()
                .scaleEffect(0.4)
            Text(status)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(.quaternary)
        .clipShape(Capsule())
    }
}
