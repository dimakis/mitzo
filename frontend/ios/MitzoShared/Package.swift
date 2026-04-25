// swift-tools-version: 6.3
// The swift-tools-version declares the minimum version of Swift required to build this package.

import PackageDescription

let package = Package(
    name: "MitzoShared",
    platforms: [
        .iOS(.v15),
        .watchOS(.v10),
        .macOS(.v12)
    ],
    products: [
        .library(
            name: "MitzoShared",
            targets: ["MitzoShared"]
        ),
    ],
    targets: [
        .target(
            name: "MitzoShared"
        ),
        .testTarget(
            name: "MitzoSharedTests",
            dependencies: ["MitzoShared"]
        ),
    ],
    swiftLanguageModes: [.v6]
)
