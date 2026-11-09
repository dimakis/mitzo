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

    func resume() async {}
    func isRunning() async -> Bool { !cancelled }
    func send(_ message: URLSessionWebSocketTask.Message) async throws {
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
