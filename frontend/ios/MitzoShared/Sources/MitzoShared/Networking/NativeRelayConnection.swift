import Foundation

/// One native relay owner for foreground transitions and cold Watch demand.
/// Configuration is re-read for each acquisition. Only an identical origin and
/// credential may reuse subscription/cursor intent; changed authority retires
/// the old actor, including its unattempted command queue.
public actor NativeRelayConnection {
    public enum ConnectionError: Error { case unavailable }
    private let configuration: @Sendable () async -> URL?
    private let makeClient: @Sendable (URL) -> MitzoWSClient
    private let onEvent: @Sendable (MitzoWSClient.Event) -> Void
    private var client: MitzoWSClient?
    private var selectedURL: URL?
    private var pending: (id: UUID, task: Task<MitzoWSClient, Error>)?
    private var completedConnections: UInt64 = 0
    internal private(set) var acquisitions = 0

    public init(configuration: @escaping @Sendable () async -> URL?,
                onEvent: @escaping @Sendable (MitzoWSClient.Event) -> Void) {
        self.configuration = configuration; self.onEvent = onEvent
        self.makeClient = { MitzoWSClient(url: $0) }
    }

    init(configuration: @escaping @Sendable () async -> URL?,
         onEvent: @escaping @Sendable (MitzoWSClient.Event) -> Void = { _ in },
         makeClient: @escaping @Sendable (URL) -> MitzoWSClient) {
        self.configuration = configuration; self.onEvent = onEvent; self.makeClient = makeClient
    }

    public func acquire(reconnect: Bool = false) async throws -> MitzoWSClient {
        acquisitions += 1
        let observedConnection = completedConnections
        try Task.checkCancellation()
        guard let expectedURL = await configuration() else {
            await invalidate()
            throw ConnectionError.unavailable
        }
        try Task.checkCancellation()
        if let selectedURL, selectedURL != expectedURL { await invalidate() }
        let previous = pending?.task
        let id = UUID()
        // Serialize setup, preserving every caller's fresh authority and
        // reconnect intent. A connection completed after this request began
        // already satisfies its reconnect request; otherwise restart it once.
        let task = Task {
            if let previous { _ = await previous.result }
            return try await establish(expectedURL: expectedURL,
                reconnect: reconnect && completedConnections == observedConnection)
        }
        pending = (id, task)
        defer { if pending?.id == id { pending = nil } }
        let candidate = try await task.value
        try Task.checkCancellation()
        try await validate(candidate, expectedURL: expectedURL)
        return candidate
    }

    public func suspend() async throws {
        // No native connection means no subscriptions to suspend.
        guard let client else { return }
        let sessions = await client.getSuspendSessions()
        if !sessions.isEmpty { try await client.suspend(sessions: sessions) }
    }

    private func establish(expectedURL: URL, reconnect: Bool) async throws -> MitzoWSClient {
        let currentURL = await configuration()
        guard currentURL == expectedURL else {
            // A newer valid owner must survive a stale request, but an old
            // owner must not retain its queue after logout/configuration loss.
            if let selectedURL, selectedURL != currentURL { await invalidate() }
            throw ConnectionError.unavailable
        }
        if selectedURL == expectedURL, let client {
            if reconnect {
                await client.disconnect()
                await client.connect(onEvent: onEvent)
            }
            try await validate(client, expectedURL: expectedURL)
            if reconnect { completedConnections &+= 1 }
            return client
        }
        await invalidate()
        let next = makeClient(expectedURL)
        client = next; selectedURL = expectedURL
        await next.connect(onEvent: onEvent)
        try await validate(next, expectedURL: expectedURL)
        completedConnections &+= 1
        return next
    }

    private func validate(_ candidate: MitzoWSClient, expectedURL: URL) async throws {
        guard await configuration() == expectedURL, selectedURL == expectedURL, client === candidate else {
            if client === candidate { await invalidate() }
            throw ConnectionError.unavailable
        }
    }

    private func invalidate() async {
        let previous = client; client = nil; selectedURL = nil
        await previous?.retire()
    }
}

/// Cold Watch reads do not require a foreground scene or a chat socket.
public struct WatchRelayReads: Sendable {
    private let apiProvider: @Sendable () -> MitzoAPIClient?
    public init(apiProvider: @escaping @Sendable () -> MitzoAPIClient?) { self.apiProvider = apiProvider }
    public func sessions() async throws -> Data {
        guard let api = apiProvider() else { throw NativeRelayConnection.ConnectionError.unavailable }
        return try JSONEncoder().encode(await api.getSessions())
    }
    public func messages(sessionId: String) async throws -> Data {
        guard let api = apiProvider() else { throw NativeRelayConnection.ConnectionError.unavailable }
        return try JSONEncoder().encode(await api.getMessages(sessionId: sessionId))
    }
}
