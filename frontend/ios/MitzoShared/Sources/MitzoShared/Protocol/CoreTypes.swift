// Core protocol types mirroring @mitzo/protocol
// Swift translation of packages/protocol/src/types.ts

import Foundation

// MARK: - Modes & Enums

public enum MitzoMode: String, Codable, Sendable {
    case ask
    case agent
    case auto
}

public enum BlockType: String, Codable, Sendable {
    case text
    case thinking
    case redactedThinking = "redacted_thinking"
    case toolUse = "tool_use"
}

public enum ToolTier: String, Codable, Sendable {
    case safe
    case standard
    case elevated
    case unknown
}

// MARK: - Tool Input

public enum RawToolInputType: String, Codable, Sendable {
    case write
    case diff
    case command
}

public struct RawToolInput: Codable, Sendable {
    public let type: RawToolInputType
    public let path: String?
    public let contents: String?
    public let oldString: String?
    public let newString: String?
    public let command: String?

    enum CodingKeys: String, CodingKey {
        case type, path, contents
        case oldString = "old_string"
        case newString = "new_string"
        case command
    }
}

// MARK: - Snapshot

public struct SnapshotBlock: Codable, Sendable {
    public let blockId: String
    public let blockType: BlockType
    public let content: String
    public let done: Bool
    public let toolName: String?
    public let toolId: String?
    public let toolInput: String?
    public let rawInput: RawToolInput?
}

public struct MessageSnapshot: Codable, Sendable {
    public let messageId: String
    public let blocks: [SnapshotBlock]
}

// MARK: - Streaming Message

public struct StreamingBlock: Sendable {
    public var blockId: String
    public var blockType: BlockType
    public var content: String
    public var done: Bool
    public var toolName: String?
    public var toolId: String?
    public var toolInput: String?
    public var rawInput: RawToolInput?
    public var toolResult: String?
    public var toolError: Bool?

    public init(
        blockId: String,
        blockType: BlockType,
        content: String = "",
        done: Bool = false,
        toolName: String? = nil,
        toolId: String? = nil,
        toolInput: String? = nil,
        rawInput: RawToolInput? = nil,
        toolResult: String? = nil,
        toolError: Bool? = nil
    ) {
        self.blockId = blockId
        self.blockType = blockType
        self.content = content
        self.done = done
        self.toolName = toolName
        self.toolId = toolId
        self.toolInput = toolInput
        self.rawInput = rawInput
        self.toolResult = toolResult
        self.toolError = toolError
    }
}

public struct StreamingMessage: Sendable {
    public var messageId: String
    public var blocks: [String: StreamingBlock]
    public var blockOrder: [String]

    public init(messageId: String) {
        self.messageId = messageId
        self.blocks = [:]
        self.blockOrder = []
    }
}

// MARK: - Finished Message

public struct FinishedBlock: Codable, Sendable {
    public let blockId: String
    public let blockType: BlockType
    public let content: String
    public let toolName: String?
    public let toolId: String?
    public let toolInput: String?
    public let rawInput: RawToolInput?
    public let toolResult: String?
    public let toolError: Bool?

    public init(blockId: String, blockType: BlockType, content: String, toolName: String? = nil, toolId: String? = nil, toolInput: String? = nil, rawInput: RawToolInput? = nil, toolResult: String? = nil, toolError: Bool? = nil) {
        self.blockId = blockId
        self.blockType = blockType
        self.content = content
        self.toolName = toolName
        self.toolId = toolId
        self.toolInput = toolInput
        self.rawInput = rawInput
        self.toolResult = toolResult
        self.toolError = toolError
    }
}

public enum MessageRole: String, Codable, Sendable {
    case user
    case assistant
}

public struct FinishedMessage: Codable, Sendable {
    public let messageId: String
    public let role: MessageRole
    public let blocks: [FinishedBlock]
    public let images: [String]?
    public let contextBlocks: [String]?
    public let timestamp: Int?

    public init(messageId: String, role: MessageRole, blocks: [FinishedBlock], images: [String]? = nil, contextBlocks: [String]? = nil, timestamp: Int? = nil) {
        self.messageId = messageId
        self.role = role
        self.blocks = blocks
        self.images = images
        self.contextBlocks = contextBlocks
        self.timestamp = timestamp
    }
}

// MARK: - Permission

public struct PermissionRequest: Codable, Sendable {
    public let permId: String
    public let toolName: String
    public let toolInput: String
    public let title: String?
    public let description: String?
    public let displayName: String?
    public let tier: ToolTier?
}

// MARK: - Image Attachment

public struct ImageAttachment: Codable, Sendable {
    public let data: String
    public let mediaType: String
    public let preview: String?
}

// MARK: - Session (matches GET /api/sessions response)

public struct Session: Codable, Sendable, Identifiable {
    public let id: String
    public let summary: String
    public let lastModified: Int
    public let branch: String?
    public let cwd: String?
    public let isActive: Bool?
    public let isAttached: Bool?
    public let totalTokens: Int?
    public let numTurns: Int?
}

public struct SessionsResponse: Codable, Sendable {
    public let sessions: [Session]
    public let hasMore: Bool

    public init(sessions: [Session], hasMore: Bool) {
        self.sessions = sessions
        self.hasMore = hasMore
    }
}

// MARK: - Session Metadata (matches GET /api/sessions/:id/meta)

public struct SessionMeta: Codable, Sendable {
    public let sessionId: String
    public let branch: String?
    public let wtId: String?
    public let cwd: String?
    public let mode: MitzoMode
    public let isActive: Bool
    public let totalTokens: Int?
    public let totalCostUsd: Double?
    public let numTurns: Int?
}

public struct TokenUsage: Codable, Sendable {
    public let input: Int
    public let output: Int
    public let cacheRead: Int
    public let cacheCreation: Int
    public let costUsd: Double
}
