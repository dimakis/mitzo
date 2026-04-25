// Auth manager with shared Keychain storage

import Foundation
import Security

public actor AuthManager {
    public enum AuthError: Error {
        case noToken
        case keychainError(OSStatus)
        case invalidResponse
    }

    private let keychainService = "com.mitzo.app"
    private let keychainAccount = "jwt"
    private let accessGroup = "$(TeamIdentifierPrefix)com.mitzo.app"

    private var cachedToken: String?

    public init() {}

    // MARK: - Token Management

    public func getToken() throws -> String {
        if let cached = cachedToken {
            return cached
        }

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: keychainAccount,
            kSecAttrAccessGroup as String: accessGroup,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)

        guard status == errSecSuccess,
              let data = result as? Data,
              let token = String(data: data, encoding: .utf8) else {
            throw AuthError.keychainError(status)
        }

        cachedToken = token
        return token
    }

    public func saveToken(_ token: String) throws {
        cachedToken = token

        let data = token.data(using: .utf8)!

        // Try to update first
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: keychainAccount,
            kSecAttrAccessGroup as String: accessGroup
        ]

        let attributes: [String: Any] = [
            kSecValueData as String: data
        ]

        var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)

        if status == errSecItemNotFound {
            // Item doesn't exist, add it
            var addQuery = query
            addQuery[kSecValueData as String] = data
            addQuery[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock

            status = SecItemAdd(addQuery as CFDictionary, nil)
        }

        guard status == errSecSuccess else {
            throw AuthError.keychainError(status)
        }
    }

    public func clearToken() throws {
        cachedToken = nil

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: keychainAccount,
            kSecAttrAccessGroup as String: accessGroup
        ]

        let status = SecItemDelete(query as CFDictionary)

        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw AuthError.keychainError(status)
        }
    }

    public func isAuthenticated() -> Bool {
        (try? getToken()) != nil
    }

    // MARK: - Login

    public func login(passphrase: String, serverURL: URL) async throws -> String {
        var request = URLRequest(url: serverURL.appendingPathComponent("/api/auth/login"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let body = ["passphrase": passphrase]
        request.httpBody = try JSONEncoder().encode(body)

        let (data, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse,
              (200...299).contains(httpResponse.statusCode) else {
            throw AuthError.invalidResponse
        }

        let loginResponse = try JSONDecoder().decode(LoginResponse.self, from: data)
        try saveToken(loginResponse.token)

        return loginResponse.token
    }
}

private struct LoginResponse: Decodable {
    let token: String
}
