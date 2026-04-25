// Session list — recent sessions + new session button

import SwiftUI
import MitzoShared

struct SessionListView: View {
    @EnvironmentObject var appState: AppState

    var body: some View {
        NavigationStack {
            List {
                // New session
                NavigationLink {
                    ChatView(sessionId: nil)
                        .environmentObject(appState)
                } label: {
                    Label("New Session", systemImage: "plus.bubble")
                        .foregroundStyle(.blue)
                }

                // Existing sessions
                ForEach(appState.sessions) { session in
                    NavigationLink {
                        ChatView(sessionId: session.id)
                            .environmentObject(appState)
                    } label: {
                        SessionRow(session: session)
                    }
                }
            }
            .navigationTitle("Mitzo")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    connectionIndicator
                }
            }
        }
        .task {
            await appState.loadSessions()
        }
    }

    @ViewBuilder
    private var connectionIndicator: some View {
        switch appState.connectionState {
        case .connected:
            Circle()
                .fill(.green)
                .frame(width: 8, height: 8)
        case .connecting, .reconnecting:
            ProgressView()
                .scaleEffect(0.5)
        case .disconnected:
            Circle()
                .fill(.red)
                .frame(width: 8, height: 8)
        }
    }
}

// MARK: - Session Row

struct SessionRow: View {
    let session: SessionSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(session.branch ?? session.id.prefix(8).description)
                .font(.caption)
                .lineLimit(1)

            HStack {
                Text(session.mode.rawValue)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 1)
                    .background(.quaternary)
                    .clipShape(Capsule())

                if let ts = session.updatedAt {
                    Text(timeAgo(ts))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private func timeAgo(_ timestamp: Int) -> String {
        let date = Date(timeIntervalSince1970: TimeInterval(timestamp) / 1000)
        let interval = Date().timeIntervalSince(date)

        if interval < 60 { return "now" }
        if interval < 3600 { return "\(Int(interval / 60))m ago" }
        if interval < 86400 { return "\(Int(interval / 3600))h ago" }
        return "\(Int(interval / 86400))d ago"
    }
}
