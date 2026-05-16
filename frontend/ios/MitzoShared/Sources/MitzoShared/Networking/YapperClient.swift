// Yapper STT client
// Streaming WebSocket transcription

import Foundation

public actor YapperClient {
    public enum TranscriptEvent: Sendable {
        case partial(String)
        case final(String)
        case error(Error)
    }

    public enum YapperError: Error {
        case notConnected
        case connectionFailed
    }

    private let baseURL: URL
    private var wsTask: URLSessionWebSocketTask?
    private var eventHandler: ((TranscriptEvent) -> Void)?

    public init(baseURL: URL) {
        self.baseURL = baseURL
    }

    // MARK: - Health Check

    public func checkHealth() async throws -> Bool {
        let healthURL = baseURL.appendingPathComponent("/health")
        let (data, _) = try await tailscaleURLSession.data(from: healthURL)

        struct HealthResponse: Decodable {
            let status: String
            let models: Models?

            struct Models: Decodable {
                let stt: Bool?
                let tts: Bool?
            }
        }

        let health = try JSONDecoder().decode(HealthResponse.self, from: data)
        return health.status == "ready" && (health.models?.stt == true)
    }

    // MARK: - Streaming STT

    public func startStreaming(onEvent: @escaping (TranscriptEvent) -> Void) async throws {
        eventHandler = onEvent

        // Build WS URL
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
        components.scheme = components.scheme == "https" ? "wss" : "ws"
        components.path = "/v1/transcribe/stream"

        guard let wsURL = components.url else {
            throw YapperError.connectionFailed
        }

        wsTask = tailscaleURLSession.webSocketTask(with: wsURL)
        wsTask?.resume()

        // Send format frame
        try await wsTask?.send(.string("{\"format\":\"pcm\"}"))

        // Start receiving
        startReceiving()
    }

    public func sendAudio(_ data: Data) async throws {
        guard let wsTask = wsTask else {
            throw YapperError.notConnected
        }

        try await wsTask.send(.data(data))
    }

    public func endStreaming() async throws {
        guard let wsTask = wsTask else {
            throw YapperError.notConnected
        }

        try await wsTask.send(.string("END"))
    }

    public func close() async {
        wsTask?.cancel(with: .goingAway, reason: nil)
        wsTask = nil
    }

    // MARK: - Receiving

    private func startReceiving() {
        Task {
            while let wsTask = wsTask {
                do {
                    let message = try await wsTask.receive()
                    await handleMessage(message)
                } catch {
                    eventHandler?(.error(error))
                    break
                }
            }
        }
    }

    private func handleMessage(_ message: URLSessionWebSocketTask.Message) async {
        switch message {
        case .string(let text):
            // Parse JSON transcript event
            guard let data = text.data(using: .utf8) else { return }

            struct TranscriptResponse: Decodable {
                let type: String
                let text: String
            }

            do {
                let response = try JSONDecoder().decode(TranscriptResponse.self, from: data)

                if response.type == "partial" {
                    eventHandler?(.partial(response.text))
                } else if response.type == "final" {
                    eventHandler?(.final(response.text))
                }
            } catch {
                eventHandler?(.error(error))
            }

        case .data:
            // Unexpected binary frame
            break

        @unknown default:
            break
        }
    }
}
