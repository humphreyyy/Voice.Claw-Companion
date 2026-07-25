// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "VoiceClawBridge",
    platforms: [
        .macOS(.v13),
    ],
    products: [
        .executable(name: "VoiceClawBridge", targets: ["VoiceClawBridge"]),
    ],
    dependencies: [
        .package(url: "https://github.com/sparkle-project/Sparkle", from: "2.6.0"),
    ],
    targets: [
        .executableTarget(
            name: "VoiceClawBridge",
            dependencies: [
                .product(name: "Sparkle", package: "Sparkle"),
            ]),
        .testTarget(
            name: "VoiceClawBridgeTests",
            dependencies: ["VoiceClawBridge"]),
    ]
)
