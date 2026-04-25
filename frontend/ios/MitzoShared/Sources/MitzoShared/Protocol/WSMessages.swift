// WebSocket v2 Protocol Messages
// Swift translation of packages/protocol/src/ws-schemas-v2.ts

import Foundation

// MARK: - Flexible Coding Key

struct AnyCodingKey: CodingKey {
    var stringValue: String
    var intValue: Int?

    init(_ key: String) {
        self.stringValue = key
        self.intValue = nil
    }

    init?(stringValue: String) {
        self.stringValue = stringValue
        self.intValue = nil
    }

    init?(intValue: Int) {
        self.stringValue = "\(intValue)"
        self.intValue = intValue
    }
}

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

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: AnyCodingKey.self)

        switch self {
        case .hello(let version):
            try container.encode("hello", forKey: AnyCodingKey("type"))
            try container.encode(version, forKey: AnyCodingKey("protocolVersion"))

        case .reconnect(let sessions):
            try container.encode("reconnect", forKey: AnyCodingKey("type"))
            try container.encode(sessions, forKey: AnyCodingKey("sessions"))

        case .watch(let sessionId):
            try container.encode("watch", forKey: AnyCodingKey("type"))
            try container.encode(sessionId, forKey: AnyCodingKey("sessionId"))

        case .unwatch(let sessionId):
            try container.encode("unwatch", forKey: AnyCodingKey("type"))
            try container.encode(sessionId, forKey: AnyCodingKey("sessionId"))

        case .switchSession(let sessionId):
            try container.encode("switch_session", forKey: AnyCodingKey("type"))
            try container.encode(sessionId, forKey: AnyCodingKey("sessionId"))

        case .sessionSuspend(let sessions):
            try container.encode("session_suspend", forKey: AnyCodingKey("type"))
            try container.encode(sessions, forKey: AnyCodingKey("sessions"))

        case .send(let params):
            try container.encode("send", forKey: AnyCodingKey("type"))
            try params.encodeFields(to: &container)

        case .interrupt(let params):
            try container.encode("interrupt", forKey: AnyCodingKey("type"))
            try params.encodeFields(to: &container)

        case .stop(let sessionId):
            try container.encode("stop", forKey: AnyCodingKey("type"))
            try container.encode(sessionId, forKey: AnyCodingKey("sessionId"))

        case .permissionResponse(let params):
            try container.encode("permission_response", forKey: AnyCodingKey("type"))
            try params.encodeFields(to: &container)

        case .setMode(let sessionId, let mode):
            try container.encode("set_mode", forKey: AnyCodingKey("type"))
            try container.encode(sessionId, forKey: AnyCodingKey("sessionId"))
            try container.encode(mode, forKey: AnyCodingKey("mode"))
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

public struct SendParams: Sendable {
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

    func encodeFields(to container: inout KeyedEncodingContainer<AnyCodingKey>) throws {
        try container.encode(sessionId, forKey: AnyCodingKey("sessionId"))
        try container.encode(prompt, forKey: AnyCodingKey("prompt"))
        try container.encode(clientMsgId, forKey: AnyCodingKey("clientMsgId"))
        try container.encodeIfPresent(model, forKey: AnyCodingKey("model"))
        try container.encodeIfPresent(mode, forKey: AnyCodingKey("mode"))
        try container.encodeIfPresent(cwd, forKey: AnyCodingKey("cwd"))
        try container.encodeIfPresent(extraTools, forKey: AnyCodingKey("extraTools"))
        try container.encodeIfPresent(isolation, forKey: AnyCodingKey("isolation"))
        try container.encodeIfPresent(images, forKey: AnyCodingKey("images"))
        try container.encodeIfPresent(contextBlocks, forKey: AnyCodingKey("contextBlocks"))
    }
}

public struct InterruptParams: Sendable {
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

    func encodeFields(to container: inout KeyedEncodingContainer<AnyCodingKey>) throws {
        try container.encode(sessionId, forKey: AnyCodingKey("sessionId"))
        try container.encode(prompt, forKey: AnyCodingKey("prompt"))
        try container.encode(clientMsgId, forKey: AnyCodingKey("clientMsgId"))
        try container.encodeIfPresent(images, forKey: AnyCodingKey("images"))
        try container.encodeIfPresent(contextBlocks, forKey: AnyCodingKey("contextBlocks"))
    }
}

public struct PermissionResponseParams: Sendable {
    public let sessionId: String?
    public let permId: String
    public let decision: PermissionDecision?

    public init(sessionId: String? = nil, permId: String, decision: PermissionDecision? = nil) {
        self.sessionId = sessionId
        self.permId = permId
        self.decision = decision
    }

    func encodeFields(to container: inout KeyedEncodingContainer<AnyCodingKey>) throws {
        try container.encodeIfPresent(sessionId, forKey: AnyCodingKey("sessionId"))
        try container.encode(permId, forKey: AnyCodingKey("permId"))
        try container.encodeIfPresent(decision, forKey: AnyCodingKey("decision"))
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
    case permissionRequest(PermissionRequestParams)
    case toolResult(ToolResultParams)
    case error(error: String)
    case modeChanged(sessionId: String, mode: MitzoMode)
    case unknown(type: String)

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: AnyCodingKey.self)
        let type = try container.decode(String.self, forKey: AnyCodingKey("type"))

        switch type {
        case "welcome":
            let protocolVersion = try container.decode(Int.self, forKey: AnyCodingKey("protocolVersion"))
            let connectionId = try container.decode(String.self, forKey: AnyCodingKey("connectionId"))
            self = .welcome(protocolVersion: protocolVersion, connectionId: connectionId)

        case "reconnected":
            let sessions = try container.decode([ReconnectedSession].self, forKey: AnyCodingKey("sessions"))
            self = .reconnected(sessions: sessions)

        case "watched":
            let sessionId = try container.decode(String.self, forKey: AnyCodingKey("sessionId"))
            self = .watched(sessionId: sessionId)

        case "unwatched":
            let sessionId = try container.decode(String.self, forKey: AnyCodingKey("sessionId"))
            self = .unwatched(sessionId: sessionId)

        case "session_switched":
            let params = try SessionSwitchedParams(from: decoder)
            self = .sessionSwitched(params)

        case "session_cleared":
            self = .sessionCleared

        case "session_id":
            let sessionId = try container.decode(String.self, forKey: AnyCodingKey("sessionId"))
            let seq = try container.decodeIfPresent(Int.self, forKey: AnyCodingKey("seq"))
            let ts = try container.decodeIfPresent(Int.self, forKey: AnyCodingKey("ts"))
            self = .sessionId(sessionId: sessionId, seq: seq, ts: ts)

        case "session_resumed":
            let sessionId = try container.decode(String.self, forKey: AnyCodingKey("sessionId"))
            let replayed = try container.decode(Int.self, forKey: AnyCodingKey("replayed"))
            self = .sessionResumed(sessionId: sessionId, replayed: replayed)

        case "session_takeover":
            let sessionId = try container.decode(String.self, forKey: AnyCodingKey("sessionId"))
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

        case "permission_request":
            let params = try PermissionRequestParams(from: decoder)
            self = .permissionRequest(params)

        case "tool_result":
            let params = try ToolResultParams(from: decoder)
            self = .toolResult(params)

        case "error":
            let error = try container.decode(String.self, forKey: AnyCodingKey("error"))
            self = .error(error: error)

        case "mode_changed":
            let sessionId = try container.decode(String.self, forKey: AnyCodingKey("sessionId"))
            let mode = try container.decode(MitzoMode.self, forKey: AnyCodingKey("mode"))
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

public struct PermissionRequestParams: Decodable, Sendable {
    public let permId: String
    public let toolName: String
    public let toolInput: String
    public let title: String?
    public let description: String?
    public let displayName: String?
    public let decisionReason: String?
    public let tier: ToolTier?
}

public struct ToolResultParams: Decodable, Sendable {
    public let messageId: String
    public let toolId: String
    public let result: String
    public let isError: Bool
}
