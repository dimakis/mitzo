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

// MARK: - ServerMessage Encode → Decode Round-Trip (relay simulation)

@Test func testBlockDeltaRoundTrip() throws {
    let json = """
    {"v":2,"type":"block_delta","messageId":"m1","blockId":"b1","blockType":"text","delta":"hello ","sessionId":"s1","seq":5,"ts":1714070400}
    """.data(using: .utf8)!

    let original = try JSONDecoder().decode(ServerMessage.self, from: json)
    let encoded = try JSONEncoder().encode(original)
    let decoded = try JSONDecoder().decode(ServerMessage.self, from: encoded)

    guard case .blockDelta(let params) = decoded else {
        Issue.record("Expected block_delta after round-trip")
        return
    }
    #expect(params.delta == "hello ")
    #expect(params.ts == 1714070400)
    #expect(params.seq == 5)
    #expect(params.sessionId == "s1")
    #expect(params.blockType == .text)
}

@Test func testMessageStartRoundTrip() throws {
    let json = """
    {"type":"message_start","messageId":"m1","sessionId":"s1","seq":1,"ts":1714070400}
    """.data(using: .utf8)!

    let original = try JSONDecoder().decode(ServerMessage.self, from: json)
    let encoded = try JSONEncoder().encode(original)
    let decoded = try JSONDecoder().decode(ServerMessage.self, from: encoded)

    guard case .messageStart(let params) = decoded else {
        Issue.record("Expected message_start after round-trip")
        return
    }
    #expect(params.messageId == "m1")
    #expect(params.ts == 1714070400)
    #expect(params.seq == 1)
}

@Test func testBlockStartRoundTrip() throws {
    let json = """
    {"type":"block_start","messageId":"m1","blockId":"b1","blockType":"tool_use","sessionId":"s1","seq":2,"ts":1714070401,"toolName":"Read"}
    """.data(using: .utf8)!

    let original = try JSONDecoder().decode(ServerMessage.self, from: json)
    let encoded = try JSONEncoder().encode(original)
    let decoded = try JSONDecoder().decode(ServerMessage.self, from: encoded)

    guard case .blockStart(let params) = decoded else {
        Issue.record("Expected block_start after round-trip")
        return
    }
    #expect(params.toolName == "Read")
    #expect(params.ts == 1714070401)
    #expect(params.blockType == .toolUse)
}

@Test func testBlockEndRoundTrip() throws {
    let json = """
    {"type":"block_end","messageId":"m1","blockId":"b1","blockType":"tool_use","sessionId":"s1","seq":3,"ts":1714070402,"toolName":"Read","toolId":"t1","input":"{\\"path\\":\\"/foo\\"}"}
    """.data(using: .utf8)!

    let original = try JSONDecoder().decode(ServerMessage.self, from: json)
    let encoded = try JSONEncoder().encode(original)
    let decoded = try JSONDecoder().decode(ServerMessage.self, from: encoded)

    guard case .blockEnd(let params) = decoded else {
        Issue.record("Expected block_end after round-trip")
        return
    }
    #expect(params.toolName == "Read")
    #expect(params.toolId == "t1")
    #expect(params.input == "{\"path\":\"/foo\"}")
    #expect(params.ts == 1714070402)
}

@Test func testMessageEndRoundTrip() throws {
    let json = """
    {"type":"message_end","messageId":"m1","sessionId":"s1","seq":4,"ts":1714070403}
    """.data(using: .utf8)!

    let original = try JSONDecoder().decode(ServerMessage.self, from: json)
    let encoded = try JSONEncoder().encode(original)
    let decoded = try JSONDecoder().decode(ServerMessage.self, from: encoded)

    guard case .messageEnd(let params) = decoded else {
        Issue.record("Expected message_end after round-trip")
        return
    }
    #expect(params.ts == 1714070403)
    #expect(params.seq == 4)
}

@Test func testToolResultRoundTrip() throws {
    let json = """
    {"type":"tool_result","messageId":"m1","toolId":"t1","result":"file contents","isError":false}
    """.data(using: .utf8)!

    let original = try JSONDecoder().decode(ServerMessage.self, from: json)
    let encoded = try JSONEncoder().encode(original)
    let decoded = try JSONDecoder().decode(ServerMessage.self, from: encoded)

    guard case .toolResult(let params) = decoded else {
        Issue.record("Expected tool_result after round-trip")
        return
    }
    #expect(params.toolId == "t1")
    #expect(params.result == "file contents")
    #expect(params.isError == false)
}

