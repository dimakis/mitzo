import AuthenticationServices
import Capacitor
import OSLog
import UIKit

/// The OS presents Apple authentication. Only its one-use code and matching
/// state cross the bridge; Mitzo's server verifies the identity and owner.
@objc(AppleSignInBridge)
public class AppleSignInBridge: CAPPlugin, CAPBridgedPlugin,
    ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
    public let identifier = "AppleSignInBridge"
    public let jsName = "AppleSignInBridge"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "authorize", returnType: CAPPluginReturnPromise),
    ]
    private static let log = Logger(subsystem: "com.mitzo.app", category: "apple-sign-in")
    private var pending: CAPPluginCall?
    private var controller: ASAuthorizationController?
    private var anchor: UIWindow?
    private var expectedState: String?
    private var timeout: DispatchWorkItem?
    private var requestID: String?

    @objc func authorize(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { call.reject("Apple sign-in unavailable", "APPLE_UNAVAILABLE"); return }
            guard self.pending == nil else { call.reject("Apple sign-in already in progress", "APPLE_BUSY"); return }
            guard let state = call.getString("state"), let nonce = call.getString("nonce"),
                  state.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil,
                  nonce.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil,
                  let window = self.bridge?.viewController?.view.window else {
                call.reject("Apple sign-in unavailable. Try again.", "APPLE_UNAVAILABLE"); return
            }
            let request = ASAuthorizationAppleIDProvider().createRequest()
            request.state = state
            request.nonce = nonce
            // No email or name scope: ownership uses only the verified subject.
            let controller = ASAuthorizationController(authorizationRequests: [request])
            self.pending = call
            self.controller = controller
            self.anchor = window
            self.expectedState = state
            self.requestID = UUID().uuidString
            controller.delegate = self
            controller.presentationContextProvider = self
            let timeout = DispatchWorkItem { [weak self, weak controller] in
                guard let self, let controller, self.controller === controller else { return }
                self.fail("APPLE_TIMEOUT")
            }
            self.timeout = timeout
            DispatchQueue.main.asyncAfter(deadline: .now() + 300, execute: timeout)
            controller.performRequests()
        }
    }

    public func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        // Captured before presentation and retained until the controller settles.
        return anchor ?? ASPresentationAnchor()
    }

    public func authorizationController(controller: ASAuthorizationController,
                                        didCompleteWithAuthorization authorization: ASAuthorization) {
        guard self.controller === controller else { return }
        guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
              let data = credential.authorizationCode,
              let code = String(data: data, encoding: .utf8), !code.isEmpty,
              let state = credential.state, state == expectedState else {
            fail("APPLE_INVALID_RESULT"); return
        }
        let call = pending
        clear()
        call?.resolve(["state": state, "code": code])
    }

    public func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        guard self.controller === controller else { return }
        let cancelled = (error as? ASAuthorizationError)?.code == .canceled
        let cause = error as NSError
        // Preserve the native diagnostic privately; never log authorization codes or identity tokens.
        Self.log.notice("authorization_finished request=\(self.requestID ?? "unknown", privacy: .public) domain=\(cause.domain, privacy: .public) code=\(cause.code) cause=\(cause, privacy: .private)")
        fail(cancelled ? "APPLE_CANCELLED" : "APPLE_FAILED")
    }

    private func fail(_ code: String) {
        Self.log.notice("authorization_failed request=\(self.requestID ?? "unknown", privacy: .public) code=\(code, privacy: .public)")
        let call = pending
        clear()
        call?.reject(code == "APPLE_CANCELLED" ? "Apple sign-in was cancelled" : "Apple sign-in could not complete. Try again.", code)
    }

    private func clear() {
        timeout?.cancel()
        timeout = nil
        controller?.delegate = nil
        controller?.presentationContextProvider = nil
        controller = nil
        pending = nil
        anchor = nil
        expectedState = nil
        requestID = nil
    }
}
