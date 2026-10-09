import Foundation

/// Foreground actions run on the device where the notification was tapped.
/// Background approval actions belong to the iPhone and must not be repeated.
public enum WatchNotificationDestination: Hashable, Sendable, Identifiable {
    case notification(String)
    case session(String)
    case reply(sessionID: String, text: String)

    public var id: Self { self }

    public init?(actionID: String, notificationID: String?, sessionID: String?, userText: String? = nil) {
        if actionID == "REPLY_ACTION" {
            guard let sessionID, !sessionID.isEmpty else { return nil }
            if let userText, !userText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                self = .reply(sessionID: sessionID, text: userText)
            } else { self = .session(sessionID) }
            return
        }
        guard ["REVIEW_PERMISSION_ACTION", "VIEW_ACTION", "com.apple.UNNotificationDefaultActionIdentifier"].contains(actionID) else { return nil }
        if let notificationID, !notificationID.isEmpty { self = .notification(notificationID) }
        else if let sessionID, !sessionID.isEmpty { self = .session(sessionID) }
        else { return nil }
    }
}

/// The authenticated web app configures this origin. Never guess a server on a
/// background launch, which could otherwise send approvals to another instance.
public func notificationServerURL(_ origin: String?) -> URL? {
    guard let origin, let url = URL(string: origin),
          ["http", "https"].contains(url.scheme ?? ""), url.host != nil,
          url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
          url.path.isEmpty || url.path == "/" else { return nil }
    return url
}

/// A detail screen may stay open after another client resolves or replaces a
/// request. Only the same live request that was reviewed can be answered.
public func watchNotificationResponse(
    reviewed: MitzoNotification, current: MitzoNotification, decision: NotificationResponse.Decision,
    at milliseconds: Double = Date().timeIntervalSince1970 * 1000
) -> NotificationResponse? {
    guard reviewed.id == current.id, reviewed.sessionId == current.sessionId,
          current.isActionable(at: milliseconds), let sessionID = current.sessionId,
          let request = current.request, reviewed.request == request,
          current.id == "permission:\(request.permId)" else { return nil }
    switch decision {
    case .once:
        guard current.kind == "approval", request.questions == nil,
              request.approvalScope != .conversation else { return nil }
    case .session: return nil // Broad grants require the explicit iPhone flow.
    case .deny: break
    }
    return NotificationResponse(sessionId: sessionID, decision: decision)
}
