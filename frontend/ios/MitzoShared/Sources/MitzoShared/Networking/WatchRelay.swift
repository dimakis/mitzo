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
    private let state: WatchRelayHostState
    private let reads: WatchRelayReads
    private let authManager: AuthManager
    private let notificationAPIProvider: (@Sendable () -> MitzoAPIClient?)?

    public init(authManager: AuthManager, notificationAPIProvider: (@Sendable () -> MitzoAPIClient?)? = nil) {
        let state = WatchRelayHostState()
        self.state = state
        self.reads = WatchRelayReads(apiProvider: {
            if let notificationAPIProvider { return notificationAPIProvider() }
            return state.getAPIClient()
        })
        self.notificationAPIProvider = notificationAPIProvider
        self.authManager = authManager
        super.init()
    }

    public func activate(wsClient: MitzoWSClient? = nil, apiClient: MitzoAPIClient? = nil,
                         wsClientProvider: (@Sendable () async throws -> MitzoWSClient)? = nil) {
        if let wsClient { state.setWSClient(wsClient) }
        if let apiClient { state.setAPIClient(apiClient) }
        if let wsClientProvider { state.setWSClientProvider(wsClientProvider) }

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
        print("[WatchRelay] Received relay message")
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
        let notificationId = message["notificationId"] as? String ?? ""
        let decision = NotificationResponse.Decision(rawValue: message["decision"] as? String ?? "")
        let answers = message["answers"] as? [String: [String]]
        let malformedAnswers = message["answers"] != nil && answers == nil
        let sourcePermId = message["permId"] as? String ?? ""
        let sourceBefore = message["before"] as? Int
        let sourceInput: WatchSourceInput? = (message["input"] as? [String: Any]).flatMap {
            guard let data = try? JSONSerialization.data(withJSONObject: $0) else { return nil }
            return try? JSONDecoder().decode(WatchSourceInput.self, from: data)
        }
        let materialInput: WatchSourceMaterialsInput? = (message["input"] as? [String: Any]).flatMap {
            guard let data = try? JSONSerialization.data(withJSONObject: $0) else { return nil }
            return try? JSONDecoder().decode(WatchSourceMaterialsInput.self, from: data)
        }
        let reply = UnsafeSendable(replyHandler)
        let capturedState = state
        let capturedAuthManager = AuthManager()
        let notificationAPIProvider = self.notificationAPIProvider
        let reads = self.reads
        let userText = message["userText"] as? String ?? ""

        Task { @Sendable in
            do {
                // Resolve REST independently of the foreground chat connection.
                // A fresh client also observes a logout performed by the web app.
                let notificationAPI: MitzoAPIClient?
                if let notificationAPIProvider { notificationAPI = notificationAPIProvider() }
                else { notificationAPI = capturedState.getAPIClient() }
                switch type {
                case "source_review", "source_materials", "source_preview", "source_approve":
                    guard let api = notificationAPI, !sourcePermId.isEmpty, !sessionId.isEmpty else { throw MitzoAPIClient.APIError.invalidResponse }
                    let data: Data
                    if type == "source_review" {
                        data = try JSONEncoder().encode(await api.getSourceReview(permId: sourcePermId, sessionId: sessionId, before: sourceBefore))
                    } else if type == "source_materials" {
                        guard let input = materialInput, input.sessionId == sessionId else { throw MitzoAPIClient.APIError.invalidResponse }
                        data = try JSONEncoder().encode(await api.getSourceMaterials(permId: sourcePermId, input: input))
                    } else {
                        guard let input = sourceInput, input.sessionId == sessionId else { throw MitzoAPIClient.APIError.invalidResponse }
                        if type == "source_preview" {
                            data = try JSONEncoder().encode(await api.previewSourceReview(permId: sourcePermId, input: input))
                        } else {
                            data = try JSONEncoder().encode(await api.approveSourceReview(permId: sourcePermId, input: input))
                        }
                    }
                    reply.value(try WatchSourceRelayJSON.payload(data: data))
                case "send":
                    guard let msg = clientMsg.value else {
                        reply.value(["error": "invalid message"])
                        return
                    }
                    let client = try await capturedState.clientForSend()
                    try await client.send(msg)
                    reply.value(["ok": true])

                case "get_messages":
                    let data = try await reads.messages(sessionId: sessionId)
                    guard let arr = try JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { throw MitzoAPIClient.APIError.invalidResponse }
                    reply.value(["_payload": arr])

                case "list_sessions":
                    let data = try await reads.sessions()
                    guard let dict = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw MitzoAPIClient.APIError.invalidResponse }
                    reply.value(["_payload": dict])

                case "list_notifications":
                    guard let api = notificationAPI else {
                        reply.value(["error": "Open Mitzo on your iPhone first."])
                        return
                    }
                    let feed = try await api.getNotifications()
                    let data = try JSONEncoder().encode(feed)
                    // WCSession has a ~64 KB limit. Never truncate approval details.
                    guard data.count < 55000,
                          let dict = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                        reply.value(["error": "These details are too large. Review on your iPhone."])
                        return
                    }
                    reply.value(["_payload": dict])

                case "get_notification":
                    guard let api = notificationAPI else { throw MitzoAPIClient.APIError.invalidResponse }
                    let item = try await api.getNotification(id: notificationId)
                    let data = try JSONEncoder().encode(item)
                    guard data.count < 55000,
                          let dict = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                        reply.value(["error": "These details are too large. Review on your iPhone."])
                        return
                    }
                    reply.value(["_payload": dict])

                case "reply_notification":
                    guard let api = notificationAPI, !sessionId.isEmpty,
                          !userText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                        throw MitzoAPIClient.APIError.invalidResponse
                    }
                    try await api.replyToNotification(sessionID: sessionId, text: userText)
                    reply.value(["ok": true])

                case "respond_notification":
                    guard let api = notificationAPI, let decision, !sessionId.isEmpty, !malformedAnswers else {
                        reply.value(["error": "Cannot respond. Open Mitzo on your iPhone."])
                        return
                    }
                    try await api.respondNotification(id: notificationId, response:
                        NotificationResponse(sessionId: sessionId, decision: decision, answers: answers))
                    reply.value(["ok": true])

                case "auth_token":
                    if let token = try? await capturedAuthManager.getToken() {
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

        case "unwatch":
            guard let sessionId = dict["sessionId"] as? String else { throw RelayError.missingSessionId }
            return .unwatch(sessionId: sessionId)

        case "reconnect":
            guard let entries = dict["sessions"] as? [[String: Any]] else { throw RelayError.missingSessionId }
            let sessions = try entries.map { entry -> ReconnectSession in
                guard let id = entry["sessionId"] as? String, let seq = entry["lastSeq"] as? Int else { throw RelayError.missingSessionId }
                return ReconnectSession(sessionId: id, lastSeq: seq)
            }
            return .reconnect(sessions: sessions)

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
    private nonisolated(unsafe) var _wsClientProvider: (@Sendable () async throws -> MitzoWSClient)?
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

    func setWSClientProvider(_ provider: @escaping @Sendable () async throws -> MitzoWSClient) {
        lock.withLock { _wsClientProvider = provider }
    }

    func clientForSend() async throws -> MitzoWSClient {
        let (provider, client) = lock.withLock { (_wsClientProvider, _wsClient) }
        if let provider { return try await provider() }
        guard let client else { throw NativeRelayConnection.ConnectionError.unavailable }
        return client
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

    public func requestNotifications() async throws -> NotificationFeed {
        let reply = try await notificationRelay(["_relay": "list_notifications"])
        guard let payload = reply["_payload"] as? [String: Any] else {
            throw WatchRelayError.invalidResponse
        }
        let data = try JSONSerialization.data(withJSONObject: payload)
        return try JSONDecoder().decode(NotificationFeed.self, from: data)
    }

    public func requestNotification(id: String) async throws -> MitzoNotification {
        let reply = try await notificationRelay(["_relay": "get_notification", "notificationId": id])
        guard let payload = reply["_payload"] as? [String: Any] else { throw WatchRelayError.invalidResponse }
        let data = try JSONSerialization.data(withJSONObject: payload)
        let item = try JSONDecoder().decode(MitzoNotification.self, from: data)
        guard item.id == id else { throw WatchRelayError.invalidResponse }
        return item
    }

    public func replyToNotification(sessionID: String, text: String) async throws {
        let reply = try await notificationRelay(["_relay": "reply_notification", "sessionId": sessionID, "userText": text])
        guard reply["ok"] as? Bool == true else { throw WatchRelayError.invalidResponse }
    }

    public func respondNotification(id: String, sessionId: String, decision: NotificationResponse.Decision, answers: [String: [String]]? = nil) async throws {
        var message: [String: Any] = ["_relay": "respond_notification",
            "notificationId": id, "sessionId": sessionId, "decision": decision.rawValue]
        if let answers { message["answers"] = answers }
        let reply = try await notificationRelay(message)
        guard reply["ok"] as? Bool == true else { throw WatchRelayError.invalidResponse }
    }

    private func sourcePayload<T: Decodable>(_ message: [String: Any]) async throws -> T {
        let reply = try await notificationRelay(message)
        return try WatchSourceRelayJSON.decode(reply, as: T.self)
    }
    public func sourceReview(permId: String, sessionId: String, before: Int? = nil) async throws -> WatchSourceReview {
        var message: [String: Any] = ["_relay": "source_review", "permId": permId, "sessionId": sessionId]
        if let before { message["before"] = before }
        let review: WatchSourceReview = try await sourcePayload(message)
        guard review.permId == permId, review.sessionId == sessionId else { throw WatchRelayError.invalidResponse }
        return review
    }
    public func sourcePreview(permId: String, input: WatchSourceInput) async throws -> WatchSourcePreview {
        try await sourcePayload(["_relay": "source_preview", "permId": permId, "sessionId": input.sessionId,
            "input": JSONSerialization.jsonObject(with: JSONEncoder().encode(input))])
    }
    public func sourceMaterials(permId: String, input: WatchSourceMaterialsInput) async throws -> WatchSourceMaterialsPage {
        try await sourcePayload(["_relay": "source_materials", "permId": permId, "sessionId": input.sessionId,
            "input": JSONSerialization.jsonObject(with: JSONEncoder().encode(input))])
    }
    public func sourceApprove(permId: String, input: WatchSourceInput) async throws -> WatchSourceReceipt {
        try await sourcePayload(["_relay": "source_approve", "permId": permId, "sessionId": input.sessionId,
            "input": JSONSerialization.jsonObject(with: JSONEncoder().encode(input))])
    }

    private func notificationRelay(_ message: [String: Any]) async throws -> [String: Any] {
        guard isPhoneReachable else { throw WatchRelayError.notReachable }
        let reply = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<[String: Any], Error>) in
            let cont = UnsafeSendable(continuation)
            WCSession.default.sendMessage(message,
                replyHandler: { @Sendable reply in cont.value.resume(returning: UnsafeSendable(reply).value) },
                errorHandler: { @Sendable error in cont.value.resume(throwing: error) })
        }
        if let error = reply["error"] as? String { throw WatchRelayError.relayError(error) }
        return reply
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
