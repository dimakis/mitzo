// Session list — recent sessions + new session button

import SwiftUI
import MitzoShared

struct SessionListView: View {
    @EnvironmentObject var appState: AppState
    @EnvironmentObject var notificationDelegate: WatchNotificationDelegate

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
        .sheet(item: $notificationDelegate.destination) { destination in
            NavigationStack {
                WatchNotificationDestinationView(destination: destination)
                    .environmentObject(appState)
            }
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

/// Load by ID rather than searching a capped feed. An old push must never open
/// a different request or disappear merely because newer items arrived.
struct WatchNotificationDestinationView: View {
    @EnvironmentObject var appState: AppState
    let destination: WatchNotificationDestination
    var onResolved: ((String) -> Void)? = nil
    @State private var item: MitzoNotification?
    @State private var error: String?
    @State private var replySent = false
    @State private var replyAttempted = false

    var body: some View {
        Group {
            switch destination {
            case .notification(let id):
                if let item {
                    WatchNotificationDetail(item: item, onDecision: { decision, answers in
                        try await appState.respondNotification(item, decision: decision, answers: answers)
                        if let permId = item.request?.permId { onResolved?(permId) }
                    }).environmentObject(appState)
                } else {
                    VStack {
                        if let error {
                            Text(error).font(.caption)
                            Button("Retry") { Task { await load(id: id) } }
                        } else { ProgressView() }
                    }.task { await load(id: id) }
                }
            case .session(let id):
                ChatView(sessionId: id).environmentObject(appState)
            case .reply(let id, let text):
                if replySent {
                    ChatView(sessionId: id).environmentObject(appState)
                } else {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Your reply").font(.headline)
                        Text(text).font(.caption)
                        if let error {
                            Text(error).font(.caption).foregroundStyle(.orange)
                            NavigationLink("Open session") {
                                ChatView(sessionId: id).environmentObject(appState)
                            }
                        } else { ProgressView("Sending…") }
                    }.task {
                        guard !replyAttempted else { return }
                        replyAttempted = true
                        do { try await appState.replyToNotification(sessionID: id, text: text); replySent = true }
                        catch { self.error = "Reply could not be confirmed. Check the session before sending again." }
                    }
                }
            }
        }
    }

    @MainActor private func load(id: String) async {
        error = nil
        do {
            let current = try await appState.loadNotification(id: id)
            guard current.id == id else { throw MitzoAPIClient.APIError.invalidResponse }
            item = current
            if !current.isActionable(), let permId = current.request?.permId { onResolved?(permId) }
        }
        catch { self.error = "Cannot load this request. Check your iPhone connection and retry." }
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
                        WatchNotificationDetail(item: item, onDecision: { decision, answers in
                            try await appState.respondNotification(item, decision: decision, answers: answers)
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
    let onDecision: (NotificationResponse.Decision, [String: [String]]?) async throws -> Void
    @State private var busy = false
    @State private var error: String?
    @State private var choices: [String: [String]] = [:]
    @State private var freeform: [String: String] = [:]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                Text(item.title).font(.headline)
                Text(item.body).font(.caption)
                if item.request?.reviewKind == "telos_source" {
                    WatchSourceApproval(item: item, busy: $busy).environmentObject(appState)
                }
                if let request = item.request {
                    if let description = request.description { Text(description).font(.caption) }
                    if let questions = request.questions, !questions.isEmpty {
                        ForEach(questions) { question in
                            WatchQuestionInput(question: question,
                                selection: Binding(get: { choices[question.id] ?? [] }, set: { choices[question.id] = $0 }),
                                freeform: Binding(get: { freeform[question.id] ?? "" }, set: { freeform[question.id] = $0 }))
                                .disabled(busy)
                        }
                    } else if request.reviewKind == nil, !request.toolInput.isEmpty {
                        Text(request.toolInput).font(.system(.caption2, design: .monospaced))
                    }
                }
                if let error { Text(error).font(.caption).foregroundStyle(.orange) }
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    if item.isActionable(at: context.date.timeIntervalSince1970 * 1000) {
                        if let questions = item.request?.questions, !questions.isEmpty {
                            Button("Submit answers") { respond(.once, answers: questionAnswers) }
                                .disabled(busy || !validNotificationAnswers(questionAnswers, questions: questions))
                        } else if item.kind == "approval", let request = item.request, request.reviewKind == nil {
                            Text(request.allowSessionGrant == false
                                 ? "Allow once covers this request."
                                 : request.sessionGrantDescription ?? (request.approvalScope == .conversation
                                     ? "This access stays with the conversation until revoked or its sandbox is deleted."
                                     : "Allow for session keeps this approval until the session ends.")).font(.caption2)
                            if request.approvalScope != .conversation {
                                Button("Allow once") { respond(.once) }.disabled(busy)
                            }
                            if request.allowSessionGrant != false {
                                Button(request.approvalScope == .conversation ? "Grant to conversation" : "Allow for session") { respond(.session) }.disabled(busy)
                            }
                        } else if item.request?.reviewKind != "telos_source" {
                            Text("Review this request on your iPhone.").font(.caption)
                        }
                        Button(item.request?.questions == nil ? "Deny" : "Cancel", role: item.request?.questions == nil ? .destructive : .cancel) { respond(.deny) }.disabled(busy)
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

    private var questionAnswers: [String: [String]] {
        Dictionary(uniqueKeysWithValues: (item.request?.questions ?? []).map { question in
            let text = (freeform[question.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let selected = choices[question.id] ?? []
            return (question.id, text.isEmpty ? selected : question.multiSelect == true ? selected + [text] : [text])
        })
    }

    private func respond(_ decision: NotificationResponse.Decision, answers: [String: [String]]? = nil) {
        busy = true
        Task { @MainActor in
            defer { busy = false }
            do { try await onDecision(decision, answers); dismiss() }
            catch { self.error = "Request changed or iPhone unavailable. Go back and refresh." }
        }
    }
}

/// Native controls support touch, VoiceOver, dictation and secure text entry.
struct WatchQuestionInput: View {
    let question: NotificationQuestion
    @Binding var selection: [String]
    @Binding var freeform: String

    var body: some View {
        VStack(alignment: .leading) {
            Text(question.question).font(.caption).bold()
            ForEach(question.options, id: \.label) { option in
                Button {
                    if question.multiSelect == true {
                        if selection.contains(option.label) { selection.removeAll { $0 == option.label } }
                        else { selection.append(option.label) }
                    } else {
                        selection = [option.label]
                        freeform = ""
                    }
                } label: {
                    VStack(alignment: .leading) {
                        Label(option.label, systemImage: selection.contains(option.label) ? "checkmark.circle.fill" : "circle")
                        if let description = option.description { Text(description).font(.caption2) }
                    }
                }
                .accessibilityAddTraits(selection.contains(option.label) ? .isSelected : [])
            }
            if question.allowFreeform != false {
                if question.isSecret == true { SecureField("Your answer", text: $freeform) }
                else { TextField("Your answer", text: $freeform) }
            }
        }
        .onChange(of: freeform) { _, text in
            if question.multiSelect != true, !text.isEmpty { selection = [] }
        }
    }
}

/// Telos keeps its source-selection/preview receipt owner on every device.
struct WatchSourceApproval: View {
    @EnvironmentObject var appState: AppState
    @Environment(\.dismiss) private var dismiss
    let item: MitzoNotification
    @Binding var busy: Bool
    @State private var review: WatchSourceReview?
    @State private var messages: Set<String> = []
    @State private var artifacts: Set<String> = []
    @State private var prepared: WatchSourceInput?
    @State private var previewText: String?
    @State private var attempted = false
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading) {
            if let error { Text(error).font(.caption).foregroundStyle(.orange) }
            if let review {
                Text("Proposal").font(.headline)
                Text(review.operation.readable).font(.caption)
                if let previewText {
                    Text("Selected source and proposal").font(.headline)
                    Text(previewText).font(.caption)
                    Button(attempted ? "Retry same save" : "Approve and save") { save() }.disabled(busy)
                    if !attempted { Button("Change selection") { prepared = nil; self.previewText = nil }.disabled(busy) }
                } else {
                    Text("Choose the original exchange to retain").font(.caption)
                    ForEach(review.messages) { message in
                        Toggle(isOn: Binding(get: { messages.contains(message.id) }, set: { value in
                            if value { messages.insert(message.id) } else { messages.remove(message.id) }
                        })) {
                            VStack(alignment: .leading) {
                                Text(message.author.readable).font(.caption2)
                                ForEach(Array(message.blocks.enumerated()), id: \.offset) { _, block in Text(block.content).font(.caption) }
                                if let reason = message.unavailableReason { Text(reason).font(.caption2) }
                            }
                        }.disabled(busy || message.unavailableReason != nil)
                    }
                    ForEach(review.artifacts) { artifact in
                        Toggle(isOn: Binding(get: { artifacts.contains(artifact.id) }, set: { value in
                            if value { artifacts.insert(artifact.id) } else { artifacts.remove(artifact.id) }
                        })) {
                            Text("\(artifact.title) · \(artifact.filename) · version \(artifact.revision)").font(.caption)
                        }.disabled(busy)
                    }
                    if let before = review.earlierCursor {
                        Button("Earlier exchange") { load(before: before) }.disabled(busy)
                    }
                    Button("Latest exchange") { load() }.disabled(busy)
                    Button("Preview selection") { preview() }.disabled(busy || messages.isEmpty)
                }
            } else if busy { ProgressView() }
            else { Button("Load source review") { load() } }
        }
        .task { if review == nil { load() } }
    }

    private func load(before: Int? = nil) {
        busy = true
        error = nil
        Task { @MainActor in
            defer { busy = false }
            do {
                let current = try await appState.sourceReview(item, before: before)
                review = current
                messages = []
                artifacts = []
                if let recovery = current.recovery {
                    if recovery.receipt != nil { dismiss(); return }
                    guard let input = current.restoredApproval else { throw MitzoAPIClient.APIError.invalidResponse }
                    prepared = input
                    previewText = recovery.preview.packet.readable
                    attempted = true
                }
            } catch { self.error = "Source review unavailable. Refresh before trying again." }
        }
    }
    private func preview() {
        guard let review else { return }
        busy = true
        error = nil
        Task { @MainActor in
            defer { busy = false }
            do {
                let input = try review.selection(messageIDs: messages, artifactIDs: artifacts)
                let response = try await appState.sourcePreview(permId: review.permId, input: input)
                guard let approval = response.approval(for: review, input: input) else { throw MitzoAPIClient.APIError.invalidResponse }
                prepared = approval
                previewText = response.preview.packet.readable
            } catch { self.error = "Source changed or unavailable. Reload and select again." }
        }
    }
    private func save() {
        guard let review, let prepared, !busy else { return }
        attempted = true
        busy = true
        error = nil
        Task { @MainActor in
            defer { busy = false }
            do {
                _ = try await appState.sourceApprove(permId: review.permId, input: prepared)
                dismiss()
            } catch { self.error = "Save could not be confirmed. Retry the same save to recover its receipt." }
        }
    }
}
