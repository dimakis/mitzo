// WatchConnectivity relay — bridges WS messages between watch and iPhone
//
// iPhone side: receives relay messages from watch, forwards to/from WS
// Watch side: sends messages via WCSession when direct WS is unavailable

/// Wraps a non-Sendable value for use across isolation boundaries.
/// Safety: WCSession's replyHandler is called exactly once; we transfer
/// ownership into the Task and never alias it.
struct UnsafeSendable<T>: @unchecked Sendable {
    let value: T
    init(_ value: T) { self.value = value }
}

#if os(iOS)
import WatchConnectivity
import Foundation

/// iPhone-side relay: bridges watch messages to the Mitzo WS connection.
/// Add to AppDelegate or a long-lived coordinator.
public final class WatchRelayHost: NSObject, WCSessionDelegate, Sendable {
    private let state = WatchRelayHostState()
    private let authManager: AuthManager

    public init(authManager: AuthManager) {
        self.authManager = authManager
        super.init()
    }

    /// Returns the configured wsClient, or lazily creates and connects one.
    private func getOrCreateWSClient(fallbackToken: String? = nil) async -> MitzoWSClient? {
        if let existing = state.getWSClient() { return existing }

        // Try to get a token for WS authentication
        var token = try? await authManager.getToken()
        if token == nil, let fb = fallbackToken {
            try? await authManager.saveToken(fb)
            token = try? await authManager.getToken()
        }

        guard let token else {
            print("[WatchRelay] No token for lazy wsClient")
            return nil
        }

        let stored = UserDefaults.standard.string(forKey: "mitzo_server_url")
        guard let serverURL = URL(string: stored ?? "https://100.91.50.57:3100") else {
            return nil
        }

        var components = URLComponents(url: serverURL, resolvingAgainstBaseURL: false)!
        components.scheme = components.scheme == "https" ? "wss" : "ws"
        components.path = "/ws/chat"
        components.queryItems = [URLQueryItem(name: "token", value: token)]

        guard let wsURL = components.url else { return nil }

        let client = MitzoWSClient(url: wsURL)
        state.setWSClient(client)
        print("[WatchRelay] Lazily created wsClient for \(wsURL.host ?? "")")

        // Connect in the background — fire and forget, the client handles reconnection
        let relay = self
        Task {
            await client.connect { event in
                if case .message(let msg) = event {
                    relay.forwardToWatch(msg)
                }
            }
        }

        // Give the WS handshake a moment
        try? await Task.sleep(nanoseconds: 1_000_000_000)
        return client
    }

    /// Returns the configured apiClient, or lazily creates one if none is set.
    /// This handles the timing gap where the watch requests sessions before
    /// the coordinator has finished connecting.
    /// If a fallback token is provided (from the watch's relay message), it will
    /// be saved to the Keychain and used to create the apiClient.
    private func getOrCreateAPIClient(fallbackToken: String? = nil) async -> MitzoAPIClient? {
        if let existing = state.getAPIClient() { return existing }

        // Try Keychain first, then fall back to token from watch
        var hasToken = (try? await authManager.getToken()) != nil
        if !hasToken, let token = fallbackToken {
            print("[WatchRelay] Using fallback token from watch")
            try? await authManager.saveToken(token)
            hasToken = true
        }

        guard hasToken else {
            print("[WatchRelay] No token available for lazy apiClient")
            return nil
        }

        let stored = UserDefaults.standard.string(forKey: "mitzo_server_url")
        guard let serverURL = URL(string: stored ?? "https://100.91.50.57:3100") else {
            return nil
        }

        let api = MitzoAPIClient(baseURL: serverURL, authManager: authManager)
        state.setAPIClient(api)
        print("[WatchRelay] Lazily created apiClient for \(serverURL)")
        return api
    }

    /// Slim down messages to fit within WCSession's ~64KB payload limit.
    /// Keeps only text blocks, truncates long content, drops tool
    /// input/output/results, and takes only the most recent messages.
    static func slimMessages(_ messages: [FinishedMessage], maxBytes: Int) -> [FinishedMessage] {
        // Take last 30 messages, strip tool details
        let recent = messages.suffix(30)
        var slim: [FinishedMessage] = []

        for msg in recent {
            let slimBlocks = msg.blocks.compactMap { block -> FinishedBlock? in
                // Keep only text blocks, skip tool_use/thinking
                guard block.blockType == .text else {
                    return nil
                }
                // Truncate long content
                let content = block.content.count > 500
                    ? String(block.content.prefix(500)) + "..."
                    : block.content
                return FinishedBlock(
                    blockId: block.blockId,
                    blockType: block.blockType,
                    content: content,
                    toolName: nil,
                    toolId: nil,
                    toolInput: nil,
                    rawInput: nil,
                    toolResult: nil,
                    toolError: nil
                )
            }
            // Skip messages with no displayable blocks
            guard !slimBlocks.isEmpty else { continue }
            slim.append(FinishedMessage(
                messageId: msg.messageId,
                role: msg.role,
                blocks: slimBlocks,
                images: nil,
                contextBlocks: nil,
                timestamp: msg.timestamp
            ))
        }

        // Final size check — drop oldest if still too large
        while slim.count > 2 {
            if let data = try? JSONEncoder().encode(slim), data.count <= maxBytes {
                break
            }
            slim.removeFirst()
        }

        return slim
    }

