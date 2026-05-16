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
        // Activate WCSession immediately so watch can reach us even before login
        watchRelay.activate(wsClient: nil, apiClient: nil)
    }

    func start() {
        Task { await connect() }
    }

    func reconnect() {
        Task { await connect() }
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

    private func connect() async {
        guard let token = try? await authManager.getToken() else { return }

        var components = URLComponents(url: serverURL, resolvingAgainstBaseURL: false)!
        components.scheme = components.scheme == "https" ? "wss" : "ws"
        components.path = "/ws/chat"
        components.queryItems = [URLQueryItem(name: "token", value: token)]

        guard let wsURL = components.url else { return }

        let client = MitzoWSClient(url: wsURL)
        lock.withLock { wsClient = client }

        let api = MitzoAPIClient(baseURL: serverURL, authManager: authManager)
        // Update relay with authenticated clients (WCSession already activated in init)
        watchRelay.activate(wsClient: client, apiClient: api)

        let relay = watchRelay
        await client.connect { event in
            if case .message(let msg) = event {
                relay.forwardToWatch(msg)
            }
        }
    }
}
