import UIKit
import UserNotifications
import Capacitor
import MitzoShared
import OSLog

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?
    private lazy var watchRelay = WatchRelayCoordinator()
    private let approvalDelegate = BackgroundApprovalDelegate()

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Background action launches may never create a scene or webview.
        UNUserNotificationCenter.current().delegate = approvalDelegate
        registerNotificationCategories()
        return true
    }

    func attachNotificationRouter(_ router: NotificationRouter) {
        watchRelay.start()
        approvalDelegate.attach(router)
        // Capacitor installs its router during bridge creation. Restore the
        // same app-owned delegate, preserving any cold-launch responses.
        UNUserNotificationCenter.current().delegate = approvalDelegate
        approvalDelegate.reconcileReceipts()
    }

    private func registerNotificationCategories() {
        let replyAction = UNTextInputNotificationAction(
            identifier: "REPLY_ACTION",
            title: "Reply",
            options: [.foreground],
            textInputButtonTitle: "Send",
            textInputPlaceholder: "Type your reply..."
        )

        let viewAction = UNNotificationAction(
            identifier: "VIEW_ACTION",
            title: "View",
            options: [.foreground]
        )

        let laterAction = UNNotificationAction(
            identifier: "LATER_ACTION",
            title: "Later",
            options: []
        )

        let sessionCategory = UNNotificationCategory(
            identifier: "SESSION_UPDATE",
            actions: [replyAction, viewAction, laterAction],
            intentIdentifiers: [],
            options: [.customDismissAction]
        )

        let reviewAction = UNNotificationAction(
            identifier: "REVIEW_PERMISSION_ACTION", title: "Approve or deny", options: [.foreground]
        )
        let permissionCategory = UNNotificationCategory(
            identifier: "SESSION_PERMISSION", actions: [reviewAction], intentIdentifiers: [], options: []
        )
        let onceAction = UNNotificationAction(identifier: "ALLOW_ONCE_ACTION", title: "Allow once", options: [.authenticationRequired])
        let sessionAction = UNNotificationAction(identifier: "ALLOW_SESSION_ACTION", title: "Allow for session", options: [.authenticationRequired])
        let searchAction = UNNotificationAction(identifier: "ALLOW_SEARCH_SESSION_ACTION", title: "Allow searches for session", options: [.authenticationRequired])
        let denyAction = UNNotificationAction(identifier: "DENY_PERMISSION_ACTION", title: "Deny", options: [.destructive, .authenticationRequired])
        let conversationAction = UNNotificationAction(identifier: "ALLOW_CONVERSATION_ACTION", title: "Grant to conversation", options: [.authenticationRequired])
        let onceCategory = UNNotificationCategory(identifier: "SESSION_APPROVAL_ONCE", actions: [onceAction, denyAction, reviewAction], intentIdentifiers: [], options: [])
        let conversationCategory = UNNotificationCategory(identifier: "SESSION_CONVERSATION_APPROVAL", actions: [conversationAction, denyAction, reviewAction], intentIdentifiers: [], options: [])
        let approvalCategory = UNNotificationCategory(identifier: "SESSION_APPROVAL", actions: [onceAction, sessionAction, denyAction, reviewAction], intentIdentifiers: [], options: [])
        let searchCategory = UNNotificationCategory(identifier: "SESSION_SEARCH_PERMISSION", actions: [onceAction, searchAction, denyAction, reviewAction], intentIdentifiers: [], options: [])
        let updateCategory = UNNotificationCategory(
            identifier: "NOTIFICATION_UPDATE", actions: [viewAction], intentIdentifiers: [], options: []
        )
        UNUserNotificationCenter.current().setNotificationCategories([sessionCategory, permissionCategory, approvalCategory, onceCategory, conversationCategory, searchCategory, updateCategory])
    }

    func application(_ application: UIApplication,
                     configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let configuration = UISceneConfiguration(name: "Default Configuration",
                                                sessionRole: connectingSceneSession.role)
        configuration.delegateClass = SceneDelegate.self
        return configuration
    }

    func suspendWatchRelay() {
        watchRelay.suspend()
    }

    func reconnectWatchRelay() {
        watchRelay.reconnect()
        approvalDelegate.reconcileReceipts()
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        // Called when the app was launched with a url. Feel free to add additional processing here,
        // but if you want the App API to support tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        // Called when the app was launched with an activity, including Universal Links.
        // Feel free to add additional processing here, but if you want the App API to support
        // tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications, object: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)
    }

}