    public func activate(wsClient: MitzoWSClient? = nil, apiClient: MitzoAPIClient? = nil) {
        if let wsClient { state.setWSClient(wsClient) }
        if let apiClient { state.setAPIClient(apiClient) }

        guard WCSession.isSupported() else {
            print("[WatchRelay] WCSession not supported")
            return
        }
        print("[WatchRelay] Activating WCSession, delegate=\(WCSession.default.delegate == nil ? "nil" : "set")")
        WCSession.default.delegate = self
        WCSession.default.activate()
    }

    // MARK: - WCSessionDelegate

    public func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        print("[WatchRelay] Activation complete: state=\(activationState.rawValue), error=\(String(describing: error))")
    }

    public func sessionDidBecomeInactive(_ session: WCSession) {}
    public func sessionDidDeactivate(_ session: WCSession) {
        WCSession.default.activate()
    }

    public func session(_ session: WCSession, didReceiveMessage message: [String: Any], replyHandler: @escaping ([String: Any]) -> Void) {
        print("[WatchRelay] Received message: \(message)")
        guard let type = message["_relay"] as? String else {
            print("[WatchRelay] Missing _relay type, sending error")
            replyHandler(["error": "missing _relay type"])
            return
        }
        print("[WatchRelay] Relay type: \(type)")

        // Extract ALL values before crossing the Task isolation boundary
        // so we don't capture the non-Sendable [String: Any] dict.
        let clientMsg: UnsafeSendable<ClientMessage?>
        if type == "send" {
            clientMsg = UnsafeSendable(try? decodeClientMessage(from: message))
        } else {
            clientMsg = UnsafeSendable(nil)
        }
        let sessionId = message["sessionId"] as? String ?? ""
        let fallbackToken = message["_token"] as? String
        let reply = UnsafeSendable(replyHandler)
        let capturedSelf = self

        Task { @Sendable in
            do {
                switch type {
                case "send":
                    guard let msg = clientMsg.value else {
                        reply.value(["error": "invalid message"])
                        return
                    }
                    if let ws = await capturedSelf.getOrCreateWSClient(fallbackToken: fallbackToken) {
                        try await ws.send(msg)
                        reply.value(["ok": true])
                    } else {
                        print("[WatchRelay] No wsClient for send")
                        reply.value(["error": "no_ws_client"])
                    }

                case "get_messages":
                    if let apiClient = await capturedSelf.getOrCreateAPIClient(fallbackToken: fallbackToken) {
                        do {
                            let allMessages: [FinishedMessage] = try await apiClient.getMessages(sessionId: sessionId)
                            // WCSession has ~64KB limit. Strip tool details and take
                            // only recent messages to stay under the cap.
                            let slim = WatchRelayHost.slimMessages(allMessages, maxBytes: 50_000)
                            let data = try JSONEncoder().encode(slim)
                            if let arr = try JSONSerialization.jsonObject(with: data) as? [[String: Any]] {
                                reply.value(["_payload": arr])
                            } else {
                                reply.value(["error": "encoding_failed"])
                            }
                        } catch {
                            print("[WatchRelay] get_messages error: \(error)")
                            reply.value(["error": error.localizedDescription])
                        }
                    } else {
                        print("[WatchRelay] No apiClient for get_messages")
                        reply.value(["error": "no_api_client"])
                    }

                case "list_sessions":
                    if let apiClient = await capturedSelf.getOrCreateAPIClient(fallbackToken: fallbackToken) {
                        do {
                            let response = try await apiClient.getSessions()
                            let data = try JSONEncoder().encode(response)
                            if let dict = try JSONSerialization.jsonObject(with: data) as? [String: Any] {
                                print("[WatchRelay] list_sessions success: \(dict.keys)")
                                reply.value(["_payload": dict])
                            } else {
                                reply.value(["error": "encoding_failed"])
                            }
                        } catch {
                            print("[WatchRelay] list_sessions error: \(error)")
                            reply.value(["error": error.localizedDescription])
                        }
                    } else {
                        print("[WatchRelay] No apiClient for list_sessions")
                        reply.value(["error": "no_api_client"])
                    }

                case "auth_token":
                    if let token = try? await capturedSelf.authManager.getToken() {
                        reply.value(["token": token])
                    } else {
                        reply.value(["error": "no_token"])
                    }

                default:
                    reply.value(["error": "unknown relay type: \(type)"])
                }
            } catch {
                reply.value(["error": error.localizedDescription])
            }
        }
    }

    /// Forward server messages to the watch.
    /// WCSession has an undocumented ~64 KB per-message limit; large payloads
    /// (e.g. file-read block_delta) are silently dropped by the system.
    public func forwardToWatch(_ message: ServerMessage) {
        guard WCSession.default.isReachable else { return }

        do {
            let data = try JSONEncoder().encode(message)
            if let dict = try JSONSerialization.jsonObject(with: data) as? [String: Any] {
                WCSession.default.sendMessage(
                    ["_relay": "server_event", "_payload": dict],
                    replyHandler: nil,
                    errorHandler: { @Sendable _ in } // Non-fatal: watch recovers via seq replay
                )
            }
        } catch {
            // Encoding failure — drop the message
        }
    }

    // MARK: - Helpers

    private func decodeClientMessage(from dict: [String: Any]) throws -> ClientMessage {
        guard let action = dict["action"] as? String else {
            throw RelayError.missingAction
        }

        switch action {
        case "hello":
            return .hello()

        case "send":
            let params = SendParams(
                sessionId: dict["sessionId"] as? String,
                prompt: dict["prompt"] as? String ?? "",
                clientMsgId: dict["clientMsgId"] as? String ?? UUID().uuidString,
                model: dict["model"] as? String,
                mode: (dict["mode"] as? String).flatMap(MitzoMode.init(rawValue:)),
                images: decodeImages(from: dict["images"]),
                contextBlocks: dict["contextBlocks"] as? [String]
            )
            return .send(params)

        case "watch":
            guard let sessionId = dict["sessionId"] as? String else {
                throw RelayError.missingSessionId
            }
            return .watch(sessionId: sessionId)

        case "stop":
            guard let sessionId = dict["sessionId"] as? String else {
                throw RelayError.missingSessionId
            }
            return .stop(sessionId: sessionId)

        case "permission_response":
            let params = PermissionResponseParams(
                sessionId: dict["sessionId"] as? String,
                permId: dict["permId"] as? String ?? "",
                decision: PermissionDecision(rawValue: dict["decision"] as? String ?? "deny")
            )
            return .permissionResponse(params)

        case "session_suspend":
            if let sessions = dict["sessions"] as? [[String: Any]] {
                let suspendSessions = sessions.compactMap { s -> SuspendSession? in
                    guard let sid = s["sessionId"] as? String,
                          let seq = s["lastSeq"] as? Int else { return nil }
                    return SuspendSession(sessionId: sid, lastSeq: seq)
                }
                return .sessionSuspend(sessions: suspendSessions)
            }
            return .sessionSuspend(sessions: [])

        default:
            throw RelayError.unknownAction(action)
        }
    }

    private func decodeImages(from value: Any?) -> [ImageAttachment]? {
        guard let arr = value as? [[String: Any]] else { return nil }
        let images = arr.compactMap { dict -> ImageAttachment? in
            guard let data = dict["data"] as? String,
                  let mediaType = dict["mediaType"] as? String else { return nil }
            return ImageAttachment(data: data, mediaType: mediaType, preview: dict["preview"] as? String)
        }
        return images.isEmpty ? nil : images
    }
}

