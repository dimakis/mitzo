// Central app state — owns auth, WS connection, and session state

import SwiftUI
import MitzoShared

@MainActor
final class AppState: ObservableObject {
    enum ConnectionMode: String {
        case direct     // Direct WS to server
        case relay      // Via iPhone WatchConnectivity
        case none
    }

    @Published var isAuthenticated = false
    @Published var connectionState: MitzoWSClient.State = .disconnected
    @Published var connectionMode: ConnectionMode = .none
    @Published var sessions: [Session] = []
    @Published var error: String?

    private let authManager = AuthManager()
    private var wsClient: MitzoWSClient?
    private var apiClient: MitzoAPIClient?
    private var activeChatVM: ChatViewModel?
    private let relayClient = WatchRelayClient()

    // Configurable via UserDefaults; defaults to Tailscale hostname
    var serverURL: URL {
        let stored = UserDefaults.standard.string(forKey: "mitzo_server_url")
        return URL(string: stored ?? "https://mitzo.tail:3100")!
    }

    init() {
        // Activate WatchConnectivity relay
        relayClient.activate()
        relayClient.onServerMessage = { [weak self] msg in
            Task { @MainActor in
                self?.activeChatVM?.handleMessage(msg)
            }
        }

        Task {
            await checkAuth()
        }
    }

    // MARK: - Auth

    func checkAuth() async {
        // Try shared Keychain first
        var authenticated = await authManager.isAuthenticated()

        // If no local token, try getting it from the phone via relay
        if !authenticated && relayClient.isPhoneReachable {
            do {
                let token = try await relayClient.requestAuthToken()
                try await authManager.saveToken(token)
                authenticated = true
            } catch {
                // Phone didn't have a token either
            }
        }

        isAuthenticated = authenticated
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

    // MARK: - Connection (waterfall: direct → relay)

    func connect() async {
        // Try direct WS first
        let directSuccess = await connectDirect()
        if directSuccess { return }

        // Fall back to relay via iPhone
        if relayClient.isPhoneReachable {
            connectionMode = .relay
            connectionState = .connected(connectionId: "relay")
            // In relay mode, messages go through WatchRelayClient
            await loadSessionsViaRelay()
        } else {
            connectionMode = .none
            error = "Cannot reach server or iPhone"
        }
    }

    private func connectDirect() async -> Bool {
        guard let token = try? await authManager.getToken() else { return false }

        var components = URLComponents(url: serverURL, resolvingAgainstBaseURL: false)!
        components.scheme = components.scheme == "https" ? "wss" : "ws"
        components.path = "/ws/chat"
        components.queryItems = [URLQueryItem(name: "token", value: token)]

        guard let wsURL = components.url else { return false }

        let client = MitzoWSClient(url: wsURL)
        wsClient = client

        apiClient = MitzoAPIClient(baseURL: serverURL, authManager: authManager)

        // Try connecting with a timeout
        let connected = await withCheckedContinuation { continuation in
            var resolved = false

            Task {
                await client.connect { [weak self] event in
                    Task { @MainActor in
                        self?.handleWSEvent(event)

                        if !resolved {
                            if case .stateChanged(.connected) = event {
                                resolved = true
                                continuation.resume(returning: true)
                            }
                        }
                    }
                }
            }

            // Timeout after 5 seconds
            Task {
                try? await Task.sleep(nanoseconds: 5_000_000_000)
                if !resolved {
                    resolved = true
                    continuation.resume(returning: false)
                }
            }
        }

        if connected {
            connectionMode = .direct
            await loadSessions()
            return true
        } else {
            await client.disconnect()
            wsClient = nil
            return false
        }
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
            let response = try await apiClient?.getSessions() ?? SessionsResponse(sessions: [], hasMore: false)
            sessions = response.sessions
        } catch {
            self.error = "Failed to load sessions"
        }
    }

    private func loadSessionsViaRelay() async {
        // In relay mode, we can't use the REST API directly.
        // The phone handles the WS connection; we just send/receive messages.
        // Session list would need a relay message type, or we accept
        // that relay mode starts from existing sessions only.
    }

    // MARK: - Active Chat

    func setActiveChatVM(_ vm: ChatViewModel?) {
        activeChatVM = vm
    }

    // MARK: - Send (mode-aware)

    func sendMessage(_ message: ClientMessage) async throws {
        switch connectionMode {
        case .direct:
            try await wsClient?.send(message)

        case .relay:
            // Convert ClientMessage to relay dict
            let dict = clientMessageToRelayDict(message)
            _ = try await relayClient.send(action: dict["action"] as? String ?? "", params: dict)

        case .none:
            throw ConnectionError.notConnected
        }
    }

    // MARK: - Event Handling

    private func handleWSEvent(_ event: MitzoWSClient.Event) {
        switch event {
        case .stateChanged(let state):
            connectionState = state

            // If direct connection drops, try relay
            if case .disconnected = state, connectionMode == .direct {
                connectionMode = .none
                Task { await connect() }
            }

        case .message(let msg):
            activeChatVM?.handleMessage(msg)

        case .error(let err):
            error = err.localizedDescription
        }
    }

    // MARK: - Helpers

    private func clientMessageToRelayDict(_ message: ClientMessage) -> [String: Any] {
        switch message {
        case .send(let params):
            return [
                "action": "send",
                "sessionId": params.sessionId as Any,
                "prompt": params.prompt,
                "clientMsgId": params.clientMsgId
            ]
        case .stop(let sessionId):
            return ["action": "stop", "sessionId": sessionId]
        case .watch(let sessionId):
            return ["action": "watch", "sessionId": sessionId]
        case .permissionResponse(let params):
            return [
                "action": "permission_response",
                "sessionId": params.sessionId as Any,
                "permId": params.permId,
                "decision": params.decision?.rawValue as Any
            ]
        default:
            return ["action": "unknown"]
        }
    }

    // MARK: - Accessors

    func getWSClient() -> MitzoWSClient? { wsClient }
    func getAPIClient() -> MitzoAPIClient? { apiClient }
}

enum ConnectionError: Error {
    case notConnected
}
