// Compose sheet — auto-focuses TextField to trigger watchOS native input
// (dictation + scribble + keyboard)

import SwiftUI

struct ComposeSheet: View {
    @Binding var draftText: String
    let onSend: (String) -> Void
    @FocusState private var isFocused: Bool

    var body: some View {
        VStack(spacing: 8) {
            TextField("Dictate or type", text: $draftText)
                .font(.caption)
                .focused($isFocused)

            if !draftText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Button("Send") {
                    let text = draftText.trimmingCharacters(in: .whitespacesAndNewlines)
                    draftText = ""
                    onSend(text)
                }
                .buttonStyle(.borderedProminent)
            }
        }
        .onAppear {
            isFocused = true
        }
    }
}
