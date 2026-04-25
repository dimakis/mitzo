// Login view — one-time passphrase entry

import SwiftUI

struct LoginView: View {
    @EnvironmentObject var appState: AppState
    @State private var passphrase = ""
    @State private var isLoading = false

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "bubble.left.and.bubble.right")
                .font(.system(size: 36))
                .foregroundStyle(.blue)

            Text("Mitzo")
                .font(.headline)

            SecureField("Passphrase", text: $passphrase)
                .textContentType(.password)

            Button {
                isLoading = true
                Task {
                    await appState.login(passphrase: passphrase)
                    isLoading = false
                }
            } label: {
                if isLoading {
                    ProgressView()
                } else {
                    Text("Connect")
                }
            }
            .disabled(passphrase.isEmpty || isLoading)

            if let error = appState.error {
                Text(error)
                    .font(.caption2)
                    .foregroundStyle(.red)
            }
        }
        .padding()
    }
}
