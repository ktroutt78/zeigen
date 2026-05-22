// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "spike-v2-unified-capture",
    platforms: [.macOS(.v15)],
    targets: [
        .executableTarget(name: "spike"),
    ]
)
