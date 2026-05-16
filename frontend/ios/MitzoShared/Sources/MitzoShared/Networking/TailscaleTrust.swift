// URLSession that trusts Tailscale / self-signed certificates.
// Mitzo runs over Tailscale with HTTPS; the cert isn't in the
// system trust store, so URLSession rejects it by default.

import Foundation

/// URLSession delegate that accepts TLS certificates for *.ts.net
/// and localhost hosts (matching Capacitor's allowNavigation config).
public final class TailscaleTrustDelegate: NSObject, URLSessionDelegate, Sendable {
    public static let shared = TailscaleTrustDelegate()

    public func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge
    ) async -> (URLSession.AuthChallengeDisposition, URLCredential?) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust else {
            return (.performDefaultHandling, nil)
        }

        let host = challenge.protectionSpace.host
        if host.hasSuffix(".ts.net") || host == "localhost" || host.hasSuffix(".tail") || host.hasPrefix("100.") {
            return (.useCredential, URLCredential(trust: trust))
        }

        return (.performDefaultHandling, nil)
    }
}

/// Shared URLSession that trusts Tailscale hosts.
public let tailscaleURLSession: URLSession = {
    let config = URLSessionConfiguration.default
    config.timeoutIntervalForRequest = 15
    return URLSession(configuration: config, delegate: TailscaleTrustDelegate.shared, delegateQueue: nil)
}()
