// Session list — recent sessions + new session button

import SwiftUI
import MitzoShared

struct SessionListView: View {
    @EnvironmentObject var appState: AppState

    var body: some View {
        NavigationStack {
            List {
                NavigationLink {
                    WatchNotificationsView().environmentObject(appState)
                } label: {
                    Label("Notifications", systemImage: "bell")
                }
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
            await appState.refreshSessions()
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
    let session: Session

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(session.summary)
                .font(.caption)
                .lineLimit(1)

            HStack {
                if session.isActive == true {
                    Text("active")
                        .font(.caption2)
                        .foregroundStyle(.white)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 1)
                        .background(.green)
                        .clipShape(Capsule())
                }

                if let branch = session.branch {
                    Text(branch)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }

                Spacer()

                Text(timeAgo(session.lastModified))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
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


// The paired iPhone owns the authenticated REST connection.
struct WatchNotificationsView: View {
    @EnvironmentObject var appState: AppState
    @State private var feed: NotificationFeed?
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        List {
            if let error { Text(error).font(.caption).foregroundStyle(.orange) }
            Button("Refresh") { Task { await refresh() } }.disabled(busy)
            if let feed {
                Text("\(feed.needsYou) need you").font(.headline)
                if feed.items.isEmpty { Text("You're all caught up") }
                ForEach(feed.items) { item in
                    NavigationLink {
                        WatchNotificationDetail(item: item, onDecision: { decision in
                            try await appState.respondNotification(item, decision: decision)
                            await refresh()
                        }).environmentObject(appState)
                    } label: {
                        VStack(alignment: .leading) {
                            Text(item.title).font(.caption).bold()
                            Text(item.isActionable() ? "Needs you" : item.resolution ?? "Update")
                                .font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                }
                if feed.total > feed.items.count {
                    Text("Latest 10. Full history on iPhone.").font(.caption2)
                }
            } else if error == nil { ProgressView() }
        }
        .navigationTitle("Notifications")
        .task { await refresh() }
    }

    @MainActor private func refresh() async {
        busy = true
        defer { busy = false }
        do { feed = try await appState.loadNotifications(); error = nil }
        catch { self.error = "Cannot load notifications. Open Mitzo on your iPhone and retry." }
    }
}

struct WatchNotificationDetail: View {
    @EnvironmentObject var appState: AppState
    @Environment(\.dismiss) private var dismiss
    let item: MitzoNotification
    let onDecision: (NotificationResponse.Decision) async throws -> Void
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                Text(item.title).font(.headline)
                Text(item.body).font(.caption)
                if let request = item.request {
                    if let description = request.description { Text(description).font(.caption) }
                    if let questions = request.questions, !questions.isEmpty {
                        ForEach(questions) { question in
                            VStack(alignment: .leading, spacing: 6) {
                                Text(question.question).font(.caption).bold()
                                ForEach(question.options, id: \.label) { option in
                                    Text(option.label).font(.caption)
                                    if let description = option.description {
                                        Text(description).font(.caption2).foregroundStyle(.secondary)
                                    }
                                }
                            }
                        }
                    } else if !request.toolInput.isEmpty {
                        Text(request.toolInput).font(.system(.caption2, design: .monospaced))
                    }
                }
                if let error { Text(error).font(.caption).foregroundStyle(.orange) }
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    if item.isActionable(at: context.date.timeIntervalSince1970 * 1000) {
                        if item.kind == "approval" && item.request?.approvalScope != .conversation {
                            Text("Applies to this request only.").font(.caption2)
                            Button("Allow once") { respond(.once) }.disabled(busy)
                        } else {
                            Text("Review this request on your iPhone.").font(.caption)
                        }
                        Button("Deny", role: .destructive) { respond(.deny) }.disabled(busy)
                    } else if item.request != nil {
                        Text(item.resolution ?? "Request expired").font(.caption)
                    }
                }
                if let id = item.sessionId {
                    NavigationLink("Open session") {
                        ChatView(sessionId: id).environmentObject(appState)
                    }
                }
            }.padding(.horizontal, 4)
        }
        .navigationTitle("Details")
    }

    private func respond(_ decision: NotificationResponse.Decision) {
        busy = true
        Task { @MainActor in
            defer { busy = false }
            do { try await onDecision(decision); dismiss() }
            catch { self.error = "Request changed or iPhone unavailable. Go back and refresh." }
        }
    }
}
