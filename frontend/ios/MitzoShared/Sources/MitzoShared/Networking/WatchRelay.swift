// WatchConnectivity relay — bridges WS messages between watch and iPhone
//
// iPhone side: receives relay messages from watch, forwards to/from WS
// Watch side: sends messages via WCSession when direct WS is unavailable

#if os(iOS)
import WatchConnectivity
import Foundation

/// iPhone-side relay: bridges watch messages to the Mitzo WS connection.
/// Add to AppDelegate or a long-lived coordinator.
public final class WatchRelayHost: NSObject, WCSessionDelegate, @unchecked Sendable {
    private var wsClient: MitzoWSClient?
    private let authManager: AuthManager

    public init(authManager: AuthManager) {
        self.authManager = authManager
        super.init()
    }

    public func activate(wsClient: MitzoWSClient) {
        self.wsClient = wsClient

        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
    }

    // MARK: - WCSessionDelegate

    public func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        // Ready to relay
    }

    public func sessionDidBecomeInactive(_ session: WCSession) {}
    public func sessionDidDeactivate(_ session: WCSession) {
        WCSession.default.activate()
    }

    /// Watch sends a message dict, we forward it as a ClientMessage to the WS
    public func session(_ session: WCSession, didReceiveMessage message: [String: Any], replyHandler: @escaping ([String: Any]) -> Void) {
        guard let type = message["_relay"] as? String else {
            replyHandler(["error": "missing _relay type"])
            return
        }

        Task {
            do {
                switch type {
                case "send":
                    let clientMsg = try decodeClientMessage(from: message)
                    try await wsClient?.send(clientMsg)
                    replyHandler(["ok": true])

                case "auth_token":
                    // Watch requests auth token from phone's keychain
                    if let token = try? await authManager.getToken() {
                        replyHandler(["token": token])
                    } else {
                        replyHandler(["error": "no_token"])
                    }

                default:
                    replyHandler(["error": "unknown relay type: \(type)"])
                }
            } catch {
                replyHandler(["error": error.localizedDescription])
            }
        }
    }

    /// Forward server messages to the watch
    public func forwardToWatch(_ message: ServerMessage) {
        guard WCSession.default.isReachable else { return }

        // Encode server message to JSON dict for WCSession
        do {
            let data = try JSONEncoder().encode(ServerMessageWrapper(message: message))
            if let dict = try JSONSerialization.jsonObject(with: data) as? [String: Any] {
                WCSession.default.sendMessage(["_relay": "server_event", "_payload": dict], replyHandler: nil)
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
                clientMsgId: dict["clientMsgId"] as? String ?? UUID().uuidString
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
            // Relay suspend from watch
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
}

enum RelayError: Error {
    case missingAction
    case missingSessionId
    case unknownAction(String)
}

/// Wrapper to make ServerMessage Encodable for relay
struct ServerMessageWrapper: Encodable {
    let message: ServerMessage

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: AnyCodingKey.self)

        switch message {
        case .welcome(let version, let connId):
            try container.encode("welcome", forKey: AnyCodingKey("type"))
            try container.encode(version, forKey: AnyCodingKey("protocolVersion"))
            try container.encode(connId, forKey: AnyCodingKey("connectionId"))

        case .blockDelta(let params):
            try container.encode("block_delta", forKey: AnyCodingKey("type"))
            try container.encode(params.messageId, forKey: AnyCodingKey("messageId"))
            try container.encode(params.blockId, forKey: AnyCodingKey("blockId"))
            try container.encode(params.blockType, forKey: AnyCodingKey("blockType"))
            try container.encode(params.delta, forKey: AnyCodingKey("delta"))
            try container.encode(params.sessionId, forKey: AnyCodingKey("sessionId"))
            try container.encode(params.seq, forKey: AnyCodingKey("seq"))

        case .messageStart(let params):
            try container.encode("message_start", forKey: AnyCodingKey("type"))
            try container.encode(params.messageId, forKey: AnyCodingKey("messageId"))
            try container.encode(params.sessionId, forKey: AnyCodingKey("sessionId"))
            try container.encode(params.seq, forKey: AnyCodingKey("seq"))

        case .blockStart(let params):
            try container.encode("block_start", forKey: AnyCodingKey("type"))
            try container.encode(params.messageId, forKey: AnyCodingKey("messageId"))
            try container.encode(params.blockId, forKey: AnyCodingKey("blockId"))
            try container.encode(params.blockType, forKey: AnyCodingKey("blockType"))
            try container.encode(params.sessionId, forKey: AnyCodingKey("sessionId"))
            try container.encode(params.seq, forKey: AnyCodingKey("seq"))
            try container.encodeIfPresent(params.toolName, forKey: AnyCodingKey("toolName"))

        case .blockEnd(let params):
            try container.encode("block_end", forKey: AnyCodingKey("type"))
            try container.encode(params.messageId, forKey: AnyCodingKey("messageId"))
            try container.encode(params.blockId, forKey: AnyCodingKey("blockId"))
            try container.encode(params.blockType, forKey: AnyCodingKey("blockType"))
            try container.encode(params.sessionId, forKey: AnyCodingKey("sessionId"))
            try container.encode(params.seq, forKey: AnyCodingKey("seq"))
            try container.encodeIfPresent(params.toolName, forKey: AnyCodingKey("toolName"))
            try container.encodeIfPresent(params.toolId, forKey: AnyCodingKey("toolId"))

        case .messageEnd(let params):
            try container.encode("message_end", forKey: AnyCodingKey("type"))
            try container.encode(params.messageId, forKey: AnyCodingKey("messageId"))
            try container.encode(params.sessionId, forKey: AnyCodingKey("sessionId"))
            try container.encode(params.seq, forKey: AnyCodingKey("seq"))

        case .permissionRequest(let params):
            try container.encode("permission_request", forKey: AnyCodingKey("type"))
            try container.encode(params.permId, forKey: AnyCodingKey("permId"))
            try container.encode(params.toolName, forKey: AnyCodingKey("toolName"))
            try container.encode(params.toolInput, forKey: AnyCodingKey("toolInput"))
            try container.encodeIfPresent(params.displayName, forKey: AnyCodingKey("displayName"))
            try container.encodeIfPresent(params.tier, forKey: AnyCodingKey("tier"))

        case .sessionEnd(let params):
            try container.encode("session_end", forKey: AnyCodingKey("type"))
            try container.encode(params.sessionId, forKey: AnyCodingKey("sessionId"))

        case .error(let err):
            try container.encode("error", forKey: AnyCodingKey("type"))
            try container.encode(err, forKey: AnyCodingKey("error"))

        default:
            // For other message types, encode just the type
            try container.encode("unknown", forKey: AnyCodingKey("type"))
        }
    }
}

