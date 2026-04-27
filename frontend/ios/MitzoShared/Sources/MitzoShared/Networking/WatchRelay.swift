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

    public func activate(wsClient: MitzoWSClient) {
        state.setWSClient(wsClient)

        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
    }

    // MARK: - WCSessionDelegate

    public func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {}

    public func sessionDidBecomeInactive(_ session: WCSession) {}
    public func sessionDidDeactivate(_ session: WCSession) {
        WCSession.default.activate()
    }

    public func session(_ session: WCSession, didReceiveMessage message: [String: Any], replyHandler: @escaping ([String: Any]) -> Void) {
        guard let type = message["_relay"] as? String else {
            replyHandler(["error": "missing _relay type"])
            return
        }

        // Extract values before crossing the Task isolation boundary
        // so we don't capture the non-Sendable [String: Any] dict.
        let clientMsg: ClientMessage?
        if type == "send" {
            clientMsg = try? decodeClientMessage(from: message)
        } else {
            clientMsg = nil
        }
        let reply = UnsafeSendable(replyHandler)

        Task {
            do {
                switch type {
                case "send":
                    guard let clientMsg else {
                        reply.value(["error": "invalid message"])
                        return
                    }
                    try await state.getWSClient()?.send(clientMsg)
                    reply.value(["ok": true])

                case "auth_token":
                    if let token = try? await authManager.getToken() {
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
}
#endif
