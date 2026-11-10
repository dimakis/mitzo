// Coordinates native WS connection + WatchRelay for Apple Watch communication.
// The Capacitor web layer has its own WS; this is a second native connection
// used exclusively by WatchRelayHost to bridge watch ↔ server messages.

import UIKit
import MitzoShared
import OSLog

@MainActor
final class WatchRelayCoordinator {
    nonisolated private static let log = Logger(subsystem: "com.mitzo.app", category: "watch-relay")
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
            let token: String
            do { token = try await AuthManager().getToken() }
            catch AuthManager.AuthError.noToken { return nil } // Login may not exist yet.
            catch is CancellationError { return nil }
            catch {
                Self.log.error("relay_auth_unavailable cause=\(error as NSError, privacy: .private)")
                return nil
            }
            guard origin == UserDefaults.standard.string(forKey: "mitzo_notification_server_url") else { return nil }
            return nativeRelayWebSocketURL(origin: origin, token: token)
        }, onEvent: { [weak relay] event in
            if case .message(let message) = event { relay?.forwardToWatch(message) }
            if case .error(let error) = event {
                Self.log.error("relay_transport_unconfirmed cause=\(error as NSError, privacy: .private)")
            }
        })
        // WCSession and fresh REST are available during a cold background wake.
        // Only a foreground scene or actual Watch chat demand opens the socket.
        watchRelay.activate(wsClientProvider: { [connection] in try await connection.acquire() })
    }

    func start() {
        guard !started else { return }
        started = true
        connect(reconnect: false)
    }

    func reconnect() {
        connect(reconnect: true)
    }

    func suspend() {
        Task {
            do { try await connection.suspend() }
            catch is CancellationError { return } // Retired scene work is expected.
            catch { Self.log.error("relay_suspend_unconfirmed cause=\(error as NSError, privacy: .private)") }
        }
    }

    private func connect(reconnect: Bool) {
        let request = UUID().uuidString
        Task {
            do { _ = try await connection.acquire(reconnect: reconnect) }
            catch is CancellationError { return } // Cancelled setup creates no command.
            catch NativeRelayConnection.ConnectionError.unavailable {
                Self.log.notice("relay_unavailable request=\(request, privacy: .public)")
            }
            catch {
                Self.log.error("relay_connect_failed request=\(request, privacy: .public) cause=\(error as NSError, privacy: .private)")
            }
        }
    }
}
