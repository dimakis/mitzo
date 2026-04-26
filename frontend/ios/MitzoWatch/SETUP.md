# MitzoWatch — Xcode Setup

## Add watchOS Target

1. Open `frontend/ios/App/App.xcworkspace` in Xcode
2. File → New → Target → **watchOS App**
3. Settings:
   - Product Name: `MitzoWatch`
   - Bundle ID: `com.mitzo.app.watchkitapp`
   - Team: Y4QGXHYSY3
   - Interface: SwiftUI
   - Language: Swift
   - Minimum Deployment: watchOS 10.0
   - Include Notification Scene: No
4. Delete the generated template files (ContentView.swift, Assets, etc.)
5. Drag the `MitzoWatch/` source files into the new target group

## Add MitzoShared Dependency

1. File → Add Package Dependencies → Add Local
2. Navigate to `frontend/ios/MitzoShared/`
3. Add to both `App` and `MitzoWatch` targets

## Configure Shared Keychain

1. Select `App` target → Signing & Capabilities → + Capability → Keychain Sharing
2. Add group: `com.mitzo.app`
3. Select `MitzoWatch` target → same steps
4. Both targets must use the same access group for JWT sharing

## Build & Run

1. Select `MitzoWatch` scheme
2. Choose Apple Watch simulator or device
3. Build & Run (⌘R)

## Server URL

Edit `AppState.swift` and `VoiceService.swift` to set the correct server/Yapper URLs
for your Tailscale network.
