// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "sckit-spike",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(name: "sckit-spike"),
    ]
)
