import Foundation
import Testing
@testable import MitzoShared

private actor TestSocket: MitzoWebSocket {
    private(set) var sent: [String] = []
    private(set) var cancelled = false
    private var incoming: [URLSessionWebSocketTask.Message] = []
    private var receiver: CheckedContinuation<URLSessionWebSocketTask.Message, Error>?
    private var failurePending = false
    private var pauseHello = false
    private var helloContinuation: CheckedContinuation<Void, Never>?
    private(set) var helloWaiting = false
    private var sendFailure = false

    func resume() async {}
    func isRunning() async -> Bool { !cancelled }
    func send(_ message: URLSessionWebSocketTask.Message) async throws {
        if sendFailure { sendFailure = false; throw URLError(.networkConnectionLost) }
        if cancelled { throw CancellationError() }
        if pauseHello { helloWaiting = true; await withCheckedContinuation { helloContinuation = $0 } }
        switch message {
        case .data(let data): sent.append(String(decoding: data, as: UTF8.self))
        case .string(let text): sent.append(text)
        @unknown default: break
        }
    }
    func receive() async throws -> URLSessionWebSocketTask.Message {
        if failurePending { failurePending = false; throw URLError(.networkConnectionLost) }
        if !incoming.isEmpty { return incoming.removeFirst() }
        // Intentionally allow a cancelled socket's late callback: the client
        // must fence its identity rather than rely on cooperative cancellation.
        return try await withCheckedThrowingContinuation { receiver = $0 }
    }
    func push(_ text: String) {
        let message = URLSessionWebSocketTask.Message.string(text)
        if let waiting = receiver { receiver = nil; waiting.resume(returning: message) }
        else { incoming.append(message) }
    }
    func fail() {
        if receiver == nil { failurePending = true }
        receiver?.resume(throwing: URLError(.networkConnectionLost))
        receiver = nil
    }
    func cancel() async { cancelled = true }
    func stallHello() { pauseHello = true }
    func failNextSend() { sendFailure = true }
    func releaseHello() { pauseHello = false; helloContinuation?.resume(); helloContinuation = nil }
}

@Test func cancellingConnectDuringHelloRetiresTheSocket() async throws {
    let socket = TestSocket()
    await socket.stallHello()
    let client = MitzoWSClient(url: URL(string: "https://offline.invalid")!, socketFactory: { _ in socket })
    let connection = Task { await client.connect { _ in } }
    try await eventually { await socket.helloWaiting }
    connection.cancel()
    await socket.releaseHello()
    await connection.value
    #expect(await socket.cancelled)
    await client.disconnect()
}

@Test func aRetiredSocketCannotWelcomeOrDisconnectItsReplacement() async throws {
    let first = TestSocket(), second = TestSocket()
    let factory = SocketFactory([first, second])
    let client = MitzoWSClient(url: URL(string: "https://offline.invalid")!, socketFactory: { _ in await factory.make() })
    await client.connect { _ in }
    try await eventually { await first.sent.count == 1 }
    await client.disconnect()
    await client.connect { _ in }
    try await eventually { await second.sent.count == 1 }
    await first.push("{\"type\":\"welcome\",\"protocolVersion\":2,\"connectionId\":\"retired\"}")
    try await client.reconnect(sessions: [])
    #expect(await second.sent.count == 1)
    await second.push("{\"type\":\"welcome\",\"protocolVersion\":2,\"connectionId\":\"current\"}")
    try await eventually { await second.sent.count == 2 }
    await first.fail()
    #expect(await second.cancelled == false)
    await client.disconnect()
    await second.fail()
}

private actor SocketFactory {
    let sockets: [TestSocket]
    private(set) var count = 0
    let gate: FactoryGate?
    init(_ sockets: [TestSocket], gate: FactoryGate? = nil) { self.sockets = sockets; self.gate = gate }
    func make() async -> any MitzoWebSocket {
        let socket = sockets[min(count, sockets.count - 1)]
        count += 1
        if count == 1 { await gate?.wait() }
        return socket
    }
}

private actor FactoryGate {
    private var continuation: CheckedContinuation<Void, Never>?
    private(set) var waiting = false
    func wait() async { waiting = true; await withCheckedContinuation { continuation = $0 } }
    func release() { continuation?.resume(); continuation = nil }
}

