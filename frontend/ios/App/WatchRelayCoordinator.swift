// Coordinates native WS connection + WatchRelay for Apple Watch communication.
// The Capacitor web layer has its own WS; this is a second native connection
// used exclusively by WatchRelayHost to bridge watch ↔ server messages.

import UIKit
import MitzoShared

final class WatchRelayCoordinator: @unchecked Sendable {
    private let authManager = AuthManager()
    private let watchRelay: WatchRelayHost
    private var wsClient: MitzoWSClient?
    private let lock = NSLock()

    private var serverURL: URL {
        let stored = UserDefaults.standard.string(forKey: "mitzo_server_url")
        return URL(string: stored ?? "https://dimakis-mac.tail:3100")!
    }

    init() {
        watchRelay = WatchRelayHost(authManager: authManager)
    }

    func start() {
        // Activate WCSession unconditionally so the watch relay works
        // even before auth. This lets the auth_token relay bootstrap
        // the token, and list_sessions/get_messages return proper errors
        // instead of silently hanging with no delegate.
        let apiClient = MitzoAPIClient(baseURL: serverURL, authManager: authManager)
        watchRelay.activate(wsClient: nil, apiClient: apiClient)

        Task { await connectWS() }
    }

    func reconnect() {
        Task { await connectWS() }
    }

    func suspend() {
        Task {
            let client: MitzoWSClient? = lock.withLock { wsClient }
            if let client {
                let sessions = await client.getSuspendSessions()
                if !sessions.isEmpty {
                    try? await client.suspend(sessions: sessions)
                }
            }
        }
    }

    /// Connect the native WS (for forwarding server events to watch).
    /// WCSession is already active from start() — this only adds WS.
    private func connectWS() async {
        guard let token = try? await authManager.getToken() else { return }

        var components = URLComponents(url: serverURL, resolvingAgainstBaseURL: false)!
        components.scheme = components.scheme == "https" ? "wss" : "ws"
        components.path = "/ws/chat"
        components.queryItems = [URLQueryItem(name: "token", value: token)]

        guard let wsURL = components.url else { return }

        let client = MitzoWSClient(url: wsURL)
        let apiClient = MitzoAPIClient(baseURL: serverURL, authManager: authManager)
        lock.withLock { wsClient = client }
        watchRelay.activate(wsClient: client, apiClient: apiClient)

        let relay = watchRelay
        await client.connect { event in
            if case .message(let msg) = event {
                relay.forwardToWatch(msg)
            }
        }
    }
}