/// Thread-safe state container for WatchRelayHost. WCSession callbacks
/// arrive on a background serial queue, so we need synchronization.
private final class WatchRelayHostState: Sendable {
    private nonisolated(unsafe) var _wsClient: MitzoWSClient?
    private nonisolated(unsafe) var _apiClient: MitzoAPIClient?
    private let lock = NSLock()

    func setWSClient(_ client: MitzoWSClient) {
        lock.lock()
        _wsClient = client
        lock.unlock()
    }

    func getWSClient() -> MitzoWSClient? {
        lock.lock()
        defer { lock.unlock() }
        return _wsClient
    }

    func setAPIClient(_ client: MitzoAPIClient?) {
        lock.lock()
        _apiClient = client
        lock.unlock()
    }

    func getAPIClient() -> MitzoAPIClient? {
        lock.lock()
        defer { lock.unlock() }
        return _apiClient
    }
}

enum RelayError: Error {
    case missingAction
    case missingSessionId
    case unknownAction(String)
}

#endif

// MARK: - Watch-side relay client

#if os(watchOS)
import WatchConnectivity
import Foundation

/// Watch-side relay: sends messages through iPhone when direct WS is unavailable.
public final class WatchRelayClient: NSObject, WCSessionDelegate, Sendable {
    private let state = WatchRelayClientState()
    public var isPhoneReachable: Bool { WCSession.default.isReachable }

