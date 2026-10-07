import Foundation

/// Revalidate the live server request before acting on a possibly stale banner.
public func backgroundApprovalResponse(
    actionID: String, item: MitzoNotification, expectedSessionID: String,
    reviewedToolName: String? = nil, reviewedInput: String? = nil,
    at milliseconds: Double = Date().timeIntervalSince1970 * 1000
) -> NotificationResponse? {
    guard item.sessionId == expectedSessionID, item.isActionable(at: milliseconds),
          let request = item.request, item.id == "permission:\(request.permId)",
          reviewedToolName == request.toolName, reviewedInput == request.toolInput,
          request.questions == nil, request.approvalScope != .conversation,
          request.toolInput.utf8.count <= 768,
          let data = request.toolInput.data(using: .utf8),
          let input = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          (request.toolName == "Bash" && input["command"] is String) ||
          (request.toolName == "RequestWebAccess" && ["search", "fetch", "request_access"].contains(input["operation"] as? String ?? "")) else { return nil }
    let decision: NotificationResponse.Decision
    switch actionID {
    case "DENY_PERMISSION_ACTION": decision = .deny
    case "ALLOW_ONCE_ACTION":
        guard request.questions == nil, request.approvalScope != .conversation else { return nil }
        decision = .once
    case "ALLOW_SEARCH_SESSION_ACTION":
        guard request.toolName == "RequestWebAccess", request.approvalScope == .session,
              request.questions == nil, let data = request.toolInput.data(using: .utf8),
              let input = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              input["operation"] as? String == "search" else { return nil }
        decision = .session
    default: return nil
    }
    return NotificationResponse(sessionId: expectedSessionID, decision: decision)
}
