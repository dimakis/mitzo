// WebSocket v2 Protocol Messages
// Swift translation of packages/protocol/src/ws-schemas-v2.ts

import Foundation

// MARK: - Client → Server Messages

public enum ClientMessage: Encodable, Sendable {
    case hello(protocolVersion: Int = 2)
    case reconnect(sessions: [ReconnectSession])
    case watch(sessionId: String)
    case unwatch(sessionId: String)
    case switchSession(sessionId: String?)
    case sessionSuspend(sessions: [SuspendSession])
    case send(SendParams)
    case interrupt(InterruptParams)
    case stop(sessionId: String)
    case permissionResponse(PermissionResponseParams)
    case setMode(sessionId: String, mode: MitzoMode)

    private enum CodingKeys: String, CodingKey {
        case type
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)

        switch self {
        case .hello(let version):
            try container.encode("hello", forKey: .type)
            try container.encode(version, forKey: CodingKeys(stringValue: "protocolVersion")!)

        case .reconnect(let sessions):
            try container.encode("reconnect", forKey: .type)
            try container.encode(sessions, forKey: CodingKeys(stringValue: "sessions")!)

        case .watch(let sessionId):
            try container.encode("watch", forKey: .type)
            try container.encode(sessionId, forKey: CodingKeys(stringValue: "sessionId")!)

        case .unwatch(let sessionId):
            try container.encode("unwatch", forKey: .type)
            try container.encode(sessionId, forKey: CodingKeys(stringValue: "sessionId")!)

        case .switchSession(let sessionId):
            try container.encode("switch_session", forKey: .type)
            try container.encode(sessionId, forKey: CodingKeys(stringValue: "sessionId")!)

        case .sessionSuspend(let sessions):
            try container.encode("session_suspend", forKey: .type)
            try container.encode(sessions, forKey: CodingKeys(stringValue: "sessions")!)

        case .send(let params):
            try container.encode("send", forKey: .type)
            try params.encode(to: encoder)

        case .interrupt(let params):
            try container.encode("interrupt", forKey: .type)
            try params.encode(to: encoder)

        case .stop(let sessionId):
            try container.encode("stop", forKey: .type)
            try container.encode(sessionId, forKey: CodingKeys(stringValue: "sessionId")!)

        case .permissionResponse(let params):
            try container.encode("permission_response", forKey: .type)
            try params.encode(to: encoder)

        case .setMode(let sessionId, let mode):
            try container.encode("set_mode", forKey: .type)
            try container.encode(sessionId, forKey: CodingKeys(stringValue: "sessionId")!)
            try container.encode(mode, forKey: CodingKeys(stringValue: "mode")!)
        }
    }
}

public struct ReconnectSession: Codable, Sendable {
    public let sessionId: String
    public let lastSeq: Int

    public init(sessionId: String, lastSeq: Int) {
        self.sessionId = sessionId
        self.lastSeq = lastSeq
    }
}

public struct SuspendSession: Codable, Sendable {
    public let sessionId: String
    public let lastSeq: Int

    public init(sessionId: String, lastSeq: Int) {
        self.sessionId = sessionId
        self.lastSeq = lastSeq
    }
}

public struct SendParams: Encodable, Sendable {
    public let sessionId: String?
    public let prompt: String
    public let clientMsgId: String
    public let model: String?
    public let mode: MitzoMode?
    public let cwd: String?
    public let extraTools: String?
    public let isolation: Bool?
    public let images: [ImageAttachment]?
    public let contextBlocks: [String]?

    public init(
        sessionId: String?,
        prompt: String,
        clientMsgId: String = UUID().uuidString,
        model: String? = nil,
        mode: MitzoMode? = nil,
        cwd: String? = nil,
        extraTools: String? = nil,
        isolation: Bool? = nil,
        images: [ImageAttachment]? = nil,
        contextBlocks: [String]? = nil
    ) {
        self.sessionId = sessionId
        self.prompt = prompt
        self.clientMsgId = clientMsgId
        self.model = model
        self.mode = mode
        self.cwd = cwd
        self.extraTools = extraTools
        self.isolation = isolation
        self.images = images
        self.contextBlocks = contextBlocks
    }
}

public struct InterruptParams: Encodable, Sendable {
    public let sessionId: String
    public let prompt: String
    public let clientMsgId: String
    public let images: [ImageAttachment]?
    public let contextBlocks: [String]?

