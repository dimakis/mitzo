import Foundation
import Testing
@testable import MitzoShared

@Test func nativeRelayUsesOnlyTheValidatedConfiguredNotificationOrigin() throws {
    for origin in [nil, "", "not a URL", "file:///tmp/server", "https://user:password@example.invalid", "https://example.invalid/api", "https://example.invalid?other=1"] as [String?] {
        #expect(nativeRelayWebSocketURL(origin: origin, token: "fixture-token") == nil)
    }
    for (origin, scheme) in [("https://example.invalid:3100/", "wss"), ("http://localhost:3100", "ws")] {
        let url = try #require(nativeRelayWebSocketURL(origin: origin, token: "fixture +& token"))
        let parts = try #require(URLComponents(url: url, resolvingAgainstBaseURL: false))
        #expect(parts.scheme == scheme)
        #expect(parts.path == "/ws/chat")
        #expect(parts.port == 3100)
        #expect(parts.queryItems == [URLQueryItem(name: "token", value: "fixture +& token")])
    }
}