/// Attach UI navigation when a scene exists; background approvals already have
/// their app-owned delegate and do not depend on this controller loading.
@objc
class MitzoBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        // App-local plugins are absent from Capacitor's generated package list.
        // Export the header before the web app creates its registerPlugin proxy.
        bridge?.registerPluginInstance(WatchAuthBridge())
        bridge?.registerPluginInstance(FileShareBridge())
        guard let router = bridge?.notificationRouter else { return }
        (UIApplication.shared.delegate as? AppDelegate)?.attachNotificationRouter(router)
    }
}

private class BackgroundApprovalDelegate: NSObject, UNUserNotificationCenterDelegate {
    private static let log = Logger(subsystem: "com.mitzo.app", category: "notification-approval")
    private struct Attempt: Codable {
        let identity: NativeApprovalIdentity
        let origin: String
        let deliveredID: String
        var code: String
    }
    private static let attemptsKey = "mitzo_notification_approval_attempts"
    // Accessed on the main actor along with UIKit background-task ownership.
    private var executions: [String: BackgroundApprovalExecution] = [:]
    private var reconciling = false
    private let lock = NSLock()
    private var fallback: NotificationRouter?
    private var deferredResponses: [UNNotificationResponse] = []

    func attach(_ router: NotificationRouter) {
        let responses = lock.withLock {
            fallback = router
            let pending = deferredResponses
            deferredResponses.removeAll()
            return pending
        }
        for response in responses { forward(response, completionHandler: {}) }
    }

