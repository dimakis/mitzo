import Foundation
import Security
import Testing
@testable import MitzoShared

// Synthetic certificates only. Private keys were discarded; no system trust
// settings are changed. A fixed verification date keeps these tests repeatable.
private let rootCertificate = """
MIIC5TCCAc2gAwIBAgIBATANBgkqhkiG9w0BAQsFADAiMSAwHgYDVQQDDBdNaXR6
byBzeW50aGV0aWMgdGVzdCBDQTAeFw0yMDAxMDEwMDAwMDBaFw00MDAxMDEwMDAw
MDBaMCIxIDAeBgNVBAMMF01pdHpvIHN5bnRoZXRpYyB0ZXN0IENBMIIBIjANBgkq
hkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAlxMGvRKRYtF2CEewUP4S2Hm5kjb86SlN
yv2gn0mSIpkE1EQU9KLAydr6eOMo9W0uowaT1TaHJvG8GRrTXVt88PiJFZAAsnzf
BpdV01wR4Fyqv0YY5jQ1NIpizzJnRc0z7KEhEM93/3AkiaiyWwGKBCB12NQJp3vH
hnFRe2rcuF/oLrsFNIF8jrupgjJhstdcI/MdQO8T9cZx936ZrghEo/cbVxwb3Aj2
6ZeXFJG1fEos47w2J9M1veKRkAcMZcRXWImthej+UnRByatZXwgTVLPhte2rpSZJ
n6B+rHFRMRPlKMLCd5oT7eI3LZeEwQBRJPCTyX1usNbcyBtcwSDeOwIDAQABoyYw
JDASBgNVHRMBAf8ECDAGAQH/AgEAMA4GA1UdDwEB/wQEAwIBBjANBgkqhkiG9w0B
AQsFAAOCAQEAHCNfdY5mbUsXEIpFm4H8zyGKp9lN9Dz3/wP2NHy6652efBOnm16D
Lc/16Vpc0eFVG6aJult+ZlkvosLakxbo/AfO28tD7Fn0UQfb5wn67IIpatdHj1tv
dWMdNZkI5nggw3HL+QFUB487J7pFmZtICGmbYNyq/zO/M+Rqf4bHFkrF+h2QDmrl
yu8lXfswBP3WzkuvKymUQJQRlK9AGPXyKQZBgQloKokBO3SSlMvYHnc1tPYrZlaJ
qW8g14x3VQPBMwq746LA+6vOMT2LuwCBTZmesNE66ZTFQ8kx5bIrKzxa+1HE67cr
PNqGTep7Bxl/qyjdkKRrB7QbF955rfsDLg==
"""

private let serverCertificate = """
MIIDODCCAiCgAwIBAgIBAjANBgkqhkiG9w0BAQsFADAiMSAwHgYDVQQDDBdNaXR6
byBzeW50aGV0aWMgdGVzdCBDQTAeFw0yNjAxMDEwMDAwMDBaFw0yNzAxMDEwMDAw
MDBaMB4xHDAaBgNVBAMME2RlbW8uZXhhbXBsZS50cy5uZXQwggEiMA0GCSqGSIb3
DQEBAQUAA4IBDwAwggEKAoIBAQDG46XVBWLN5F/X/GAzwxZFK9TZrSJKhJ4tReXF
LBDw03pRC6913F3T5FVuYHZY6tEW0WVWOgIIYCzoUXeHMJHdzIGgV7JaX25eBbp4
5Kg0y5SKnZ54ADBJiHQR/EcTVantkELDEd58jrMg/ff3Dpw3d4HRJB2rDlyYJLne
e9jHQ794gXkQAo5Aqx7d6gY1mOrVRlSZL780lB1fZE7P3O5YLW1AfzVPx2dIxzCx
sWA8Sn9TYlh/NNax7YaY1Ag77/iwK6hMb2nqOAR44ISsw16mafrI0kMY14DZMFdK
HbJYMPAdEI0LzmWKJ0h5HjgUZTAFvA8xirjiad3RyFEJchajAgMBAAGjfTB7MAwG
A1UdEwEB/wQCMAAwRgYDVR0RBD8wPYITZGVtby5leGFtcGxlLnRzLm5ldIIJZGVt
by50YWlsgglsb2NhbGhvc3SCEGRlbW8uZXhhbXBsZS5jb20wEwYDVR0lBAwwCgYI
KwYBBQUHAwEwDgYDVR0PAQH/BAQDAgWgMA0GCSqGSIb3DQEBCwUAA4IBAQA9vxRy
ecuQ4sgYDrEeSaPbE8k8oCtDeAWxwEO7Tzms1q+iTWMKNTCCIcqDcSzGfXvYOgRr
5VwK+BoQsZOd5AKQ3yFXMOMCZkk6gIg/mauicqoPlK0Uq85R+ORF0Taa9zH5vqo7
MPnp80gaEhmy4OtGN7vOKPCHRrN06jz1FKg3XIBP+48FCrYSQCCMJQgeDqYC/TjM
plKpU+TcwQD3JEhddDPEM8TVE/+n2AkYMysQsqJkofl06KJSlfu1/827VB+qHV+p
qzGB2b/2D7f5iZgEusM67z8j4LRHQf1VAoaGc6E3xRLEo5V7LxTXVLOiE1fH/Vtb
v67deG4gFcRL8I8s
"""

