// Coordinates native WS connection + WatchRelay for Apple Watch communication.
// The Capacitor web layer has its own WS; this is a second native connection
// used exclusively by WatchRelayHost to bridge watch ↔ server messages.

import UIKit
import MitzoShared

@MainActor
final class WatchRelayCoordinator {
    private let authManager = AuthManager()
    private let watchRelay: WatchRelayHost
    private var wsClient: MitzoWSClient?
    private var connectionGeneration: UInt64 = 0
    private var started = false

    init() {
        watchRelay = WatchRelayHost(authManager: authManager, notificationAPIProvider: {
            guard let url = notificationServerURL(UserDefaults.standard.string(forKey: "mitzo_notification_server_url")) else { return nil }
            return MitzoAPIClient(baseURL: url, authManager: AuthManager())
        })
        // Activate WCSession immediately so watch can reach us even before login
        watchRelay.activate(wsClient: nil, apiClient: nil)
    }

    func start() {
        guard !started else { return }
        started = true
        Task { await connect() }
    }

    func reconnect() {
        Task { await connect() }
    }

    func suspend() {
        Task {
            let client = wsClient
            if let client {
                let sessions = await client.getSuspendSessions()
                if !sessions.isEmpty {
                    try? await client.suspend(sessions: sessions)
                }
            }
        }
    }

    private func connect() async {
        connectionGeneration &+= 1
        let generation = connectionGeneration
        let previous = wsClient
        wsClient = nil
        await previous?.disconnect()
        let origin = UserDefaults.standard.string(forKey: "mitzo_notification_server_url")
        let currentAuth = AuthManager()
        guard let token = try? await currentAuth.getToken(),
              generation == connectionGeneration,
              let serverURL = notificationServerURL(origin),
              let wsURL = nativeRelayWebSocketURL(origin: origin, token: token) else { return }

        let client = MitzoWSClient(url: wsURL)
        wsClient = client

        let api = MitzoAPIClient(baseURL: serverURL, authManager: currentAuth)
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
