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
    targets: [
        .executableTarget(name: "VoiceClawBridge"),
    ]
)