@Test func testSessionIdRoundTrip() throws {
    let json = """
    {"type":"session_id","sessionId":"s-new","seq":0,"ts":1714070400}
    """.data(using: .utf8)!

    let original = try JSONDecoder().decode(ServerMessage.self, from: json)
    let encoded = try JSONEncoder().encode(original)
    let decoded = try JSONDecoder().decode(ServerMessage.self, from: encoded)

    guard case .sessionId(let sid, let seq, let ts) = decoded else {
        Issue.record("Expected session_id after round-trip")
        return
    }
    #expect(sid == "s-new")
    #expect(seq == 0)
    #expect(ts == 1714070400)
}

@Test func testPermissionRequestRoundTrip() throws {
    let json = """
    {"type":"permission_request","permId":"p1","toolName":"Bash","toolInput":"npm test","title":"Run command","description":"Execute npm test","displayName":"Shell","decisionReason":"elevated tier","tier":"elevated"}
    """.data(using: .utf8)!

    let original = try JSONDecoder().decode(ServerMessage.self, from: json)
    let encoded = try JSONEncoder().encode(original)
    let decoded = try JSONDecoder().decode(ServerMessage.self, from: encoded)

    guard case .permissionRequest(let params) = decoded else {
        Issue.record("Expected permission_request after round-trip")
        return
    }
    #expect(params.permId == "p1")
    #expect(params.title == "Run command")
    #expect(params.description == "Execute npm test")
    #expect(params.decisionReason == "elevated tier")
    #expect(params.tier == .elevated)
}

@Test func testModeChangedRoundTrip() throws {
    let json = """
    {"type":"mode_changed","sessionId":"s1","mode":"auto"}
    """.data(using: .utf8)!

    let original = try JSONDecoder().decode(ServerMessage.self, from: json)
    let encoded = try JSONEncoder().encode(original)
    let decoded = try JSONDecoder().decode(ServerMessage.self, from: encoded)

    guard case .modeChanged(let sid, let mode) = decoded else {
        Issue.record("Expected mode_changed after round-trip")
        return
    }
    #expect(sid == "s1")
    #expect(mode == .auto)
}

@Test func testTokenUpdateRoundTrip() throws {
    let json = """
    {"type":"token_update","agentContext":5000,"contextCeiling":200000,"sessionTotal":12000,"turnIndex":3,"sessionId":"s1","seq":10,"ts":1714070400}
    """.data(using: .utf8)!

    let original = try JSONDecoder().decode(ServerMessage.self, from: json)
    let encoded = try JSONEncoder().encode(original)
    let decoded = try JSONDecoder().decode(ServerMessage.self, from: encoded)

    guard case .tokenUpdate(let params) = decoded else {
        Issue.record("Expected token_update after round-trip")
        return
    }
    #expect(params.agentContext == 5000)
    #expect(params.contextCeiling == 200000)
    #expect(params.ts == 1714070400)
}

@Test func testWelcomeRoundTrip() throws {
    let json = """
    {"type":"welcome","protocolVersion":2,"connectionId":"conn-abc"}
    """.data(using: .utf8)!

    let original = try JSONDecoder().decode(ServerMessage.self, from: json)
    let encoded = try JSONEncoder().encode(original)
    let decoded = try JSONDecoder().decode(ServerMessage.self, from: encoded)

    guard case .welcome(let version, let connId) = decoded else {
        Issue.record("Expected welcome after round-trip")
        return
    }
    #expect(version == 2)
    #expect(connId == "conn-abc")
}

@Test func testReconnectedRoundTrip() throws {
    let json = """
    {"type":"reconnected","sessions":[{"sessionId":"s1","replayed":5,"running":true},{"sessionId":"s2","replayed":0,"running":false}]}
    """.data(using: .utf8)!

    let original = try JSONDecoder().decode(ServerMessage.self, from: json)
    let encoded = try JSONEncoder().encode(original)
    let decoded = try JSONDecoder().decode(ServerMessage.self, from: encoded)

    guard case .reconnected(let sessions) = decoded else {
        Issue.record("Expected reconnected after round-trip")
        return
    }
    #expect(sessions.count == 2)
    #expect(sessions[0].sessionId == "s1")
    #expect(sessions[0].replayed == 5)
    #expect(sessions[0].running == true)
    #expect(sessions[1].running == false)
}

@Test func testWatchedRoundTrip() throws {
    let json = """
    {"type":"watched","sessionId":"s1"}
    """.data(using: .utf8)!

    let original = try JSONDecoder().decode(ServerMessage.self, from: json)
    let encoded = try JSONEncoder().encode(original)
    let decoded = try JSONDecoder().decode(ServerMessage.self, from: encoded)

    guard case .watched(let sid) = decoded else {
        Issue.record("Expected watched after round-trip")
        return
    }
    #expect(sid == "s1")
}

