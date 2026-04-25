// Central app state — owns auth, WS connection, and session state

import SwiftUI
import MitzoShared

@MainActor
final class AppState: ObservableObject {
    @Published var isAuthenticated = false
    @Published var connectionState: MitzoWSClient.State = .disconnected
    @Published var sessions: [Session] = []
    @Published var error: String?

    private let authManager = AuthManager()
    private var wsClient: MitzoWSClient?
    private var apiClient: MitzoAPIClient?
    private var activeChatVM: ChatViewModel?

    // Configurable via UserDefaults; defaults to Tailscale hostname
    var serverURL: URL {
        let stored = UserDefaults.standard.string(forKey: "mitzo_server_url")
        return URL(string: stored ?? "https://mitzo.tail:3100")!
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

        // WS path is /ws/chat, not /ws
        var components = URLComponents(url: serverURL, resolvingAgainstBaseURL: false)!
        components.scheme = components.scheme == "https" ? "wss" : "ws"
        components.path = "/ws/chat"
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

    // MARK: - Sessions

    func loadSessions() async {
        do {
            let response: SessionsResponse = try await apiClient?.getSessions() ?? SessionsResponse(sessions: [], hasMore: false)
            sessions = response.sessions
        } catch {
            self.error = "Failed to load sessions"
        }
    }

    // MARK: - Active Chat

    func setActiveChatVM(_ vm: ChatViewModel?) {
        activeChatVM = vm
    }

    // MARK: - Event Handling

    private func handleWSEvent(_ event: MitzoWSClient.Event) {
        switch event {
        case .stateChanged(let state):
            connectionState = state

        case .message(let msg):
            // Forward to active ChatViewModel
            activeChatVM?.handleMessage(msg)

        case .error(let err):
            error = err.localizedDescription
        }
    }

    // MARK: - Accessors

    func getWSClient() -> MitzoWSClient? { wsClient }
    func getAPIClient() -> MitzoAPIClient? { apiClient }
}
