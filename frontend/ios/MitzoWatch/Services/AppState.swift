// Central app state — owns auth, WS connection, and session state

import SwiftUI
import MitzoShared

@MainActor
final class AppState: ObservableObject {
    @Published var isAuthenticated = false
    @Published var connectionState: MitzoWSClient.State = .disconnected
    @Published var sessions: [SessionSummary] = []
    @Published var error: String?

    private let authManager = AuthManager()
    private var wsClient: MitzoWSClient?
    private var apiClient: MitzoAPIClient?

    // Server URL — configure per environment
    var serverURL: URL {
        // Default to Tailscale hostname; override via environment or settings
        URL(string: "https://mitzo.tail:3100")!
    }

    init() {
        Task {
            await checkAuth()
        }
    }

    // MARK: - Auth

    func checkAuth() async {
        isAuthenticated = await authManager.isAuthenticated()
        if isAuthenticated {
            await connect()
        }
    }

    func login(passphrase: String) async {
        do {
            _ = try await authManager.login(passphrase: passphrase, serverURL: serverURL)
            isAuthenticated = true
            await connect()
        } catch {
            self.error = "Login failed"
        }
    }

    // MARK: - Connection

    func connect() async {
        guard let token = try? await authManager.getToken() else { return }

        var components = URLComponents(url: serverURL.appendingPathComponent("/ws"), resolvingAgainstBaseURL: false)!
        components.scheme = components.scheme == "https" ? "wss" : "ws"
        components.queryItems = [URLQueryItem(name: "token", value: token)]

        guard let wsURL = components.url else { return }

        let client = MitzoWSClient(url: wsURL)
        wsClient = client

        apiClient = MitzoAPIClient(baseURL: serverURL, authManager: authManager)

        await client.connect { [weak self] event in
            Task { @MainActor in
                self?.handleWSEvent(event)
            }
        }

        await loadSessions()
    }

    func suspend() async {
        guard let client = wsClient else { return }
        let sessions = await client.getSuspendSessions()
        if !sessions.isEmpty {
            try? await client.suspend(sessions: sessions)
        }
    }

    func reconnect() async {
        // Handled automatically by MitzoWSClient
    }

    // MARK: - Sessions

    func loadSessions() async {
        do {
            let fetched: [Session] = try await apiClient?.getSessions() ?? []
            sessions = fetched.map { SessionSummary(from: $0) }
        } catch {
            self.error = "Failed to load sessions"
        }
    }

    // MARK: - Event Handling

    private func handleWSEvent(_ event: MitzoWSClient.Event) {
        switch event {
        case .stateChanged(let state):
            connectionState = state

        case .message:
            // Forwarded to active ChatViewModel
            break

        case .error(let err):
            error = err.localizedDescription
        }
    }

    // MARK: - Accessors

    func getWSClient() -> MitzoWSClient? { wsClient }
    func getAPIClient() -> MitzoAPIClient? { apiClient }
}

// MARK: - Session Summary

struct SessionSummary: Identifiable {
    let id: String
    let mode: MitzoMode
    let branch: String?
    let updatedAt: Int?

    init(from session: Session) {
        self.id = session.id
        self.mode = session.mode
        self.branch = session.branch
        self.updatedAt = session.updatedAt
    }
}