@Test func cancellingSocketCreationAllowsAnotherConnect() async throws {
    let first = TestSocket(), second = TestSocket(), gate = FactoryGate()
    let factory = SocketFactory([first, second], gate: gate)
    let client = MitzoWSClient(url: URL(string: "https://offline.invalid")!, socketFactory: { _ in await factory.make() })
    let connection = Task { await client.connect { _ in } }
    try await eventually { await gate.waiting }
    connection.cancel()
    await gate.release()
    await connection.value
    #expect(await first.cancelled)
    await client.connect { _ in }
    try await eventually { await second.sent.count == 1 }
    await client.disconnect()
    await second.fail()
}

private func eventually(_ predicate: () async -> Bool) async throws {
    let deadline = Date().addingTimeInterval(2)
    while !(await predicate()), Date() < deadline {
        try await Task.sleep(nanoseconds: 2_000_000)
    }
    #expect(await predicate())
}

@Test func helloIsSentBeforeWelcomeAndOrdinaryMessagesWaitForWelcome() async throws {
    let socket = TestSocket()
    let client = MitzoWSClient(url: URL(string: "https://offline.invalid")!, socketFactory: { _ in socket })
    try await client.reconnect(sessions: [])
    await client.connect { _ in }
    try await eventually { await socket.sent.count == 1 }
    let first = try #require(await socket.sent.first)
    #expect(first.contains("hello"))
    await socket.push("{\"type\":\"welcome\",\"protocolVersion\":2,\"connectionId\":\"first\"}")
    try await eventually { await socket.sent.count == 2 }
    #expect(await socket.sent.last?.contains("reconnect") == true)
    await client.disconnect()
    await socket.fail()
}

@Test func disconnectCancelsScheduledReconnectAndFencesLateSocketCallbacks() async throws {
    let first = TestSocket(), second = TestSocket()
    let retryGate = FactoryGate()
    let factory = SocketFactory([first, second])
    let client = MitzoWSClient(url: URL(string: "https://offline.invalid")!, reconnectWait: { await retryGate.wait() }, socketFactory: { _ in await factory.make() })
    await client.connect { _ in }
    try await eventually { await first.sent.count == 1 }
    await first.fail()
    try await eventually { await retryGate.waiting }
    await client.disconnect()
    await retryGate.release()
    try await Task.sleep(nanoseconds: 40_000_000)
    #expect(await factory.count == 1)

    await client.connect { _ in }
    try await eventually { await second.sent.count == 1 }
    // A callback queued by the retired socket cannot welcome the replacement.
    await first.push("{\"type\":\"welcome\",\"protocolVersion\":2,\"connectionId\":\"retired\"}")
    try await client.reconnect(sessions: [])
    #expect(await second.sent.count == 1)
    await second.push("{\"type\":\"welcome\",\"protocolVersion\":2,\"connectionId\":\"second\"}")
    try await eventually { await second.sent.count == 2 }
    await client.disconnect()
    await second.fail()
}

@Test func overflowingOfflineQueueReportsFailureInsteadOfClaimingSuccess() async throws {
    let client = MitzoWSClient(url: URL(string: "https://offline.invalid")!)
    for _ in 0..<100 { try await client.reconnect(sessions: []) }
    await #expect(throws: (any Error).self) { try await client.reconnect(sessions: []) }
    await client.disconnect()
}

