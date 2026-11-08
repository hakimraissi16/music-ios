// swift-tools-version: 5.9
import PackageDescription

// Package name MUST be "NativePlayer": Capacitor derives it from the npm name "native-player".
let package = Package(
    name: "NativePlayer",
    platforms: [.iOS(.v15)],
    products: [
        .library(name: "NativePlayer", targets: ["NativePlayerPlugin"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0")
    ],
    targets: [
        .target(
            name: "NativePlayerPlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm")
            ],
            path: "ios/Sources/NativePlayerPlugin")
    ]
)