    public init(
        sessionId: String,
        prompt: String,
        clientMsgId: String = UUID().uuidString,
        images: [ImageAttachment]? = nil,
        contextBlocks: [String]? = nil
    ) {
        self.sessionId = sessionId
        self.prompt = prompt
        self.clientMsgId = clientMsgId
        self.images = images
        self.contextBlocks = contextBlocks
    }
}

public struct PermissionResponseParams: Encodable, Sendable {
    public let sessionId: String?
    public let permId: String
    public let decision: PermissionDecision?

    public init(sessionId: String? = nil, permId: String, decision: PermissionDecision? = nil) {
        self.sessionId = sessionId
        self.permId = permId
        self.decision = decision
    }
}

public enum PermissionDecision: String, Codable, Sendable {
    case once
    case always
    case deny
}

// MARK: - Server → Client Messages

public enum ServerMessage: Decodable, Sendable {
    case welcome(protocolVersion: Int, connectionId: String)
    case reconnected(sessions: [ReconnectedSession])
    case watched(sessionId: String)
    case unwatched(sessionId: String)
    case sessionSwitched(SessionSwitchedParams)
    case sessionCleared
    case sessionId(sessionId: String, seq: Int?, ts: Int?)
    case sessionResumed(sessionId: String, replayed: Int)
    case sessionTakeover(sessionId: String)
    case sessionEnd(SessionEndParams)
    case messageStart(MessageStartParams)
    case blockStart(BlockStartParams)
    case blockDelta(BlockDeltaParams)
    case blockEnd(BlockEndParams)
    case messageEnd(MessageEndParams)
    case tokenUpdate(TokenUpdateParams)
    case error(error: String)
    case modeChanged(sessionId: String, mode: MitzoMode)
    case unknown(type: String)

    enum CodingKeys: String, CodingKey {
        case type, v
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)

        switch type {
        case "welcome":
            let protocolVersion = try decoder.container(keyedBy: AnyCodingKey.self)
                .decode(Int.self, forKey: AnyCodingKey(stringValue: "protocolVersion")!)
            let connectionId = try decoder.container(keyedBy: AnyCodingKey.self)
                .decode(String.self, forKey: AnyCodingKey(stringValue: "connectionId")!)
            self = .welcome(protocolVersion: protocolVersion, connectionId: connectionId)

        case "reconnected":
            let sessions = try decoder.container(keyedBy: AnyCodingKey.self)
                .decode([ReconnectedSession].self, forKey: AnyCodingKey(stringValue: "sessions")!)
            self = .reconnected(sessions: sessions)

        case "watched":
            let sessionId = try decoder.container(keyedBy: AnyCodingKey.self)
                .decode(String.self, forKey: AnyCodingKey(stringValue: "sessionId")!)
            self = .watched(sessionId: sessionId)

        case "unwatched":
            let sessionId = try decoder.container(keyedBy: AnyCodingKey.self)
                .decode(String.self, forKey: AnyCodingKey(stringValue: "sessionId")!)
            self = .unwatched(sessionId: sessionId)

        case "session_switched":
            let params = try SessionSwitchedParams(from: decoder)
            self = .sessionSwitched(params)

        case "session_cleared":
            self = .sessionCleared

        case "session_id":
            let sessionId = try decoder.container(keyedBy: AnyCodingKey.self)
                .decode(String.self, forKey: AnyCodingKey(stringValue: "sessionId")!)
            let seq = try? decoder.container(keyedBy: AnyCodingKey.self)
                .decode(Int.self, forKey: AnyCodingKey(stringValue: "seq")!)
            let ts = try? decoder.container(keyedBy: AnyCodingKey.self)
                .decode(Int.self, forKey: AnyCodingKey(stringValue: "ts")!)
            self = .sessionId(sessionId: sessionId, seq: seq, ts: ts)

        case "session_resumed":
            let sessionId = try decoder.container(keyedBy: AnyCodingKey.self)
                .decode(String.self, forKey: AnyCodingKey(stringValue: "sessionId")!)
            let replayed = try decoder.container(keyedBy: AnyCodingKey.self)
                .decode(Int.self, forKey: AnyCodingKey(stringValue: "replayed")!)
            self = .sessionResumed(sessionId: sessionId, replayed: replayed)

        case "session_takeover":
            let sessionId = try decoder.container(keyedBy: AnyCodingKey.self)
                .decode(String.self, forKey: AnyCodingKey(stringValue: "sessionId")!)
            self = .sessionTakeover(sessionId: sessionId)

        case "session_end":
            let params = try SessionEndParams(from: decoder)
            self = .sessionEnd(params)

        case "message_start":
            let params = try MessageStartParams(from: decoder)
            self = .messageStart(params)

        case "block_start":
            let params = try BlockStartParams(from: decoder)
            self = .blockStart(params)

        case "block_delta":
            let params = try BlockDeltaParams(from: decoder)
            self = .blockDelta(params)

        case "block_end":
            let params = try BlockEndParams(from: decoder)
            self = .blockEnd(params)

        case "message_end":
            let params = try MessageEndParams(from: decoder)
            self = .messageEnd(params)

        case "token_update":
            let params = try TokenUpdateParams(from: decoder)
            self = .tokenUpdate(params)

        case "error":
            let error = try decoder.container(keyedBy: AnyCodingKey.self)
                .decode(String.self, forKey: AnyCodingKey(stringValue: "error")!)
            self = .error(error: error)

        case "mode_changed":
            let sessionId = try decoder.container(keyedBy: AnyCodingKey.self)
                .decode(String.self, forKey: AnyCodingKey(stringValue: "sessionId")!)
            let mode = try decoder.container(keyedBy: AnyCodingKey.self)
                .decode(MitzoMode.self, forKey: AnyCodingKey(stringValue: "mode")!)
            self = .modeChanged(sessionId: sessionId, mode: mode)

        default:
            self = .unknown(type: type)
        }
    }
}

