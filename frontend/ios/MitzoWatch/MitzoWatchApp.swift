// Mitzo Watch — Apple Watch companion app

import SwiftUI
import MitzoShared

@main
struct MitzoWatchApp: App {
    @StateObject private var appState = AppState()

    var body: some Scene {
        WindowGroup {
            if appState.isAuthenticated {
                SessionListView()
                    .environmentObject(appState)
            } else {
                LoginView()
                    .environmentObject(appState)
            }
        }
    }
}
