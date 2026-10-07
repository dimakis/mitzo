import UIKit
import UserNotifications
import Capacitor
import MitzoShared

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?
    private let watchRelay = WatchRelayCoordinator()

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        watchRelay.start()
        registerNotificationCategories()
        return true
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
            identifier: "REVIEW_PERMISSION_ACTION", title: "Review request", options: [.foreground]
        )
        let permissionCategory = UNNotificationCategory(
            identifier: "SESSION_PERMISSION", actions: [reviewAction], intentIdentifiers: [], options: []
        )
        let onceAction = UNNotificationAction(identifier: "ALLOW_ONCE_ACTION", title: "Allow once", options: [.authenticationRequired])
        let searchAction = UNNotificationAction(identifier: "ALLOW_SEARCH_SESSION_ACTION", title: "Allow searches for session", options: [.authenticationRequired])
        let denyAction = UNNotificationAction(identifier: "DENY_PERMISSION_ACTION", title: "Deny", options: [.destructive])
        let approvalCategory = UNNotificationCategory(identifier: "SESSION_APPROVAL", actions: [onceAction, denyAction, reviewAction], intentIdentifiers: [], options: [])
        let searchCategory = UNNotificationCategory(identifier: "SESSION_SEARCH_PERMISSION", actions: [onceAction, searchAction, denyAction, reviewAction], intentIdentifiers: [], options: [])
        let updateCategory = UNNotificationCategory(
            identifier: "NOTIFICATION_UPDATE", actions: [viewAction], intentIdentifiers: [], options: []
        )
        UNUserNotificationCenter.current().setNotificationCategories([sessionCategory, permissionCategory, approvalCategory, searchCategory, updateCategory])
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

/// The storyboard creates this bridge during cold launches too. Keep Capacitor's
/// router for taps/replies, but submit approval buttons natively in the background.
@objc
class MitzoBridgeViewController: CAPBridgeViewController {
    private var approvalDelegate: BackgroundApprovalDelegate?
    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        guard let router = bridge?.notificationRouter else { return }
        let delegate = BackgroundApprovalDelegate(fallback: router)
        approvalDelegate = delegate
        UNUserNotificationCenter.current().delegate = delegate
    }
}

private class BackgroundApprovalDelegate: NSObject, UNUserNotificationCenterDelegate {
    private let fallback: NotificationRouter
    init(fallback: NotificationRouter) { self.fallback = fallback }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        fallback.userNotificationCenter(center, willPresent: notification, withCompletionHandler: completionHandler)
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let action = response.actionIdentifier
        guard ["ALLOW_ONCE_ACTION", "ALLOW_SEARCH_SESSION_ACTION", "DENY_PERMISSION_ACTION"].contains(action) else {
            if response.notification.request.identifier.hasSuffix("-response-error") {
                // Our local failure alert uses the same detail navigation as a push.
                fallback.pushNotificationHandler?.didReceive(response: response)
                completionHandler()
                return
            }
            fallback.userNotificationCenter(center, didReceive: response, withCompletionHandler: completionHandler)
            return
        }
        let info = response.notification.request.content.userInfo
        let deliveredID = response.notification.request.identifier
        Task {
            do {
                guard let id = info["notificationId"] as? String,
                      let sessionID = info["sessionId"] as? String,
                      let configured = UserDefaults.standard.string(forKey: "mitzo_notification_server_url"),
                      let server = URL(string: configured) else { throw MitzoAPIClient.APIError.invalidResponse }
                // A fresh manager reads the shared Keychain and respects logout.
                let api = MitzoAPIClient(baseURL: server, authManager: AuthManager())
                let item = try await api.getNotification(id: id)
                guard item.id == id, let decision = backgroundApprovalResponse(actionID: action, item: item, expectedSessionID: sessionID) else {
                    throw MitzoAPIClient.APIError.invalidResponse
                }
                try await api.respondNotification(id: id, response: decision)
                center.removeDeliveredNotifications(withIdentifiers: [deliveredID])
            } catch {
                let content = UNMutableNotificationContent()
                content.title = "Approval could not be confirmed"
                content.body = "The request may have expired or Mitzo may be unreachable. Review its current status before trying again."
                content.categoryIdentifier = "NOTIFICATION_UPDATE"
                content.userInfo = info
                content.sound = .default
                try? await center.add(UNNotificationRequest(identifier: "\(deliveredID)-response-error", content: content, trigger: nil))
            }
            completionHandler()
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
