// Mitzo Watch — Apple Watch companion app

import SwiftUI
import MitzoShared
import WatchKit
import UserNotifications

@main
struct MitzoWatchApp: App {
    @WKApplicationDelegateAdaptor(WatchNotificationDelegate.self) private var notificationDelegate
    @StateObject private var appState = AppState()

    var body: some Scene {
        WindowGroup {
            if appState.isAuthenticated {
                SessionListView()
                    .environmentObject(appState)
                    .environmentObject(notificationDelegate)
            } else {
                LoginView()
                    .environmentObject(appState)
            }
        }
    }
}

/// Foreground Review/View/Reply actions are delivered to watchOS, even when
/// the original push targeted iPhone. Retain the route through authentication.
final class WatchNotificationDelegate: NSObject, ObservableObject, WKApplicationDelegate, UNUserNotificationCenterDelegate {
    @Published var destination: WatchNotificationDestination?

    func applicationDidFinishLaunching() {
        UNUserNotificationCenter.current().delegate = self
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let info = response.notification.request.content.userInfo
        let route = WatchNotificationDestination(actionID: response.actionIdentifier,
            notificationID: info["notificationId"] as? String, sessionID: info["sessionId"] as? String,
            userText: (response as? UNTextInputNotificationResponse)?.userText)
        if let route {
            DispatchQueue.main.async { self.destination = route }
        }
        completionHandler()
    }
}