@Test func testUnwatchedRoundTrip() throws {
    let json = """
    {"type":"unwatched","sessionId":"s1"}
    """.data(using: .utf8)!

    let original = try JSONDecoder().decode(ServerMessage.self, from: json)
    let encoded = try JSONEncoder().encode(original)
    let decoded = try JSONDecoder().decode(ServerMessage.self, from: encoded)

    guard case .unwatched(let sid) = decoded else {
        Issue.record("Expected unwatched after round-trip")
        return
    }
    #expect(sid == "s1")
}

@Test func testSessionSwitchedRoundTrip() throws {
    let json = """
    {"type":"session_switched","sessionId":"s1","mode":"agent","cwd":"/home/user","branch":"main","tokens":{"input":100,"output":50,"cacheRead":10,"cacheCreation":5,"costUsd":0.01}}
    """.data(using: .utf8)!

    let original = try JSONDecoder().decode(ServerMessage.self, from: json)
    let encoded = try JSONEncoder().encode(original)
    let decoded = try JSONDecoder().decode(ServerMessage.self, from: encoded)

    guard case .sessionSwitched(let params) = decoded else {
        Issue.record("Expected session_switched after round-trip")
        return
    }
    #expect(params.sessionId == "s1")
    #expect(params.mode == .agent)
    #expect(params.cwd == "/home/user")
    #expect(params.branch == "main")
    #expect(params.tokens.input == 100)
    #expect(params.tokens.costUsd == 0.01)
}

@Test func testSessionClearedRoundTrip() throws {
    let json = """
    {"type":"session_cleared"}
    """.data(using: .utf8)!

    let original = try JSONDecoder().decode(ServerMessage.self, from: json)
    let encoded = try JSONEncoder().encode(original)
    let decoded = try JSONDecoder().decode(ServerMessage.self, from: encoded)

    guard case .sessionCleared = decoded else {
        Issue.record("Expected session_cleared after round-trip")
        return
    }
}

@Test func testSessionResumedRoundTrip() throws {
    let json = """
    {"type":"session_resumed","sessionId":"s1","replayed":12}
    """.data(using: .utf8)!

    let original = try JSONDecoder().decode(ServerMessage.self, from: json)
    let encoded = try JSONEncoder().encode(original)
    let decoded = try JSONDecoder().decode(ServerMessage.self, from: encoded)

    guard case .sessionResumed(let sid, let replayed) = decoded else {
        Issue.record("Expected session_resumed after round-trip")
        return
    }
    #expect(sid == "s1")
    #expect(replayed == 12)
}

@Test func testSessionTakeoverRoundTrip() throws {
    let json = """
    {"type":"session_takeover","sessionId":"s1"}
    """.data(using: .utf8)!

    let original = try JSONDecoder().decode(ServerMessage.self, from: json)
    let encoded = try JSONEncoder().encode(original)
    let decoded = try JSONDecoder().decode(ServerMessage.self, from: encoded)

    guard case .sessionTakeover(let sid) = decoded else {
        Issue.record("Expected session_takeover after round-trip")
        return
    }
    #expect(sid == "s1")
}

@Test func testSessionEndRoundTrip() throws {
    let json = """
    {"type":"session_end","sessionId":"s1","usage":{"inputTokens":1000,"outputTokens":500,"cacheReadTokens":200,"cacheCreationTokens":100,"totalCostUsd":0.05,"numTurns":3,"durationMs":60000,"durationApiMs":45000}}
    """.data(using: .utf8)!

    let original = try JSONDecoder().decode(ServerMessage.self, from: json)
    let encoded = try JSONEncoder().encode(original)
    let decoded = try JSONDecoder().decode(ServerMessage.self, from: encoded)

    guard case .sessionEnd(let params) = decoded else {
        Issue.record("Expected session_end after round-trip")
        return
    }
    #expect(params.sessionId == "s1")
    #expect(params.usage.inputTokens == 1000)
    #expect(params.usage.totalCostUsd == 0.05)
    #expect(params.usage.durationMs == 60000)
}

@Test func testErrorRoundTrip() throws {
    let json = """
    {"type":"error","error":"something broke"}
    """.data(using: .utf8)!

    let original = try JSONDecoder().decode(ServerMessage.self, from: json)
    let encoded = try JSONEncoder().encode(original)
    let decoded = try JSONDecoder().decode(ServerMessage.self, from: encoded)

    guard case .error(let err) = decoded else {
        Issue.record("Expected error after round-trip")
        return
    }
    #expect(err == "something broke")
}

@Test func testUnknownRoundTrip() throws {
    let json = """
    {"type":"future_type","extra":"data"}
    """.data(using: .utf8)!

    let original = try JSONDecoder().decode(ServerMessage.self, from: json)
    let encoded = try JSONEncoder().encode(original)
    let decoded = try JSONDecoder().decode(ServerMessage.self, from: encoded)

    guard case .unknown(let type) = decoded else {
        Issue.record("Expected unknown after round-trip")
        return
    }
    #expect(type == "future_type")
}
