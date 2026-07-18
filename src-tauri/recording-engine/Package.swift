// swift-tools-version:6.0
import Foundation
import PackageDescription

// Absolute path to the package directory, so the -sectcreate flag below
// doesn't depend on the linker's working directory.
let packageDir = URL(fileURLWithPath: #filePath).deletingLastPathComponent().path

let package = Package(
    name: "recording-engine",
    platforms: [.macOS(.v15)],
    targets: [
        .executableTarget(
            name: "recording-engine",
            linkerSettings: [
                // Embed Info.plist (own bundle id + LSBackgroundOnly) so the
                // Launch Services registration forced on this process when
                // SCStream capture starts is a background one - see the
                // comment in Info.plist.
                .unsafeFlags([
                    "-Xlinker", "-sectcreate",
                    "-Xlinker", "__TEXT",
                    "-Xlinker", "__info_plist",
                    "-Xlinker", "\(packageDir)/Info.plist",
                ])
            ]
        ),
        .testTarget(
            name: "recording-engineTests",
            dependencies: ["recording-engine"]
        ),
    ]
)
