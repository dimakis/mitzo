import Foundation

/// Share the web-selected, validated origin; a cold approval launch needs no socket.
public func nativeRelayWebSocketURL(origin: String?, token: String) -> URL? {
    guard let server = notificationServerURL(origin),
          var components = URLComponents(url: server, resolvingAgainstBaseURL: false) else { return nil }
    components.scheme = components.scheme == "https" ? "wss" : "ws"
    components.path = "/ws/chat"
    components.queryItems = [URLQueryItem(name: "token", value: token)]
    return components.url
}
