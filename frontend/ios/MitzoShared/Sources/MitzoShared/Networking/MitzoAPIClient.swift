// REST API client for sessions and messages

import Foundation

public actor MitzoAPIClient {
    public enum APIError: Error {
        case invalidResponse
        case unauthorized
        case networkError(Error)
    }

    private let baseURL: URL
    private let authManager: AuthManager

    public init(baseURL: URL, authManager: AuthManager) {
        self.baseURL = baseURL
        self.authManager = authManager
    }

    // MARK: - Sessions

    public func getSessions() async throws -> [Session] {
        try await get(path: "/api/sessions")
    }

    public func getSession(id: String) async throws -> Session {
        try await get(path: "/api/sessions/\(id)")
    }

    public func getMessages(sessionId: String) async throws -> [FinishedMessage] {
        try await get(path: "/api/sessions/\(sessionId)/messages")
    }

    // MARK: - Generic Request

    private func get<T: Decodable>(path: String) async throws -> T {
        let url = baseURL.appendingPathComponent(path)
        var request = URLRequest(url: url)
        request.httpMethod = "GET"

        // Add auth token
        if let token = try? await authManager.getToken() {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        let (data, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw APIError.invalidResponse
        }

        if httpResponse.statusCode == 401 {
            throw APIError.unauthorized
        }

        guard (200...299).contains(httpResponse.statusCode) else {
            throw APIError.invalidResponse
        }

        return try JSONDecoder().decode(T.self, from: data)
    }
}
