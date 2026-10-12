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
        CAPPluginMethod(name: "configureNotificationServer", returnType: CAPPluginReturnPromise),
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

    @objc func configureNotificationServer(_ call: CAPPluginCall) {
        guard let url = notificationServerURL(call.getString("url")) else {
            call.reject("Invalid notification server origin")
            return
        }
        UserDefaults.standard.set(url.absoluteString, forKey: "mitzo_notification_server_url")
        call.resolve()
    }

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

/// Share a local file URL so iOS keeps its extension and does not open a webview URL.
@objc(FileShareBridge)
public class FileShareBridge: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "FileShareBridge"
    public let jsName = "FileShareBridge"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "share", returnType: CAPPluginReturnPromise),
    ]
    private var sharing = false

    @objc func share(_ call: CAPPluginCall) {
        guard let filename = call.getString("filename"), let base64 = call.getString("base64") else {
            call.reject("Missing file bytes or filename")
            return
        }
        DispatchQueue.main.async { [weak self] in
            guard let self, !self.sharing, var presenter = self.bridge?.viewController else {
                call.reject("Share sheet unavailable. Try again.")
                return
            }
            while let presented = presenter.presentedViewController {
                guard !(presented is UIActivityViewController), !presented.isBeingDismissed else {
                    call.reject("A share sheet is already open. Try again after closing it.")
                    return
                }
                presenter = presented
            }
            guard presenter.viewIfLoaded?.window != nil else {
                call.reject("Return to Mitzo to share this file.")
                return
            }
            let file: SharedFile
            do { file = try SharedFile.prepare(filename: filename, base64: base64) }
            catch {
                call.reject("Could not prepare this file for sharing.")
                return
            }
            self.sharing = true
            let sheet = UIActivityViewController(activityItems: [file.url], applicationActivities: nil)
            sheet.completionWithItemsHandler = { _, completed, _, error in
                file.remove()
                self.sharing = false
                if let error { call.reject("Could not share this file", nil, error) }
                else { call.resolve(["completed": completed]) }
            }
            if let popover = sheet.popoverPresentationController {
                popover.sourceView = presenter.view
                popover.sourceRect = CGRect(x: presenter.view.bounds.midX,
                                            y: presenter.view.bounds.midY, width: 0, height: 0)
                popover.permittedArrowDirections = []
            }
            presenter.present(sheet, animated: true)
        }
    }
}
