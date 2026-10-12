// Ordinary Watch approvals open the complete authenticated review surface.

import SwiftUI
import MitzoShared

struct PermissionBanner: View {
    @EnvironmentObject var appState: AppState
    let request: PermissionRequestParams
    let onResolved: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(request.questions == nil ? "Approval required" : "Your input is needed")
                .font(.caption2)
                .foregroundStyle(.secondary)
            Text(request.title ?? request.displayName ?? request.toolName)
                .font(.caption)
                .lineLimit(2)
            NavigationLink {
                WatchNotificationDestinationView(
                    destination: .notification("permission:\(request.permId)"),
                    onResolved: onResolved
                ).environmentObject(appState)
            } label: {
                Text(request.questions == nil ? "Review request" : "Review questions")
                    .font(.caption)
                    .frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.bordered)
        }
        .padding(8)
        .background(.ultraThinMaterial)
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .padding(.horizontal, 4)
    }
}
