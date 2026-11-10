// WebSocket v2 Client
// Swift equivalent of packages/client/src/connection.ts

import Foundation

// The native client owns the socket lifecycle; this seam also permits offline
// behavioral tests without opening a connection to a real server.
protocol MitzoWebSocket: Sendable {
    func resume() async
    func cancel() async
    func send(_ message: URLSessionWebSocketTask.Message) async throws
    func receive() async throws -> URLSessionWebSocketTask.Message
    func isRunning() async -> Bool
}

private struct URLSessionMitzoWebSocket: MitzoWebSocket {
    let task: URLSessionWebSocketTask
    func resume() async { task.resume() }
    func cancel() async { task.cancel(with: .goingAway, reason: nil) }
    func send(_ message: URLSessionWebSocketTask.Message) async throws { try await task.send(message) }
    func receive() async throws -> URLSessionWebSocketTask.Message { try await task.receive() }
    func isRunning() async -> Bool { task.state == .running }
}

public actor MitzoWSClient {
    public enum State: Sendable, Equatable {
        case disconnected
        case connecting
        case connected(connectionId: String)
        case reconnecting

        public static func == (lhs: State, rhs: State) -> Bool {
            switch (lhs, rhs) {
            case (.disconnected, .disconnected),
                 (.connecting, .connecting),
                 (.reconnecting, .reconnecting):
                return true
            case (.connected(let lhsId), .connected(let rhsId)):
                return lhsId == rhsId
            default:
                return false
            }
        }
    }

    public enum Event: Sendable {
        case stateChanged(State)
        case message(ServerMessage)
        case error(Error)
    }

    private let url: URL
    private var socket: (any MitzoWebSocket)?
    private var generation: UInt64 = 0
    private var receiveTask: Task<Void, Never>?
    private let socketFactory: @Sendable (URL) async -> any MitzoWebSocket
    private var state: State = .disconnected
    private var seqBySession: [String: Int] = [:]
    private var watchedSessions: Set<String> = []
    private var hasWelcomed = false
    private var retired = false
    private var pendingSends: [ClientMessage] = []
    private var reconnectTimer: Task<Void, Never>?
    private var heartbeatTimer: Task<Void, Never>?
    private var eventHandler: ((Event) -> Void)?

    private let maxPendingSends = 100
    private let heartbeatInterval: TimeInterval = 5.0
    private let reconnectWait: @Sendable () async throws -> Void

    public enum TransportError: Error {
        case pendingQueueFull
        case connectionRetired
    }

    public init(url: URL) {
        self.url = url
        self.reconnectWait = { try await Task.sleep(nanoseconds: 500_000_000) }
        self.socketFactory = { URLSessionMitzoWebSocket(task: tailscaleURLSession.webSocketTask(with: $0)) }
    }

    init(url: URL, reconnectDelay: TimeInterval = 0.5,
         reconnectWait: (@Sendable () async throws -> Void)? = nil,
         socketFactory: @escaping @Sendable (URL) async -> any MitzoWebSocket) {
        self.url = url
        self.reconnectWait = reconnectWait ?? { try await Task.sleep(nanoseconds: UInt64(reconnectDelay * 1_000_000_000)) }
        self.socketFactory = socketFactory
    }

    // MARK: - Public API

    public func connect(onEvent: @escaping (Event) -> Void) async {
        eventHandler = onEvent
        await _connect()
    }

    public func disconnect() async {
        generation &+= 1
        let retired = socket
        socket = nil
        receiveTask?.cancel()
        receiveTask = nil
        heartbeatTimer?.cancel()
        heartbeatTimer = nil
        reconnectTimer?.cancel()
        reconnectTimer = nil
        state = .disconnected
        eventHandler?(.stateChanged(.disconnected))
        await retired?.cancel()
    }

    /// Authority changed. Stale callers must fail, never queue on an orphan.
    public func retire() async {
        retired = true
        pendingSends.removeAll()
        watchedSessions.removeAll()
        seqBySession.removeAll()
        await disconnect()
    }

    public func send(_ message: ClientMessage) async throws {
        guard !retired else { throw TransportError.connectionRetired }
        // If not connected, queue it
        guard case .connected = state else {
            guard pendingSends.count < maxPendingSends else { throw TransportError.pendingQueueFull }
            rememberSubscription(message)
            pendingSends.append(message)
            return
        }
        rememberSubscription(message)
        guard let socket else { throw TransportError.connectionRetired }
        let current = generation
        let data = try JSONEncoder().encode(message)
        try await socket.send(.data(data))
        guard current == generation else { throw TransportError.connectionRetired }
    }

    public func reconnect(sessions: [ReconnectSession]) async throws {
        try await send(.reconnect(sessions: sessions))
    }

    public func suspend(sessions: [SuspendSession]) async throws {
        try await send(.sessionSuspend(sessions: sessions))
    }

    public func updateSeq(sessionId: String, seq: Int) {
        seqBySession[sessionId] = max(seqBySession[sessionId] ?? 0, seq)
    }

    public func getSeq(sessionId: String) -> Int {
        seqBySession[sessionId] ?? 0
    }

    public func getSuspendSessions() -> [SuspendSession] {
        watchedSessions.sorted().map { SuspendSession(sessionId: $0, lastSeq: seqBySession[$0] ?? 0) }
    }

    private func rememberSubscription(_ message: ClientMessage) {
        switch message {
        case .watch(let sessionId): watchedSessions.insert(sessionId)
        case .unwatch(let sessionId): watchedSessions.remove(sessionId)
        case .reconnect(let sessions):
            for session in sessions {
                watchedSessions.insert(session.sessionId)
                updateSeq(sessionId: session.sessionId, seq: session.lastSeq)
            }
        default: break
        }
    }

    // MARK: - Internal Connection Logic

    private func _connect() async {
        guard !retired, !Task.isCancelled, state == .disconnected || state == .reconnecting else { return }

        generation &+= 1
        let current = generation
        state = .connecting
        eventHandler?(.stateChanged(.connecting))

        let opened = await socketFactory(url)
        guard current == generation, !Task.isCancelled else {
            if current == generation { await disconnect() }
            await opened.cancel()
            return
        }
        socket = opened
        await opened.resume()

        // Send hello
        do {
            // hello precedes welcome. Ordinary messages stay queued until the
            // welcome arrives; sending hello through that queue deadlocks.
            try await opened.send(.data(JSONEncoder().encode(ClientMessage.hello())))
            guard current == generation, !Task.isCancelled else {
                if current == generation { await disconnect() }
                return
            }
            startReceiving(opened, generation: current)
            startHeartbeat(opened, generation: current)
        } catch {
            guard current == generation, !Task.isCancelled else {
                if current == generation { await disconnect() }
                return
            }
            eventHandler?(.error(error))
            await handleDisconnect(generation: current)
        }
    }

    private func startReceiving(_ opened: any MitzoWebSocket, generation: UInt64) {
        receiveTask?.cancel()
        receiveTask = Task { [weak self] in
            while !Task.isCancelled {
                do {
                    let message = try await opened.receive()
                    guard !Task.isCancelled else { return }
                    await self?.handleMessage(message, generation: generation)
                } catch {
                    guard !Task.isCancelled else { return }
                    await self?.receiveFailed(error, generation: generation)
                    return
                }
            }
        }
    }

    private func receiveFailed(_ error: Error, generation: UInt64) async {
        guard generation == self.generation else { return }
        eventHandler?(.error(error))
        await handleDisconnect(generation: generation)
    }

    private func handleMessage(_ message: URLSessionWebSocketTask.Message, generation: UInt64) async {
        guard generation == self.generation else { return }
        switch message {
        case .data(let data):
            do {
                let serverMsg = try JSONDecoder().decode(ServerMessage.self, from: data)
                await processServerMessage(serverMsg, generation: generation)
            } catch {
                eventHandler?(.error(error))
            }

        case .string(let text):
            // Try to decode as JSON
            guard let data = text.data(using: .utf8) else { return }
            do {
                let serverMsg = try JSONDecoder().decode(ServerMessage.self, from: data)
                await processServerMessage(serverMsg, generation: generation)
            } catch {
                eventHandler?(.error(error))
            }

        @unknown default:
            break
        }
    }

    private func processServerMessage(_ message: ServerMessage, generation: UInt64) async {
        guard generation == self.generation else { return }
        // Update seq if present
        switch message {
        case .sessionId(let sessionId, let seq, _, _):
            watchedSessions.insert(sessionId)
            if let seq = seq {
                updateSeq(sessionId: sessionId, seq: seq)
            }

        case .messageStart(let params):
            updateSeq(sessionId: params.sessionId, seq: params.seq)

        case .blockStart(let params):
            updateSeq(sessionId: params.sessionId, seq: params.seq)

        case .blockDelta(let params):
            updateSeq(sessionId: params.sessionId, seq: params.seq)

        case .blockEnd(let params):
            updateSeq(sessionId: params.sessionId, seq: params.seq)

        case .messageEnd(let params):
            updateSeq(sessionId: params.sessionId, seq: params.seq)

        case .welcome(_, let connectionId):
            // Restore delivery intent only. Attempted commands and permission
            // responses are never replayed. Keep ordinary sends queued until
            // the owning server has received the subscription/cursor frame.
            if hasWelcomed, !watchedSessions.isEmpty, let socket {
                let sessions = watchedSessions.sorted().map {
                    ReconnectSession(sessionId: $0, lastSeq: seqBySession[$0] ?? 0)
                }
                do {
                    try await socket.send(.data(JSONEncoder().encode(ClientMessage.reconnect(sessions: sessions))))
                } catch {
                    await receiveFailed(error, generation: generation)
                    return
                }
                guard generation == self.generation else { return }
            }
            hasWelcomed = true
            state = .connected(connectionId: connectionId)
            eventHandler?(.stateChanged(.connected(connectionId: connectionId)))

            // Flush pending sends
            while !pendingSends.isEmpty, generation == self.generation {
                let msg = pendingSends.removeFirst()
                do { try await send(msg) }
                catch {
                    // Never retry an uncertain send. Unattempted messages stay
                    // queued, and the originating consumer sees the failure.
                    await receiveFailed(error, generation: generation)
                    return
                }
            }

        default:
            break
        }

        // Forward to handler
        if generation == self.generation { eventHandler?(.message(message)) }
    }

    private func handleDisconnect(generation: UInt64) async {
        guard generation == self.generation, state != .disconnected else { return }
        let retired = socket
        socket = nil
        receiveTask?.cancel()
        receiveTask = nil
        heartbeatTimer?.cancel()
        heartbeatTimer = nil
        state = .reconnecting
        eventHandler?(.stateChanged(.reconnecting))
        scheduleReconnect(generation: generation)
        await retired?.cancel()
    }

    private func scheduleReconnect(generation: UInt64) {
        reconnectTimer?.cancel()
        reconnectTimer = Task {
            do { try await reconnectWait() }
            catch { return } // Explicit stop cancels this connection episode.
            guard !Task.isCancelled, generation == self.generation, state == .reconnecting else { return }
            await _connect()
        }
    }

    private func startHeartbeat(_ opened: any MitzoWebSocket, generation: UInt64) {
        heartbeatTimer?.cancel()
        heartbeatTimer = Task {
            while !Task.isCancelled {
                do { try await Task.sleep(nanoseconds: UInt64(heartbeatInterval * 1_000_000_000)) }
                catch { return }
                guard !Task.isCancelled, generation == self.generation else { return }

                // Check if connection is dead
                if !(await opened.isRunning()) {
                    await handleDisconnect(generation: generation)
                    break
                }
            }
        }
    }
}