    private func forward(_ response: UNNotificationResponse, completionHandler: @escaping () -> Void) {
        let router = lock.withLock { () -> NotificationRouter? in
            guard let fallback else { deferredResponses.append(response); return nil }
            return fallback
        }
        guard let router else { completionHandler(); return }
        if response.notification.request.identifier.hasSuffix("-response-error") {
            router.pushNotificationHandler?.didReceive(response: response)
            completionHandler()
        } else {
            router.userNotificationCenter(UNUserNotificationCenter.current(), didReceive: response, withCompletionHandler: completionHandler)
        }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        if let router = lock.withLock({ fallback }) {
            router.userNotificationCenter(center, willPresent: notification, withCompletionHandler: completionHandler)
        } else { completionHandler([.banner, .list, .sound, .badge]) }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let action = response.actionIdentifier
        guard ["ALLOW_ONCE_ACTION", "ALLOW_SESSION_ACTION", "ALLOW_CONVERSATION_ACTION", "ALLOW_SEARCH_SESSION_ACTION", "DENY_PERMISSION_ACTION"].contains(action) else {
            forward(response, completionHandler: completionHandler)
            return
        }
        let info = response.notification.request.content.userInfo
        let deliveredID = response.notification.request.identifier
        Task { @MainActor in
            guard let id = info["notificationId"] as? String,
                  let sessionID = info["sessionId"] as? String,
                  let server = notificationServerURL(UserDefaults.standard.string(forKey: "mitzo_notification_server_url")) else {
                Self.log.error("approval_invalid_context")
                showFailure(center, deliveredID: deliveredID, info: info, code: "approval_invalid_context")
                completionHandler()
                return
            }
            let submission = NativeApprovalAction(notificationId: id, sessionId: sessionID, actionID: action,
                reviewedToolName: info["approvalToolName"] as? String, reviewedInput: info["approvalInput"] as? String,
                reviewedSessionGrantDescription: info["approvalSessionGrantDescription"] as? String)
            let attempt = Attempt(identity: submission.identity, origin: server.absoluteString, deliveredID: deliveredID, code: "approval_in_flight")
            save(attempt)
            var backgroundTask: UIBackgroundTaskIdentifier = .invalid
            let execution = BackgroundApprovalExecution { result in
                Task { @MainActor in
                    self.executions.removeValue(forKey: submission.requestId)
                    if backgroundTask != .invalid {
                        UIApplication.shared.endBackgroundTask(backgroundTask)
                        backgroundTask = .invalid
                    }
                    switch result {
                    case .success:
                        var confirmed = attempt; confirmed.code = "approval_confirmed"; self.save(confirmed)
                        center.removeDeliveredNotifications(withIdentifiers: [deliveredID, "\(deliveredID)-response-error"])
                        Self.log.info("approval_confirmed request=\(submission.requestId, privacy: .public) action=\(action, privacy: .public)")
                    case .failure(let error):
                        let code = backgroundApprovalErrorCode(error)
                        var failed = attempt; failed.code = code; self.save(failed)
                        let cause = ((error as? BackgroundApprovalFailure)?.cause ?? error) as NSError
                        Self.log.error("approval_failed request=\(submission.requestId, privacy: .public) action=\(action, privacy: .public) code=\(code, privacy: .public) domain=\(cause.domain, privacy: .public) nativeCode=\(cause.code) cause=\(cause, privacy: .private)")
                        self.showFailure(center, deliveredID: deliveredID, info: info, code: code)
                    }
                    // Notice scheduling is callback-based and cannot hold the OS completion open.
                    completionHandler()
                }
            }
            executions[submission.requestId] = execution
            backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "Mitzo notification approval") { execution.cancel() }
            let api = MitzoAPIClient(baseURL: server, authManager: AuthManager())
            execution.start { _ = try await submitBackgroundApproval(submission, using: api) }
        }
    }

    @MainActor private func attempts() -> [Attempt] {
        guard let data = UserDefaults.standard.data(forKey: Self.attemptsKey),
              let attempts = try? JSONDecoder().decode([Attempt].self, from: data) else { return [] }
        return attempts
    }
    @MainActor private func save(_ attempt: Attempt) {
        var stored = attempts().filter { $0.identity.requestId != attempt.identity.requestId }
        stored.append(attempt)
        if let data = try? JSONEncoder().encode(Array(stored.suffix(50))) {
            UserDefaults.standard.set(data, forKey: Self.attemptsKey)
        } else { Self.log.error("approval_diagnostic_persistence_failed") }
    }
    @MainActor private func showFailure(_ center: UNUserNotificationCenter, deliveredID: String, info: [AnyHashable: Any], code: String) {
        let content = UNMutableNotificationContent()
        content.title = "Approval could not be confirmed"
        content.body = "Open Mitzo to check this request before trying again. Reference: \(code)."
        content.categoryIdentifier = "NOTIFICATION_UPDATE"
        content.userInfo = ["notificationId": info["notificationId"] as? String ?? "", "sessionId": info["sessionId"] as? String ?? "", "approvalOutcome": code]
        content.sound = .default
        center.add(UNNotificationRequest(identifier: "\(deliveredID)-response-error", content: content, trigger: nil)) { error in
            if let error {
                let cause = error as NSError
                Self.log.error("approval_notice_failed code=\(code, privacy: .public) domain=\(cause.domain, privacy: .public) nativeCode=\(cause.code)")
            }
        }
    }
    func reconcileReceipts() {
        Task { @MainActor in
            guard !reconciling else { return }
            reconciling = true
            defer { reconciling = false }
            let origin = notificationServerURL(UserDefaults.standard.string(forKey: "mitzo_notification_server_url"))
            for var attempt in attempts() where attempt.code != "approval_confirmed" {
                guard executions[attempt.identity.requestId] == nil,
                      let server = notificationServerURL(attempt.origin), server == origin else { continue }
                // Fresh authentication, same origin and identity. Reconnect NEVER resubmits.
                let api = MitzoAPIClient(baseURL: server, authManager: AuthManager())
                do {
                    let receipt = try await api.approvalReceipt(attempt.identity)
                    guard attempt.identity.matches(receipt), receipt.confirmsDecision else { continue }
                    attempt.code = "approval_confirmed"; save(attempt)
                    UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: [attempt.deliveredID, "\(attempt.deliveredID)-response-error"])
                    Self.log.info("approval_reconciled request=\(attempt.identity.requestId, privacy: .public)")
                } catch {
                    Self.log.notice("approval_receipt_unconfirmed request=\(attempt.identity.requestId, privacy: .public) code=\(backgroundApprovalErrorCode(error), privacy: .public)")
                }
            }
        }
    }
}

// Kept in the App target's existing source file so archive and device builds
// compile the same scene delegate without an additional project-file entry.
class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    private var relayLifecycle = SceneForegroundReconnect()

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession,
               options connectionOptions: UIScene.ConnectionOptions) {
        // UIKit creates the window and Capacitor bridge from Main.storyboard.
        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }

    func sceneDidEnterBackground(_ scene: UIScene) {
        relayLifecycle.didEnterBackground()
        (UIApplication.shared.delegate as? AppDelegate)?.suspendWatchRelay()
    }

    func sceneWillEnterForeground(_ scene: UIScene) {
        guard relayLifecycle.consumeForegroundReconnect() else { return }
        (UIApplication.shared.delegate as? AppDelegate)?.reconnectWatchRelay()
    }
}
