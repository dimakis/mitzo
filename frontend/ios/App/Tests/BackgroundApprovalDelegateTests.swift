// Offline doubles for the delegate's external boundaries, not its implementation.
import Foundation
import MitzoShared

private final class Events: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String] = []
    func record(_ value: String) { lock.withLock { values.append(value) } }
    func count(_ value: String) -> Int { lock.withLock { values.filter { $0 == value }.count } }
}
private let events = Events()
private func uiEvent(_ name: String) {
    events.record(name)
    if !Thread.isMainThread { events.record("off-main-bridge") }
}
private func require(_ condition: @autoclosure () -> Bool, _ message: String) {
    if !condition() { print("FAIL: \(message)"); exit(1) }
}
private func waitFor(_ name: String, count: Int = 1) {
    let deadline = Date().addingTimeInterval(3)
    while events.count(name) < count && Date() < deadline {
        RunLoop.current.run(until: Date().addingTimeInterval(0.01))
    }
    require(events.count(name) == count, "\(name) must complete exactly \(count) time(s)")
}

private protocol UNUserNotificationCenterDelegate {}
private struct UNNotificationPresentationOptions: OptionSet {
    let rawValue: Int
    static let banner = Self(rawValue: 1), list = Self(rawValue: 2)
    static let sound = Self(rawValue: 4), badge = Self(rawValue: 8)
}
private struct NotificationSound { static let `default` = Self() }
private final class UNMutableNotificationContent {
    var title = "", body = "", categoryIdentifier = ""
    var userInfo: [AnyHashable: Any] = [:]
    var sound: NotificationSound?
}
private struct UNNotificationRequest {
    let identifier: String
    let content: UNMutableNotificationContent
    let trigger: String?
}
private struct UNNotification { let request: UNNotificationRequest }
private struct UNNotificationResponse {
    let actionIdentifier: String
    let notification: UNNotification
}
private final class UNUserNotificationCenter {
    static let shared = UNUserNotificationCenter()
    static func current() -> UNUserNotificationCenter { shared }
    func removeDeliveredNotifications(withIdentifiers ids: [String]) {
        for id in ids { events.record("removed:\(id)") }
    }
    func add(_ request: UNNotificationRequest) async throws {
        events.record("error:\(request.identifier)")
    }
}
private class NotificationRouter {
    var pushNotificationHandler: NotificationRouter? { self }
    func didReceive(response: UNNotificationResponse) { uiEvent("error-route") }
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completion: @escaping (UNNotificationPresentationOptions) -> Void) {
        uiEvent("present")
        completion([.banner])
    }
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completion: @escaping () -> Void) {
        uiEvent("route:\(response.actionIdentifier)")
        completion()
    }
}

// Auth and HTTP are replaced so this executable cannot read a real credential
// or send an approval. Live-request revalidation still uses MitzoShared.
private struct AuthManager {}
private func toolInput(_ id: String) -> String {
    id.hasSuffix("website")
        ? "{\"operation\":\"request_access\",\"url\":\"https://fixture.invalid/pricing\"}"
        : "{\"operation\":\"search\"}"
}
private actor MitzoAPIClient {
    enum APIError: Error { case invalidResponse }
    init(baseURL: URL, authManager: AuthManager) {}
    func getNotification(id: String) async throws -> MitzoNotification {
        events.record("get:\(id)")
        if id == "permission:unreachable" { throw APIError.invalidResponse }
        let object: [String: Any] = [
            "id": id, "kind": "approval", "title": "Website", "body": "Review",
            "sessionId": "s1", "createdAt": 1,
            "resolvedAt": id == "permission:resolved" ? 2 : NSNull(),
            "expiresAt": id == "permission:expired" ? 1 : NSNull(),
            "request": ["permId": String(id.dropFirst("permission:".count)),
                        "toolName": "RequestWebAccess", "toolInput": toolInput(id),
                        "approvalScope": "session"],
        ]
        return try JSONDecoder().decode(MitzoNotification.self, from: JSONSerialization.data(withJSONObject: object))
    }
    func respondNotification(id: String, response: NotificationResponse) async throws {
        events.record("respond:\(id):\(response.decision.rawValue)")
    }
}

// DELEGATE_IMPLEMENTATION