@Test func foregroundSocketReplacementRestoresMembershipAndCursorsBeforeQueuedCommands() async throws {
    let first = TestSocket(), second = TestSocket()
    let factory = SocketFactory([first, second])
    let client = MitzoWSClient(url: URL(string: "https://offline.invalid")!, socketFactory: { _ in await factory.make() })
    await client.connect { _ in }
    await first.push("{\"type\":\"welcome\",\"protocolVersion\":2,\"connectionId\":\"first\"}")
    try await client.send(.watch(sessionId: "active"))
    try await client.send(.watch(sessionId: "zero-events"))
    try await client.send(.watch(sessionId: "removed"))
    try await client.send(.unwatch(sessionId: "removed"))
    await client.updateSeq(sessionId: "active", seq: 7)
    try await eventually { await first.sent.contains { $0.contains("unwatch") } }
    try await client.send(.stop(sessionId: "already-attempted"))
    await client.disconnect()
    await client.connect { _ in }
    try await client.send(.stop(sessionId: "new-command"))
    await second.push("{\"type\":\"welcome\",\"protocolVersion\":2,\"connectionId\":\"second\"}")
    try await eventually { await second.sent.count >= 3 }
    let frames = try await second.sent.map { try JSONSerialization.jsonObject(with: Data($0.utf8)) as! [String: Any] }
    #expect(frames.compactMap { $0["type"] as? String } == ["hello", "reconnect", "stop"])
    let restored = frames.first { $0["type"] as? String == "reconnect" }?["sessions"] as? [[String: Any]] ?? []
    #expect(Set(restored.compactMap { $0["sessionId"] as? String }) == ["active", "zero-events"])
    #expect(restored.first { $0["sessionId"] as? String == "active" }?["lastSeq"] as? Int == 7)
    #expect(restored.first { $0["sessionId"] as? String == "zero-events" }?["lastSeq"] as? Int == 0)
    #expect(!frames.contains { $0["sessionId"] as? String == "already-attempted" })
    await client.disconnect(); await first.fail(); await second.fail()
}

@Test func reconnectReplyAcceptsTheOwningServersActualWireShape() throws {
    let message = try JSONDecoder().decode(ServerMessage.self, from: Data("{\"type\":\"reconnected\",\"sessions\":[{\"sessionId\":\"active\",\"replayed\":3}]}".utf8))
    guard case .reconnected(let sessions) = message else { Issue.record("Expected reconnected"); return }
    #expect(sessions.first?.sessionId == "active")
    #expect(sessions.first?.replayed == 3)
}

private actor RelayConfigurationFixture {
    var url: URL?
    var gate: FactoryGate?
    private var skippedGateReads = 0
    private(set) var calls = 0
    init(_ url: URL?, gate: FactoryGate? = nil) { self.url = url; self.gate = gate }
    func read() async -> URL? {
        calls += 1
        if skippedGateReads > 0 { skippedGateReads -= 1; return url }
        let waiting = gate; gate = nil; await waiting?.wait(); return url
    }
    func set(_ url: URL?) { self.url = url; gate = nil }
    func stallNextRead(_ gate: FactoryGate) { self.gate = gate }
    func stallEstablishmentRead(_ gate: FactoryGate) { self.gate = gate; skippedGateReads = 1 }
}

@Test func coldWatchDemandAndForegroundShareOneAuthenticatedConnection() async throws {
    let socket = TestSocket(), gate = FactoryGate()
    let configuration = RelayConfigurationFixture(URL(string: "wss://offline.invalid/ws/chat?token=fixture"), gate: gate)
    let connection = NativeRelayConnection(configuration: { await configuration.read() }, makeClient: { url in
        MitzoWSClient(url: url, socketFactory: { _ in socket })
    })
    let watch = Task { try await connection.acquire() }
    try await eventually { await gate.waiting }
    let foreground = Task { try await connection.acquire(reconnect: true) }
    try await eventually { await connection.acquisitions == 2 }
    await gate.release()
    let first = try await watch.value, other = try await foreground.value
    #expect(first === other)
    #expect(await configuration.calls >= 2)
    #expect(await socket.sent.count == 1)
    await first.retire(); await socket.fail()
}

@Test func logoutDuringPendingHelloRejectsBothAcquisitionsAndRetiresTheCandidate() async throws {
    let socket = TestSocket()
    await socket.stallHello()
    let configuration = RelayConfigurationFixture(URL(string: "wss://offline.invalid/ws/chat?token=old"))
    let connection = NativeRelayConnection(configuration: { await configuration.read() }, makeClient: { url in
        MitzoWSClient(url: url, socketFactory: { _ in socket })
    })
    let first = Task { try await connection.acquire() }
    try await eventually { await socket.helloWaiting }
    await configuration.set(nil)
    let afterLogout = Task { try await connection.acquire() }
    try await eventually { await connection.acquisitions == 2 }
    // Releasing cancellation-resistant hello cannot restore old authority.
    await socket.releaseHello()
    let outcomes = [await first.result, await afterLogout.result]
    for outcome in outcomes {
        if case .success = outcome { Issue.record("Acquisition crossed logout") }
    }
    #expect(await socket.cancelled)
    await socket.fail()
}

