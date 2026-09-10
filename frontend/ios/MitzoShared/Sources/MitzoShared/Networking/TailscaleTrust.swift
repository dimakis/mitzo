// Shared native transport uses platform TLS validation for every host.

import Foundation

/// Uses normal URLSession authentication handling for all hosts.
/// Self-signed deployments must explicitly establish trust on the device.
public final class TailscaleTrustDelegate: NSObject, URLSessionDelegate, Sendable {
    public static let shared = TailscaleTrustDelegate()

    public func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge
    ) async -> (URLSession.AuthChallengeDisposition, URLCredential?) {
        // Network location does not establish server identity. Let URLSession
        // validate the certificate chain, expiry and hostname using platform trust.
        return (.performDefaultHandling, nil)
    }
}

/// Shared URLSession with platform certificate validation and a bounded request timeout.
public let tailscaleURLSession: URLSession = {
    let config = URLSessionConfiguration.default
    config.timeoutIntervalForRequest = 15
    return URLSession(configuration: config, delegate: TailscaleTrustDelegate.shared, delegateQueue: nil)
}()