    public override init() {
        super.init()
    }

    public func setOnServerMessage(_ handler: @escaping @Sendable (ServerMessage) -> Void) {
        state.setHandler(handler)
    }

    public func activate() {
        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
    }

    // MARK: - Send via relay

    public func send(action: String, params: [String: Any] = [:]) async throws -> [String: Any] {
        var message = params
        message["_relay"] = "send"
        message["action"] = action

        return try await withCheckedThrowingContinuation { continuation in
            let cont = UnsafeSendable(continuation)
            WCSession.default.sendMessage(message, replyHandler: { @Sendable reply in
                cont.value.resume(returning: UnsafeSendable(reply).value)
            }, errorHandler: { @Sendable error in
                cont.value.resume(throwing: error)
            })
        }
    }

    /// Request messages for a session from phone (phone calls server REST API)
    public func requestMessages(sessionId: String) async throws -> [FinishedMessage] {
        let reply = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<[String: Any], Error>) in
            let cont = UnsafeSendable(continuation)
            WCSession.default.sendMessage(
                ["_relay": "get_messages", "sessionId": sessionId],
                replyHandler: { @Sendable reply in cont.value.resume(returning: UnsafeSendable(reply).value) },
                errorHandler: { @Sendable error in cont.value.resume(throwing: error) }
            )
        }

        if let errorMsg = reply["error"] as? String {
            throw WatchRelayError.relayError(errorMsg)
        }

        guard let payload = reply["_payload"] as? [[String: Any]] else {
            throw WatchRelayError.invalidResponse
        }

        let data = try JSONSerialization.data(withJSONObject: payload)
        return try JSONDecoder().decode([FinishedMessage].self, from: data)
    }

    /// Request session list from phone (phone calls server REST API)
    public func requestSessions() async throws -> SessionsResponse {
        let reply = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<[String: Any], Error>) in
            let cont = UnsafeSendable(continuation)
            WCSession.default.sendMessage(
                ["_relay": "list_sessions"],
                replyHandler: { @Sendable reply in cont.value.resume(returning: UnsafeSendable(reply).value) },
                errorHandler: { @Sendable error in cont.value.resume(throwing: error) }
            )
        }

        if let errorMsg = reply["error"] as? String {
            throw WatchRelayError.relayError(errorMsg)
        }

        guard let payload = reply["_payload"] as? [String: Any] else {
            throw WatchRelayError.invalidResponse
        }

        let data = try JSONSerialization.data(withJSONObject: payload)
        return try JSONDecoder().decode(SessionsResponse.self, from: data)
    }

    /// Request auth token from phone
    public func requestAuthToken() async throws -> String {
        let reply = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<[String: Any], Error>) in
            let cont = UnsafeSendable(continuation)
            WCSession.default.sendMessage(
                ["_relay": "auth_token"],
                replyHandler: { @Sendable reply in cont.value.resume(returning: UnsafeSendable(reply).value) },
                errorHandler: { @Sendable error in cont.value.resume(throwing: error) }
            )
        }

        guard let token = reply["token"] as? String else {
            throw WatchRelayError.noToken
        }
        return token
    }

    // MARK: - WCSessionDelegate

    public func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {}

    public func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        guard message["_relay"] as? String == "server_event",
              let payload = message["_payload"] as? [String: Any] else { return }

        do {
            let data = try JSONSerialization.data(withJSONObject: payload)
            let serverMsg = try JSONDecoder().decode(ServerMessage.self, from: data)
            state.getHandler()?(serverMsg)
        } catch {
            // Decoding failure — drop the message
        }
    }
}

/// Thread-safe state container for WatchRelayClient.
private final class WatchRelayClientState: Sendable {
    private nonisolated(unsafe) var _handler: (@Sendable (ServerMessage) -> Void)?
    private let lock = NSLock()

    func setHandler(_ handler: @escaping @Sendable (ServerMessage) -> Void) {
        lock.lock()
        _handler = handler
        lock.unlock()
    }

    func getHandler() -> (@Sendable (ServerMessage) -> Void)? {
        lock.lock()
        defer { lock.unlock() }
        return _handler
    }
}

enum WatchRelayError: Error {
    case noToken
    case notReachable
    case invalidResponse
    case relayError(String)
}
#endif
