// Permission approval banner

import SwiftUI
import MitzoShared

struct PermissionBanner: View {
    let request: PermissionRequest
    let onAllow: () -> Void
    let onDeny: () -> Void

    var body: some View {
        VStack(spacing: 6) {
            HStack(spacing: 4) {
                Image(systemName: tierIcon)
                    .foregroundStyle(tierColor)
                    .font(.caption2)
                Text(request.displayName ?? request.toolName)
                    .font(.caption2)
                    .bold()
                    .lineLimit(1)
            }

            if let desc = request.description {
                Text(desc)
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }

            HStack(spacing: 12) {
                Button(role: .destructive, action: onDeny) {
                    Text("Deny")
                        .font(.caption2)
                }

                Button(action: onAllow) {
                    Text("Allow")
                        .font(.caption2)
                }
                .buttonStyle(.borderedProminent)
                .tint(.blue)
            }
        }
        .padding(8)
        .background(.ultraThinMaterial)
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .padding(.horizontal, 4)
    }

    private var tierIcon: String {
        switch request.tier {
        case .safe: return "checkmark.shield"
        case .standard: return "shield"
        case .elevated: return "exclamationmark.shield"
        case .unknown, .none: return "questionmark.shield"
        }
    }

    private var tierColor: Color {
        switch request.tier {
        case .safe: return .green
        case .standard: return .blue
        case .elevated: return .orange
        case .unknown, .none: return .gray
        }
    }
}
