import Testing
import Foundation
@testable import MitzoShared

// MARK: - ClientMessage Encoding

@Test func testHelloEncoding() throws {
    let msg = ClientMessage.hello()
    let data = try JSONEncoder().encode(msg)
    let dict = try JSONSerialization.jsonObject(with: data) as! [String: Any]

    #expect(dict["type"] as? String == "hello")
    #expect(dict["protocolVersion"] as? Int == 2)
}

@Test func testWatchEncoding() throws {
    let msg = ClientMessage.watch(sessionId: "sess-123")
    let data = try JSONEncoder().encode(msg)
    let dict = try JSONSerialization.jsonObject(with: data) as! [String: Any]

    #expect(dict["type"] as? String == "watch")
    #expect(dict["sessionId"] as? String == "sess-123")
}

@Test func testSendEncoding() throws {
    let params = SendParams(sessionId: "sess-abc", prompt: "hello world", clientMsgId: "msg-1")
    let msg = ClientMessage.send(params)
    let data = try JSONEncoder().encode(msg)
    let dict = try JSONSerialization.jsonObject(with: data) as! [String: Any]

    #expect(dict["type"] as? String == "send")
    #expect(dict["sessionId"] as? String == "sess-abc")
    #expect(dict["prompt"] as? String == "hello world")
    #expect(dict["clientMsgId"] as? String == "msg-1")
}

@Test func testSendWithNullSessionEncoding() throws {
    let params = SendParams(sessionId: nil, prompt: "new session", clientMsgId: "msg-2")
    let msg = ClientMessage.send(params)
    let data = try JSONEncoder().encode(msg)
    let dict = try JSONSerialization.jsonObject(with: data) as! [String: Any]

    #expect(dict["type"] as? String == "send")
    #expect(dict["sessionId"] is NSNull)
}

@Test func testStopEncoding() throws {
    let msg = ClientMessage.stop(sessionId: "sess-xyz")
    let data = try JSONEncoder().encode(msg)
    let dict = try JSONSerialization.jsonObject(with: data) as! [String: Any]

    #expect(dict["type"] as? String == "stop")
    #expect(dict["sessionId"] as? String == "sess-xyz")
}

@Test func testPermissionResponseEncoding() throws {
    let params = PermissionResponseParams(sessionId: "sess-1", permId: "perm-abc", decision: .once)
    let msg = ClientMessage.permissionResponse(params)
    let data = try JSONEncoder().encode(msg)
    let dict = try JSONSerialization.jsonObject(with: data) as! [String: Any]

    #expect(dict["type"] as? String == "permission_response")
    #expect(dict["permId"] as? String == "perm-abc")
    #expect(dict["decision"] as? String == "once")
}

@Test func testSessionSuspendEncoding() throws {
    let sessions = [SuspendSession(sessionId: "s1", lastSeq: 42)]
    let msg = ClientMessage.sessionSuspend(sessions: sessions)
    let data = try JSONEncoder().encode(msg)
    let dict = try JSONSerialization.jsonObject(with: data) as! [String: Any]

    #expect(dict["type"] as? String == "session_suspend")
    let sessArr = dict["sessions"] as? [[String: Any]]
    #expect(sessArr?.count == 1)
    #expect(sessArr?[0]["sessionId"] as? String == "s1")
    #expect(sessArr?[0]["lastSeq"] as? Int == 42)
}

@Test func testSetModeEncoding() throws {
    let msg = ClientMessage.setMode(sessionId: "sess-1", mode: .agent)
    let data = try JSONEncoder().encode(msg)
    let dict = try JSONSerialization.jsonObject(with: data) as! [String: Any]

    #expect(dict["type"] as? String == "set_mode")
    #expect(dict["mode"] as? String == "agent")
}

// MARK: - ServerMessage Decoding

@Test func testWelcomeDecoding() throws {
    let json = """
    {"type":"welcome","protocolVersion":2,"connectionId":"conn-123-abc"}
    """.data(using: .utf8)!

    let msg = try JSONDecoder().decode(ServerMessage.self, from: json)
    guard case .welcome(let version, let connId) = msg else {
        Issue.record("Expected welcome")
        return
    }
    #expect(version == 2)
    #expect(connId == "conn-123-abc")
}

@Test func testBlockDeltaDecoding() throws {
    let json = """
    {"v":2,"type":"block_delta","messageId":"m1","blockId":"b1","blockType":"text","delta":"hello ","sessionId":"s1","seq":5,"ts":1234567890}
    """.data(using: .utf8)!

    let msg = try JSONDecoder().decode(ServerMessage.self, from: json)
    guard case .blockDelta(let params) = msg else {
        Issue.record("Expected block_delta")
        return
    }
    #expect(params.delta == "hello ")
    #expect(params.blockType == .text)
    #expect(params.seq == 5)
    #expect(params.sessionId == "s1")
}

