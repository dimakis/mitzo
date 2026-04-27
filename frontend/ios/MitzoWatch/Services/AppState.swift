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
    private var reconnectAttempts = 0
    private var isReconnecting = false
    private static let maxReconnectDelay: UInt64 = 30_000_000_000 // 30s

    // Configurable via UserDefaults; defaults to Tailscale hostname
    var serverURL: URL {
        let stored = UserDefaults.standard.string(forKey: "mitzo_server_url")
        return URL(string: stored ?? "https://mitzo.tail:3100")!
    }

    init() {
        relayClient.activate()
        relayClient.setOnServerMessage { [weak self] msg in
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
        var authenticated = await authManager.isAuthenticated()

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
        let directSuccess = await connectDirect()
        if directSuccess {
            reconnectAttempts = 0
            return
        }

        if relayClient.isPhoneReachable {
            connectionMode = .relay
            connectionState = .connected(connectionId: "relay")
            reconnectAttempts = 0
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
        // Relay mode can't use the REST API directly — the phone owns the
        // WS connection and there's no relay message type for session listing.
        // The watch shows an empty list with a hint to open on iPhone.
        sessions = []
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
            let dict = try clientMessageToRelayDict(message)
            let reply = try await relayClient.send(action: dict["action"] as? String ?? "", params: dict)
            if let relayError = reply["error"] as? String {
                throw RelayResponseError.serverRejected(relayError)
            }

        case .none:
            throw ConnectionError.notConnected
        }
    }

    // MARK: - Event Handling

    private func handleWSEvent(_ event: MitzoWSClient.Event) {
        switch event {
        case .stateChanged(let state):
            connectionState = state

            if case .disconnected = state, connectionMode == .direct {
                connectionMode = .none
                reconnectWithBackoff()
            }

        case .message(let msg):
            activeChatVM?.handleMessage(msg)

        case .error(let err):
            error = err.localizedDescription
        }
    }

    private func reconnectWithBackoff() {
        guard !isReconnecting else { return }
        isReconnecting = true
        reconnectAttempts += 1
        let baseDelay: UInt64 = 1_000_000_000 // 1s
        let delay = min(baseDelay * UInt64(1 << min(reconnectAttempts - 1, 4)), Self.maxReconnectDelay)

        Task {
            try? await Task.sleep(nanoseconds: delay)
            await connect()
            isReconnecting = false
        }
    }

    // MARK: - Helpers

    private func clientMessageToRelayDict(_ message: ClientMessage) throws -> [String: Any] {
        switch message {
        case .send(let params):
            var dict: [String: Any] = [
                "action": "send",
                "prompt": params.prompt,
                "clientMsgId": params.clientMsgId
            ]
            if let sid = params.sessionId { dict["sessionId"] = sid }
            if let model = params.model { dict["model"] = model }
            if let mode = params.mode { dict["mode"] = mode.rawValue }
            if let images = params.images {
                dict["images"] = images.map { img in
                    var d: [String: Any] = ["data": img.data, "mediaType": img.mediaType]
                    if let preview = img.preview { d["preview"] = preview }
                    return d
                }
            }
            if let ctx = params.contextBlocks { dict["contextBlocks"] = ctx }
            return dict

        case .stop(let sessionId):
            return ["action": "stop", "sessionId": sessionId]

        case .watch(let sessionId):
            return ["action": "watch", "sessionId": sessionId]

        case .unwatch(let sessionId):
            return ["action": "unwatch", "sessionId": sessionId]

        case .permissionResponse(let params):
            var dict: [String: Any] = [
                "action": "permission_response",
                "permId": params.permId
            ]
            if let sid = params.sessionId { dict["sessionId"] = sid }
            if let decision = params.decision { dict["decision"] = decision.rawValue }
            return dict

        case .hello(let version):
            return ["action": "hello", "protocolVersion": version]

        case .switchSession(let sessionId):
            var dict: [String: Any] = ["action": "switch_session"]
            if let sid = sessionId { dict["sessionId"] = sid }
            return dict

        case .interrupt(let params):
            var dict: [String: Any] = [
                "action": "interrupt",
                "sessionId": params.sessionId,
                "prompt": params.prompt,
                "clientMsgId": params.clientMsgId
            ]
            if let images = params.images {
                dict["images"] = images.map { img in
                    var d: [String: Any] = ["data": img.data, "mediaType": img.mediaType]
                    if let preview = img.preview { d["preview"] = preview }
                    return d
                }
            }
            if let ctx = params.contextBlocks { dict["contextBlocks"] = ctx }
            return dict

        case .setMode(let sessionId, let mode):
            return ["action": "set_mode", "sessionId": sessionId, "mode": mode.rawValue]

        case .sessionSuspend(let sessions):
            return [
                "action": "session_suspend",
                "sessions": sessions.map { ["sessionId": $0.sessionId, "lastSeq": $0.lastSeq] }
            ]

        case .reconnect(let sessions):
            return [
                "action": "reconnect",
                "sessions": sessions.map { ["sessionId": $0.sessionId, "lastSeq": $0.lastSeq] }
            ]
        }
    }

    // MARK: - Accessors

    func getWSClient() -> MitzoWSClient? { wsClient }
    func getAPIClient() -> MitzoAPIClient? { apiClient }
}

enum ConnectionError: Error {
    case notConnected
}

enum RelayResponseError: Error {
    case serverRejected(String)
}