@Test func foregroundReconnectIntentSurvivesJoiningAPendingWatchAcquisition() async throws {
    let first = TestSocket(), second = TestSocket(), gate = FactoryGate()
    let sockets = SocketFactory([first, second])
    let configuration = RelayConfigurationFixture(URL(string: "wss://offline.invalid/ws/chat?token=fixture"))
    let connection = NativeRelayConnection(configuration: { await configuration.read() }, makeClient: { url in
        MitzoWSClient(url: url, socketFactory: { _ in await sockets.make() })
    })
    let client = try await connection.acquire()
    await first.push("{\"type\":\"welcome\",\"protocolVersion\":2,\"connectionId\":\"first\"}")
    try await client.send(.watch(sessionId: "active"))
    try await eventually { await first.sent.contains { $0.contains("watch") } }
    try await connection.suspend()
    await configuration.stallEstablishmentRead(gate)
    let watch = Task { try await connection.acquire() }
    try await eventually { await gate.waiting }
    let foreground = Task { try await connection.acquire(reconnect: true) }
    try await eventually { await connection.acquisitions == 3 }
    await gate.release()
    _ = try await watch.value; _ = try await foreground.value
    #expect(await sockets.count == 2)
    #expect(await first.cancelled)
    await second.push("{\"type\":\"welcome\",\"protocolVersion\":2,\"connectionId\":\"second\"}")
    try await eventually { await second.sent.count == 2 }
    #expect(await second.sent.last?.contains("reconnect") == true)
    await client.retire(); await first.fail(); await second.fail()
}

@Test func logoutBetweenPreflightAndSetupRetiresAnExistingClientAndItsQueue() async throws {
    let socket = TestSocket(), gate = FactoryGate()
    let configuration = RelayConfigurationFixture(URL(string: "wss://offline.invalid/ws/chat?token=old"))
    let connection = NativeRelayConnection(configuration: { await configuration.read() }, makeClient: { url in
        MitzoWSClient(url: url, socketFactory: { _ in socket })
    })
    let client = try await connection.acquire()
    try await client.send(.stop(sessionId: "unattempted-before-logout"))
    await configuration.stallEstablishmentRead(gate)
    let refresh = Task { try await connection.acquire() }
    try await eventually { await gate.waiting }
    await configuration.set(nil)
    await gate.release()
    if case .success = await refresh.result { Issue.record("Acquisition crossed logout") }
    #expect(await socket.cancelled)
    await #expect(throws: MitzoWSClient.TransportError.self) { try await client.send(.stop(sessionId: "stale")) }
    await socket.push("{\"type\":\"welcome\",\"protocolVersion\":2,\"connectionId\":\"late\"}")
    #expect(!(await socket.sent).joined().contains("unattempted-before-logout"))
    await client.retire(); await socket.fail()
}

@Test func foregroundReusesClientAndChangedAuthorityRetiresItsQueue() async throws {
    let one = URL(string: "wss://offline.invalid/ws/chat?token=first")!
    let two = URL(string: "wss://offline.invalid/ws/chat?token=second")!
    let configuration = RelayConfigurationFixture(one)
    let first = TestSocket(), replacement = TestSocket(), changed = TestSocket()
    let sockets = SocketFactory([first, replacement, changed])
    let connection = NativeRelayConnection(configuration: { await configuration.read() }, makeClient: { url in
        MitzoWSClient(url: url, socketFactory: { _ in await sockets.make() })
    })
    let original = try await connection.acquire()
    await first.push("{\"type\":\"welcome\",\"protocolVersion\":2,\"connectionId\":\"first\"}")
    try await original.send(.watch(sessionId: "active"))
    try await eventually { await first.sent.contains { $0.contains("watch") } }
    let resumed = try await connection.acquire(reconnect: true)
    #expect(original === resumed)
    #expect(await first.cancelled)
    try await resumed.send(.stop(sessionId: "unattempted-old-authority"))
    await configuration.set(two)
    let next = try await connection.acquire()
    #expect(next !== original)
    #expect(await replacement.cancelled)
    await #expect(throws: MitzoWSClient.TransportError.self) { try await original.send(.stop(sessionId: "stale")) }
    await changed.push("{\"type\":\"welcome\",\"protocolVersion\":2,\"connectionId\":\"changed\"}")
    try await next.send(.watch(sessionId: "new-authority"))
    try await eventually { await changed.sent.count == 2 }
    #expect(!((await changed.sent).joined().contains("old-authority")))
    #expect(!((await changed.sent).joined().contains("active")))
    await configuration.set(nil)
    await #expect(throws: NativeRelayConnection.ConnectionError.self) { _ = try await connection.acquire() }
    #expect(await changed.cancelled)
    await #expect(throws: MitzoWSClient.TransportError.self) { try await next.send(.watch(sessionId: "logged-out")) }
    await first.fail(); await replacement.fail(); await changed.fail()
}