// MARK: - Server Message Params

public struct ReconnectedSession: Decodable, Sendable {
    public let sessionId: String
    public let replayed: Int
    public let running: Bool
}

public struct SessionSwitchedParams: Decodable, Sendable {
    public let sessionId: String
    public let mode: MitzoMode
    public let cwd: String
    public let branch: String
    public let wtId: String?
    public let tokens: TokenUsage
}

public struct SessionEndParams: Decodable, Sendable {
    public let sessionId: String
    public let usage: UsageStats
}

public struct UsageStats: Decodable, Sendable {
    public let inputTokens: Int
    public let outputTokens: Int
    public let cacheReadTokens: Int
    public let cacheCreationTokens: Int
    public let totalCostUsd: Double
    public let numTurns: Int
    public let durationMs: Int
    public let durationApiMs: Int
}

public struct MessageStartParams: Decodable, Sendable {
    public let messageId: String
    public let sessionId: String
    public let seq: Int
    public let ts: Int
}

public struct BlockStartParams: Decodable, Sendable {
    public let messageId: String
    public let blockId: String
    public let blockType: BlockType
    public let sessionId: String
    public let seq: Int
    public let ts: Int
    public let toolName: String?
}

public struct BlockDeltaParams: Decodable, Sendable {
    public let messageId: String
    public let blockId: String
    public let blockType: BlockType
    public let delta: String
    public let sessionId: String
    public let seq: Int
    public let ts: Int
}

public struct BlockEndParams: Decodable, Sendable {
    public let messageId: String
    public let blockId: String
    public let blockType: BlockType
    public let sessionId: String
    public let seq: Int
    public let ts: Int
    public let toolName: String?
    public let toolId: String?
    public let input: String?
}

public struct MessageEndParams: Decodable, Sendable {
    public let messageId: String
    public let sessionId: String
    public let seq: Int
    public let ts: Int
}

public struct TokenUpdateParams: Decodable, Sendable {
    public let agentContext: Int
    public let contextCeiling: Int
    public let sessionTotal: Int
    public let turnIndex: Int
    public let numCompactions: Int?
    public let sessionId: String?
    public let seq: Int?
    public let ts: Int?
}

// MARK: - Helper

private struct AnyCodingKey: CodingKey {
    var stringValue: String
    var intValue: Int?

    init?(stringValue: String) {
        self.stringValue = stringValue
        self.intValue = nil
    }

    init?(intValue: Int) {
        self.stringValue = "\(intValue)"
        self.intValue = intValue
    }
}