private let center = UNUserNotificationCenter.current()
private func response(_ action: String, id: String = "permission:p1", session: String = "s1") -> UNNotificationResponse {
    let content = UNMutableNotificationContent()
    content.userInfo = ["notificationId": id, "sessionId": session,
                        "approvalToolName": "RequestWebAccess", "approvalInput": toolInput(id)]
    if id == "permission:missing-id" { content.userInfo.removeValue(forKey: "notificationId") }
    return UNNotificationResponse(actionIdentifier: action, notification: UNNotification(request:
        UNNotificationRequest(identifier: id, content: content, trigger: nil)))
}
private let delegate = BackgroundApprovalDelegate()
private let router = NotificationRouter()

// A background cold launch must acknowledge and retain navigation until the
// bridge attaches, without delivering that old completion a second time.
DispatchQueue.global().async {
    delegate.userNotificationCenter(center, didReceive: response("REVIEW_PERMISSION_ACTION")) {
        events.record("cold-complete")
    }
}
waitFor("cold-complete")
require(events.count("route:REVIEW_PERMISSION_ACTION") == 0, "cold navigation must wait for the bridge")
delegate.attach(router)
waitFor("route:REVIEW_PERMISSION_ACTION")
delegate.attach(router)
require(events.count("cold-complete") == 1, "reattaching must not repeat system completion")
require(events.count("route:REVIEW_PERMISSION_ACTION") == 1, "reattaching must not replay consumed navigation")

for action in ["REVIEW_PERMISSION_ACTION", "VIEW_ACTION", "com.apple.UNNotificationDefaultActionIdentifier"] {
    DispatchQueue.global().async {
        delegate.userNotificationCenter(center, didReceive: response(action)) {
            events.record("complete:\(action)")
        }
    }
    waitFor("complete:\(action)")
}
DispatchQueue.global().async {
    delegate.userNotificationCenter(center, willPresent: response("VIEW_ACTION").notification) { options in
        require(options == [.banner], "router presentation options must be preserved")
        events.record("present-complete")
    }
}
waitFor("present-complete")
DispatchQueue.global().async {
    delegate.userNotificationCenter(center, didReceive: response("VIEW_ACTION", id: "permission:p1-response-error")) {
        events.record("error-route-complete")
    }
}
waitFor("error-route-complete")
require(events.count("error-route") == 1, "local failure notifications must route through the push bridge")
require(events.count("off-main-bridge") == 0, "notification callbacks must reach Capacitor on the main thread")

// All approval choices work on a cold background launch without a scene/bridge.
private let coldDelegate = BackgroundApprovalDelegate()
DispatchQueue.global().async {
    coldDelegate.userNotificationCenter(center, willPresent: response("VIEW_ACTION").notification) { options in
        require(options == [.banner, .list, .sound, .badge], "a cold launch must preserve default presentation")
        events.record("cold-present-complete")
    }
}
waitFor("cold-present-complete")
for (index, pair) in [("ALLOW_ONCE_ACTION", "once"), ("ALLOW_SESSION_ACTION", "always"),
                       ("ALLOW_SEARCH_SESSION_ACTION", "always"), ("DENY_PERMISSION_ACTION", "deny"),
                       ("ALLOW_ONCE_ACTION", "once"), ("ALLOW_SESSION_ACTION", "always"),
                       ("DENY_PERMISSION_ACTION", "deny")].enumerated() {
    let (action, decision) = pair
    let id = "permission:action\(index)" + (index >= 4 ? "-website" : "")
    DispatchQueue.global().async {
        coldDelegate.userNotificationCenter(center, didReceive: response(action, id: id)) {
            uiEvent("complete:\(id)")
        }
    }
    waitFor("complete:\(id)")
    require(events.count("respond:\(id):\(decision)") == 1, "\(action) must submit exactly one validated response")
    require(events.count("removed:\(id)") == 1, "success must remove the delivered notification")
}
for id in ["permission:resolved", "permission:expired", "permission:unreachable",
           "permission:wrong-session", "permission:missing-id"] {
    DispatchQueue.global().async {
        coldDelegate.userNotificationCenter(center, didReceive: response("ALLOW_ONCE_ACTION", id: id,
            session: id.hasSuffix("wrong-session") ? "other" : "s1")) {
            uiEvent("complete:\(id)")
        }
    }
    waitFor("complete:\(id)")
    require(events.count("respond:\(id):once") == 0, "failed revalidation must never approve")
    require(events.count("removed:\(id)") == 0, "failure must retain the original request")
    require(events.count("error:\(id)-response-error") == 1, "failure must offer review and still complete")
}
require(events.count("off-main-bridge") == 0, "approval completions must return on the main thread")
print("Notification delegate: background callbacks, cold navigation, all approval choices and failure completion passed")