@Test func networkReconnectRestoresSubscriptionsWithoutRepeatingAttemptedCommands() async throws {
    let first = TestSocket(), second = TestSocket(), gate = FactoryGate()
    let sockets = SocketFactory([first, second])
    let client = MitzoWSClient(url: URL(string: "wss://offline.invalid")!, reconnectWait: { await gate.wait() }, socketFactory: { _ in await sockets.make() })
    await client.connect { _ in }
    await first.push("{\"type\":\"welcome\",\"protocolVersion\":2,\"connectionId\":\"first\"}")
    try await client.send(.watch(sessionId: "active"))
    try await eventually { await first.sent.contains { $0.contains("watch") } }
    try await client.send(.stop(sessionId: "already-attempted"))
    await first.fail()
    try await eventually { await gate.waiting }
    try await client.send(.stop(sessionId: "queued"))
    await gate.release()
    try await eventually { await second.sent.count == 1 }
    await second.push("{\"type\":\"welcome\",\"protocolVersion\":2,\"connectionId\":\"second\"}")
    try await eventually { await second.sent.count == 3 }
    let frames = await second.sent
    #expect(frames[1].contains("reconnect"))
    #expect(frames[2].contains("queued"))
    #expect(!frames.joined().contains("already-attempted"))
    await client.retire(); await second.fail()
}

private final class RelayReadProvider: @unchecked Sendable {
    private let lock = NSLock()
    private var api: MitzoAPIClient?
    init(_ api: MitzoAPIClient) { self.api = api }
    func read() -> MitzoAPIClient? { lock.withLock { api } }
    func logout() { lock.withLock { api = nil } }
}
private actor ColdRelayHTTP {
    private(set) var requests: [URLRequest] = []
    func send(_ request: URLRequest) throws -> (Data, URLResponse) {
        requests.append(request)
        let url = request.url!
        let body = url.path.hasSuffix("/messages") ? "[]" : "{\"sessions\":[],\"hasMore\":false}"
        return (Data(body.utf8), HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    }
}

@Test func coldWatchReadsUseFreshRESTWithoutAChatClientAndRespectLogout() async throws {
    let http = ColdRelayHTTP()
    let api = MitzoAPIClient(baseURL: URL(string: "https://offline.invalid")!, currentToken: { "offline-fixture" }, transport: { try await http.send($0) })
    let provider = RelayReadProvider(api)
    let reads = WatchRelayReads(apiProvider: { provider.read() })
    let sessions = try JSONDecoder().decode(SessionsResponse.self, from: await reads.sessions())
    let messages = try JSONDecoder().decode([FinishedMessage].self, from: await reads.messages(sessionId: "active"))
    #expect(sessions.sessions.isEmpty && messages.isEmpty)
    #expect(await http.requests.map { $0.url!.path } == ["/api/sessions", "/api/sessions/active/messages"])
    #expect(await http.requests.allSatisfy { $0.value(forHTTPHeaderField: "Authorization") == "Bearer offline-fixture" })
    provider.logout()
    await #expect(throws: NativeRelayConnection.ConnectionError.self) { _ = try await reads.sessions() }
    #expect(await http.requests.count == 2)
}

@Test func suspensionReportsTheOriginalTransportFailure() async throws {
    let socket = TestSocket()
    let connection = NativeRelayConnection(configuration: { URL(string: "wss://offline.invalid") }, makeClient: { url in
        MitzoWSClient(url: url, socketFactory: { _ in socket })
    })
    let client = try await connection.acquire()
    await socket.push("{\"type\":\"welcome\",\"protocolVersion\":2,\"connectionId\":\"first\"}")
    try await client.send(.watch(sessionId: "active"))
    try await eventually { await socket.sent.count == 2 }
    await socket.failNextSend()
    await #expect(throws: URLError.self) { try await connection.suspend() }
    await client.retire(); await socket.fail()
}
