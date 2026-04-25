// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "recording-engine",
    platforms: [.macOS(.v15)],
    targets: [
        .executableTarget(name: "recording-engine"),
    ]
)