#endif

// MARK: - Watch-side relay client

#if os(watchOS)
import WatchConnectivity
import Foundation

/// Watch-side relay: sends messages through iPhone when direct WS is unavailable.
public final class WatchRelayClient: NSObject, WCSessionDelegate, @unchecked Sendable {
    public var onServerMessage: ((ServerMessage) -> Void)?
    public var isPhoneReachable: Bool { WCSession.default.isReachable }

    public override init() {
        super.init()
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
            WCSession.default.sendMessage(message, replyHandler: { reply in
                continuation.resume(returning: reply)
            }, errorHandler: { error in
                continuation.resume(throwing: error)
            })
        }
    }

    /// Request auth token from phone
    public func requestAuthToken() async throws -> String {
        let reply = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<[String: Any], Error>) in
            WCSession.default.sendMessage(
                ["_relay": "auth_token"],
                replyHandler: { reply in continuation.resume(returning: reply) },
                errorHandler: { error in continuation.resume(throwing: error) }
            )
        }

        guard let token = reply["token"] as? String else {
            throw WatchRelayError.noToken
        }
        return token
    }

    // MARK: - WCSessionDelegate

    public func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {}

    /// Receive relayed server messages from phone
    public func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        guard message["_relay"] as? String == "server_event",
              let payload = message["_payload"] as? [String: Any] else { return }

        // Decode the ServerMessage from the payload dict
        do {
            let data = try JSONSerialization.data(withJSONObject: payload)
            let serverMsg = try JSONDecoder().decode(ServerMessage.self, from: data)
            onServerMessage?(serverMsg)
        } catch {
            // Decoding failure — drop the message
        }
    }
}

enum WatchRelayError: Error {
    case noToken
    case notReachable
}
#endif
