// Coordinates native WS connection + WatchRelay for Apple Watch communication.
// The Capacitor web layer has its own WS; this is a second native connection
// used exclusively by WatchRelayHost to bridge watch ↔ server messages.

import UIKit
import MitzoShared

@MainActor
final class WatchRelayCoordinator {
    private let watchRelay: WatchRelayHost
    private let connection: NativeRelayConnection
    private var started = false

    init() {
        let relay = WatchRelayHost(authManager: AuthManager(), notificationAPIProvider: {
            guard let url = notificationServerURL(UserDefaults.standard.string(forKey: "mitzo_notification_server_url")) else { return nil }
            return MitzoAPIClient(baseURL: url, authManager: AuthManager())
        })
        watchRelay = relay
        connection = NativeRelayConnection(configuration: {
            let origin = UserDefaults.standard.string(forKey: "mitzo_notification_server_url")
            guard let token = try? await AuthManager().getToken(),
                  origin == UserDefaults.standard.string(forKey: "mitzo_notification_server_url") else { return nil }
            return nativeRelayWebSocketURL(origin: origin, token: token)
        }, onEvent: { [weak relay] event in
            if case .message(let message) = event { relay?.forwardToWatch(message) }
        })
        // WCSession and fresh REST are available during a cold background wake.
        // Only a foreground scene or actual Watch chat demand opens the socket.
        watchRelay.activate(wsClientProvider: { [connection] in try await connection.acquire() })
    }

    func start() {
        guard !started else { return }
        started = true
        Task { _ = try? await connection.acquire() }
    }

    func reconnect() {
        Task { _ = try? await connection.acquire(reconnect: true) }
    }

    func suspend() {
        Task { await connection.suspend() }
    }
}
