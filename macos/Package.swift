// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "Marmot",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(name: "Marmot", path: "Sources/Marmot"),
    ]
)
