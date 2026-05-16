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
    private var activeChatVM: ChatViewModel?
    private let relayClient = WatchRelayClient()

    // Server URL used only for login (brief HTTP POST that sometimes works)
    var serverURL: URL {
        let stored = UserDefaults.standard.string(forKey: "mitzo_server_url")
        return URL(string: stored ?? "http://100.91.50.57:3101")!
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

    // MARK: - Connection (relay-only — direct to Tailscale IPs is blocked by NECP)

    func connect() async {
        // watchOS cannot reach Tailscale IPs due to NECP policy on the
        // iPhone's VPN extension. All traffic goes through the iPhone
        // via WatchConnectivity relay.

        // WCSession activation is async — give it a moment if not ready yet
        if !relayClient.isPhoneReachable {
            try? await Task.sleep(nanoseconds: 2_000_000_000) // 2s
        }

        if relayClient.isPhoneReachable {
            connectionMode = .relay
            connectionState = .connected(connectionId: "relay")
            await loadSessionsViaRelay()
        } else {
            connectionMode = .none
            connectionState = .disconnected
            error = "iPhone not reachable — open Mitzo on your phone"
            // Don't reconnect-loop. WCSession reachability changes will
            // trigger a retry via the session delegate (future enhancement).
        }
    }

    // MARK: - Sessions & Messages

    func loadMessages(sessionId: String) async throws -> [FinishedMessage] {
        return try await relayClient.requestMessages(sessionId: sessionId)
    }

    func refreshSessions() async {
        await loadSessionsViaRelay()
    }

    private func loadSessionsViaRelay() async {
        do {
            let response = try await relayClient.requestSessions()
            sessions = response.sessions
        } catch {
            self.error = "Failed to load sessions via relay"
            sessions = []
        }
    }

    // MARK: - Active Chat

    func setActiveChatVM(_ vm: ChatViewModel?) {
        activeChatVM = vm
    }

    // MARK: - Send (mode-aware)

    func sendMessage(_ message: ClientMessage) async throws {
        guard connectionMode == .relay else {
            throw ConnectionError.notConnected
        }

        let dict = try clientMessageToRelayDict(message)
        let reply = try await relayClient.send(action: dict["action"] as? String ?? "", params: dict)
        if let relayError = reply["error"] as? String {
            throw RelayResponseError.serverRejected(relayError)
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

}

enum ConnectionError: Error {
    case notConnected
}

enum RelayResponseError: Error {
    case serverRejected(String)
}
