// WebSocket v2 Client
// Swift equivalent of packages/client/src/connection.ts

import Foundation

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
    private var wsTask: URLSessionWebSocketTask?
    private var state: State = .disconnected
    private var seqBySession: [String: Int] = [:]
    private var pendingSends: [ClientMessage] = []
    private var reconnectTimer: Task<Void, Never>?
    private var heartbeatTimer: Task<Void, Never>?
    private var eventHandler: ((Event) -> Void)?

    private let maxPendingSends = 100
    private let heartbeatInterval: TimeInterval = 5.0
    private let reconnectDelay: TimeInterval = 0.5

    public init(url: URL) {
        self.url = url
    }

    // MARK: - Public API

    public func connect(onEvent: @escaping (Event) -> Void) {
        eventHandler = onEvent
        Task {
            await _connect()
        }
    }

    public func disconnect() async {
        heartbeatTimer?.cancel()
        heartbeatTimer = nil
        reconnectTimer?.cancel()
        reconnectTimer = nil
        wsTask?.cancel(with: .goingAway, reason: nil)
        wsTask = nil
        state = .disconnected
        eventHandler?(.stateChanged(.disconnected))
    }

    public func send(_ message: ClientMessage) async throws {
        // If not connected, queue it
        guard case .connected = state else {
            if pendingSends.count < maxPendingSends {
                pendingSends.append(message)
            }
            return
        }

        let data = try JSONEncoder().encode(message)
        try await wsTask?.send(.data(data))
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
        seqBySession.map { SuspendSession(sessionId: $0.key, lastSeq: $0.value) }
    }

    // MARK: - Internal Connection Logic

    private func _connect() async {
        guard state == .disconnected || state == .reconnecting else { return }

        state = .connecting
        eventHandler?(.stateChanged(.connecting))

        let session = URLSession(configuration: .default)
        wsTask = session.webSocketTask(with: url)
        wsTask?.resume()

        // Send hello
        do {
            try await send(.hello())
            startReceiving()
            startHeartbeat()
        } catch {
            eventHandler?(.error(error))
            scheduleReconnect()
        }
    }

    private func startReceiving() {
        Task {
            while let wsTask = wsTask {
                do {
                    let message = try await wsTask.receive()
                    await handleMessage(message)
                } catch {
                    // Connection closed or error
                    await handleDisconnect()
                    break
                }
            }
        }
    }

    private func handleMessage(_ message: URLSessionWebSocketTask.Message) async {
        switch message {
        case .data(let data):
            do {
                let serverMsg = try JSONDecoder().decode(ServerMessage.self, from: data)
                await processServerMessage(serverMsg)
            } catch {
                eventHandler?(.error(error))
            }

        case .string(let text):
            // Try to decode as JSON
            guard let data = text.data(using: .utf8) else { return }
            do {
                let serverMsg = try JSONDecoder().decode(ServerMessage.self, from: data)
                await processServerMessage(serverMsg)
            } catch {
                eventHandler?(.error(error))
            }

        @unknown default:
            break
        }
    }

    private func processServerMessage(_ message: ServerMessage) async {
        // Update seq if present
        switch message {
        case .sessionId(let sessionId, let seq, _):
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
            state = .connected(connectionId: connectionId)
            eventHandler?(.stateChanged(.connected(connectionId: connectionId)))

            // Flush pending sends
            let pending = pendingSends
            pendingSends = []
            for msg in pending {
                try? await send(msg)
            }

        default:
            break
        }

        // Forward to handler
        eventHandler?(.message(message))
    }

    private func handleDisconnect() async {
        heartbeatTimer?.cancel()
        heartbeatTimer = nil
        wsTask = nil

        guard state != .disconnected else { return }

        state = .reconnecting
        eventHandler?(.stateChanged(.reconnecting))
        scheduleReconnect()
    }

    private func scheduleReconnect() {
        reconnectTimer?.cancel()
        reconnectTimer = Task {
            try? await Task.sleep(nanoseconds: UInt64(reconnectDelay * 1_000_000_000))
            await _connect()
        }
    }

    private func startHeartbeat() {
        heartbeatTimer?.cancel()
        heartbeatTimer = Task {
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(heartbeatInterval * 1_000_000_000))

                // Check if connection is dead
                if wsTask?.state != .running {
                    await handleDisconnect()
                    break
                }
            }
        }
    }
}
