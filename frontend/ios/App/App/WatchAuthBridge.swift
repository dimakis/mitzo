// Capacitor plugin that bridges web auth tokens into the native shared Keychain.
// When the web app logs in, it calls WatchAuthBridge.saveToken() so the
// watch can read the JWT from the shared Keychain access group.

import Capacitor
import UserNotifications
import UIKit
import MitzoShared

@objc(WatchAuthBridge)
public class WatchAuthBridge: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "WatchAuthBridge"
    public let jsName = "WatchAuthBridge"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "saveToken", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearToken", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setNotificationBadge", returnType: CAPPluginReturnPromise),
    ]

    @objc func setNotificationBadge(_ call: CAPPluginCall) {
        guard let count = call.getInt("count"), count >= 0 else {
            call.reject("Invalid badge count")
            return
        }
        DispatchQueue.main.async {
            if #available(iOS 16.0, *) {
                UNUserNotificationCenter.current().setBadgeCount(count) { error in
                    if let error = error { call.reject(error.localizedDescription) }
                    else { call.resolve() }
                }
            } else {
                UIApplication.shared.applicationIconBadgeNumber = count
                call.resolve()
            }
        }
    }

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
