// Compose sheet — auto-focuses TextField to trigger watchOS native input
// (dictation + scribble + keyboard)

import SwiftUI

struct ComposeSheet: View {
    @Binding var draftText: String
    let canSend: Bool
    let pending: Bool
    let rejectedText: String?
    let error: String?
    let onRestore: () -> Void
    let onDiscard: () -> Void
    let onSend: () -> Void
    @FocusState private var isFocused: Bool

    var body: some View {
        ScrollView {
            VStack(spacing: 8) {
                TextField("Dictate or type", text: $draftText)
                    .font(.caption)
                    .focused($isFocused)

                if !draftText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    Button("Send") {
                        onSend()
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(!canSend)
                }
                if pending { Text("Waiting for send confirmation…").font(.caption) }
                if let error { Text(error).font(.caption) }
                if let rejectedText {
                    Text(rejectedText).font(.caption)
                    Button("Restore unsent message", action: onRestore)
                        .disabled(!draftText.isEmpty)
                    Button("Discard unsent message", action: onDiscard)
                }
            }
        }
        .onAppear {
            isFocused = true
        }
    }
}
