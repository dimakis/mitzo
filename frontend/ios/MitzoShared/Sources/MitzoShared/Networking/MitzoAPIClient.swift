// REST API client for sessions and messages

import Foundation

public actor MitzoAPIClient {
    public enum APIError: Error {
        case invalidResponse
        case unauthorized
        case notFound
        case networkError(Error)
    }

    private let baseURL: URL
    private let authManager: AuthManager

    public init(baseURL: URL, authManager: AuthManager) {
        self.baseURL = baseURL
        self.authManager = authManager
    }

    // MARK: - Sessions

    public func getSessions(offset: Int = 0, limit: Int = 20) async throws -> SessionsResponse {
        try await get(path: "/api/sessions", query: [
            URLQueryItem(name: "offset", value: "\(offset)"),
            URLQueryItem(name: "limit", value: "\(limit)")
        ])
    }

    public func getSessionMeta(id: String) async throws -> SessionMeta {
        try await get(path: "/api/sessions/\(id)/meta")
    }

    public func getMessages(sessionId: String) async throws -> [FinishedMessage] {
        try await get(path: "/api/sessions/\(sessionId)/messages")
    }

    // MARK: - Notifications

    public func getNotifications() async throws -> NotificationFeed {
        try await get(path: "/api/notifications", query: [
            URLQueryItem(name: "filter", value: "all"),
            URLQueryItem(name: "limit", value: "10")
        ])
    }

    public func respondNotification(id: String, response: NotificationResponse) async throws {
        // IDs are a single path component, never a producer-supplied URL.
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_:"))
        guard !id.isEmpty, id.unicodeScalars.allSatisfy({ allowed.contains($0) }) else {
            throw APIError.invalidResponse
        }
        let result: NotificationResponseResult = try await get(
            path: "/api/notifications/\(id)/respond", method: "POST",
            body: JSONEncoder().encode(response)
        )
        guard result.ok else { throw APIError.invalidResponse }
    }

    private struct NotificationResponseResult: Decodable { let ok: Bool }

    // MARK: - Generic Request

    private func get<T: Decodable>(path: String, query: [URLQueryItem]? = nil, method: String = "GET", body: Data? = nil) async throws -> T {
        var components = URLComponents(url: baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        components.queryItems = query

        guard let url = components.url else {
            throw APIError.invalidResponse
        }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.httpBody = body
        if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }

        let token = try await authManager.getToken()
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        let (data, response) = try await tailscaleURLSession.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw APIError.invalidResponse
        }

        switch httpResponse.statusCode {
        case 200...299:
            return try JSONDecoder().decode(T.self, from: data)
        case 401:
            throw APIError.unauthorized
        case 404:
            throw APIError.notFound
        default:
            throw APIError.invalidResponse
        }
    }
}