private final class FixtureProtectionSpace: URLProtectionSpace, @unchecked Sendable {
    private let trust: SecTrust
    override var serverTrust: SecTrust? { trust }

    init(host: String, trust: SecTrust) {
        self.trust = trust
        super.init(host: host, port: 443, protocol: "https", realm: nil,
                   authenticationMethod: NSURLAuthenticationMethodServerTrust)
    }

    required init?(coder: NSCoder) { fatalError("Not used in tests") }
}

private final class FixtureChallengeSender: NSObject, URLAuthenticationChallengeSender {
    func use(_ credential: URLCredential, for challenge: URLAuthenticationChallenge) {}
    func continueWithoutCredential(for challenge: URLAuthenticationChallenge) {}
    func cancel(_ challenge: URLAuthenticationChallenge) {}
}

private enum CertificateCase: CaseIterable {
    case trusted, untrusted, expired, wrongHostname
}

@Test(arguments: ["demo.example.ts.net", "demo.tail", "localhost", "demo.example.com"],
      CertificateCase.allCases)
private func serverTrustUsesPlatformValidation(host: String, scenario: CertificateCase) async throws {
    let rootData = try #require(Data(base64Encoded: rootCertificate, options: .ignoreUnknownCharacters))
    let leafData = try #require(Data(base64Encoded: serverCertificate, options: .ignoreUnknownCharacters))
    let root = try #require(SecCertificateCreateWithData(nil, rootData as CFData))
    let leaf = try #require(SecCertificateCreateWithData(nil, leafData as CFData))
    let challengeHost = scenario == .wrongHostname ? "wrong.\(host)" : host
    let policy = SecPolicyCreateSSL(true, challengeHost as CFString)
    var optionalTrust: SecTrust?
    #expect(SecTrustCreateWithCertificates([leaf, root] as CFArray, policy, &optionalTrust) == errSecSuccess)
    let trust = try #require(optionalTrust)
    #expect(SecTrustSetNetworkFetchAllowed(trust, false) == errSecSuccess)
    // Explicit fixture anchors are scoped to this SecTrust object, never installed.
    if scenario != .untrusted {
        #expect(SecTrustSetAnchorCertificates(trust, [root] as CFArray) == errSecSuccess)
        #expect(SecTrustSetAnchorCertificatesOnly(trust, true) == errSecSuccess)
    }
    let dateString = scenario == .expired ? "2028-06-01T12:00:00Z" : "2026-06-01T12:00:00Z"
    let date = try #require(ISO8601DateFormatter().date(from: dateString))
    #expect(SecTrustSetVerifyDate(trust, date as CFDate) == errSecSuccess)
    #expect(SecTrustEvaluateWithError(trust, nil) == (scenario == .trusted))

    let challenge = URLAuthenticationChallenge(
        protectionSpace: FixtureProtectionSpace(host: challengeHost, trust: trust),
        proposedCredential: nil, previousFailureCount: 0,
        failureResponse: nil, error: nil, sender: FixtureChallengeSender())
    let (disposition, credential) = await TailscaleTrustDelegate.shared.urlSession(
        tailscaleURLSession, didReceive: challenge)
    #expect(disposition == .performDefaultHandling)
    #expect(credential == nil)
}

@Test func sharedNativeSessionUsesValidatedTransport() {
    #expect(tailscaleURLSession.delegate === TailscaleTrustDelegate.shared)
    #expect(tailscaleURLSession.configuration.timeoutIntervalForRequest == 15)
}
