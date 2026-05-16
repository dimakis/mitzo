// Capacitor plugin that bridges web auth tokens into the native shared Keychain.
// When the web app logs in, it calls WatchAuthBridge.saveToken() so the
// watch can read the JWT from the shared Keychain access group.

import Capacitor
import MitzoShared

@objc(WatchAuthBridge)
public class WatchAuthBridge: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "WatchAuthBridge"
    public let jsName = "WatchAuthBridge"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "saveToken", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearToken", returnType: CAPPluginReturnPromise),
    ]

    private let authManager = AuthManager()

    @objc func saveToken(_ call: CAPPluginCall) {
        guard let token = call.getString("token") else {
            call.reject("Missing token")
            return
        }

        Task {
            do {
                try await authManager.saveToken(token)
                call.resolve()
            } catch {
                call.reject("Failed to save token: \(error.localizedDescription)")
            }
        }
    }

    @objc func clearToken(_ call: CAPPluginCall) {
        Task {
            do {
                try await authManager.clearToken()
                call.resolve()
            } catch {
                call.reject("Failed to clear token: \(error.localizedDescription)")
            }
        }
    }
}