@Test func testBlockStartToolUseDecoding() throws {
    let json = """
    {"v":2,"type":"block_start","messageId":"m1","blockId":"b2","blockType":"tool_use","sessionId":"s1","seq":3,"ts":100,"toolName":"Read"}
    """.data(using: .utf8)!

    let msg = try JSONDecoder().decode(ServerMessage.self, from: json)
    guard case .blockStart(let params) = msg else {
        Issue.record("Expected block_start")
        return
    }
    #expect(params.blockType == .toolUse)
    #expect(params.toolName == "Read")
}

@Test func testPermissionRequestDecoding() throws {
    let json = """
    {"type":"permission_request","permId":"perm-abc","toolName":"Bash","toolInput":"npm test","displayName":"Run command","tier":"standard"}
    """.data(using: .utf8)!

    let msg = try JSONDecoder().decode(ServerMessage.self, from: json)
    guard case .permissionRequest(let params) = msg else {
        Issue.record("Expected permission_request")
        return
    }
    #expect(params.permId == "perm-abc")
    #expect(params.toolName == "Bash")
    #expect(params.tier == .standard)
}

@Test func testToolResultDecoding() throws {
    let json = """
    {"type":"tool_result","messageId":"m1","toolId":"t1","result":"file contents here","isError":false}
    """.data(using: .utf8)!

    let msg = try JSONDecoder().decode(ServerMessage.self, from: json)
    guard case .toolResult(let params) = msg else {
        Issue.record("Expected tool_result")
        return
    }
    #expect(params.toolId == "t1")
    #expect(params.isError == false)
}

@Test func testErrorDecoding() throws {
    let json = """
    {"type":"error","error":"something went wrong"}
    """.data(using: .utf8)!

    let msg = try JSONDecoder().decode(ServerMessage.self, from: json)
    guard case .error(let err) = msg else {
        Issue.record("Expected error")
        return
    }
    #expect(err == "something went wrong")
}

@Test func testUnknownTypeDecoding() throws {
    let json = """
    {"type":"future_message_type","data":"whatever"}
    """.data(using: .utf8)!

    let msg = try JSONDecoder().decode(ServerMessage.self, from: json)
    guard case .unknown(let type) = msg else {
        Issue.record("Expected unknown")
        return
    }
    #expect(type == "future_message_type")
}

// MARK: - CoreTypes Decoding

@Test func testSessionDecoding() throws {
    let json = """
    {"id":"sess-1","summary":"Fix the login bug","lastModified":1714070400000,"branch":"fix/login","cwd":"/home/user","isActive":true,"isAttached":false,"totalTokens":5000,"numTurns":3}
    """.data(using: .utf8)!

    let session = try JSONDecoder().decode(Session.self, from: json)
    #expect(session.id == "sess-1")
    #expect(session.summary == "Fix the login bug")
    #expect(session.branch == "fix/login")
    #expect(session.isActive == true)
    #expect(session.totalTokens == 5000)
}

@Test func testSessionMinimalDecoding() throws {
    let json = """
    {"id":"sess-2","summary":"Quick question","lastModified":1714070400000}
    """.data(using: .utf8)!

    let session = try JSONDecoder().decode(Session.self, from: json)
    #expect(session.id == "sess-2")
    #expect(session.branch == nil)
    #expect(session.isActive == nil)
}

@Test func testSessionsResponseDecoding() throws {
    let json = """
    {"sessions":[{"id":"s1","summary":"Test","lastModified":100}],"hasMore":true}
    """.data(using: .utf8)!

    let response = try JSONDecoder().decode(SessionsResponse.self, from: json)
    #expect(response.sessions.count == 1)
    #expect(response.hasMore == true)
}

@Test func testFinishedMessageDecoding() throws {
    let json = """
    {"messageId":"m1","role":"assistant","blocks":[{"blockId":"b1","blockType":"text","content":"Hello!"}]}
    """.data(using: .utf8)!

    let msg = try JSONDecoder().decode(FinishedMessage.self, from: json)
    #expect(msg.role == .assistant)
    #expect(msg.blocks.count == 1)
    #expect(msg.blocks[0].content == "Hello!")
}

@Test func testBlockTypeDecoding() throws {
    let cases: [(String, BlockType)] = [
        ("\"text\"", .text),
        ("\"thinking\"", .thinking),
        ("\"redacted_thinking\"", .redactedThinking),
        ("\"tool_use\"", .toolUse),
    ]

    for (jsonStr, expected) in cases {
        let data = jsonStr.data(using: .utf8)!
        let decoded = try JSONDecoder().decode(BlockType.self, from: data)
        #expect(decoded == expected)
    }
}
