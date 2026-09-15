import Foundation

/// Runs Marmot's Node engine. Everything the app knows comes from here, so no
/// rule, price or threshold is implemented twice.
final class Engine: @unchecked Sendable {
    static let shared = Engine()

    struct Output {
        let code: Int32
        let stdout: Data
        let stderr: String
    }

    enum Failure: LocalizedError {
        case nodeNotFound
        case engineNotFound
        case timedOut([String])
        case failed(String)
        case badOutput(String)

        var errorDescription: String? {
            switch self {
            case .nodeNotFound: return "Node.js not found. Install it with `brew install node`, then Refresh."
            case .engineNotFound: return "Marmot's engine is missing from the app. Reinstall Marmot."
            case .timedOut(let args): return "`marmot \(args.first ?? "")` took too long and was stopped."
            case .failed(let message): return message
            case .badOutput(let message): return "Could not read Marmot's output: \(message)"
            }
        }
    }

    private let lock = NSLock()
    private var resolved = false
    private var _path = ""
    private var _node: String?
    private var _engine: String?

    var shellPath: String { resolve(); return _path }
    var nodePath: String? { resolve(); return _node }
    var enginePath: String? { resolve(); return _engine }

    private func resolve() {
        lock.lock()
        defer { lock.unlock() }
        guard !resolved else { return }
        resolved = true
        _path = Self.loginShellPath()
        _node = Self.findNode(path: _path)
        _engine = Self.findEngine()
    }

    // MARK: running

    func run(_ args: [String], timeout: TimeInterval = 30) async throws -> Output {
        try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global(qos: .utility).async {
                do {
                    continuation.resume(returning: try self.runSync(args, timeout: timeout))
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    /// Runs a command and decodes the JSON object it prints.
    func json<T: Decodable>(_ type: T.Type, _ args: [String], timeout: TimeInterval = 30) async throws -> (T, Data) {
        let out = try await run(args, timeout: timeout)
        let data = Self.jsonSlice(out.stdout)
        guard !data.isEmpty else {
            let why = out.stderr.split(separator: "\n").last.map(String.init) ?? "no output (exit \(out.code))"
            throw Failure.failed(why)
        }
        do {
            return (try JSONDecoder().decode(T.self, from: data), data)
        } catch {
            throw Failure.badOutput(error.localizedDescription)
        }
    }

    private func runSync(_ args: [String], timeout: TimeInterval) throws -> Output {
        guard let node = nodePath else { throw Failure.nodeNotFound }
        guard let engine = enginePath else { throw Failure.engineNotFound }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: node)
        process.arguments = [engine] + args
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = shellPath
        env["NO_COLOR"] = "1"
        process.environment = env
        process.currentDirectoryURL = FileManager.default.homeDirectoryForCurrentUser
        process.standardInput = FileHandle.nullDevice

        let outPipe = Pipe()
        let errPipe = Pipe()
        process.standardOutput = outPipe
        process.standardError = errPipe

        final class Box: @unchecked Sendable { var out = Data(); var err = Data() }
        let box = Box()
        let readers = DispatchGroup()
        readers.enter()
        DispatchQueue.global().async {
            box.out = outPipe.fileHandleForReading.readDataToEndOfFile()
            readers.leave()
        }
        readers.enter()
        DispatchQueue.global().async {
            box.err = errPipe.fileHandleForReading.readDataToEndOfFile()
            readers.leave()
        }

        let exited = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in exited.signal() }
        do {
            try process.run()
        } catch {
            throw Failure.failed("Could not start node: \(error.localizedDescription)")
        }
        if exited.wait(timeout: .now() + timeout) == .timedOut {
            process.terminate()
            throw Failure.timedOut(args)
        }
        // A grandchild that kept the pipe open must not hang us forever.
        _ = readers.wait(timeout: .now() + 3)
        return Output(code: process.terminationStatus, stdout: box.out, stderr: String(decoding: box.err, as: UTF8.self))
    }

    /// Anything printed before the JSON (a progress line) is skipped.
    private static func jsonSlice(_ data: Data) -> Data {
        guard let start = data.firstIndex(of: UInt8(ascii: "{")) else { return Data() }
        return data[start...]
    }

    // MARK: discovery

    /// GUI apps do not inherit the shell's PATH, and node often lives in ~/.nvm.
    private static func loginShellPath() -> String {
        let home = NSHomeDirectory()
        let fallback = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:\(home)/.local/bin"
        let marker = "__MARMOT_PATH__"
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/zsh")
        process.arguments = ["-ilc", "printf '\(marker)%s' \"$PATH\""]
        process.standardInput = FileHandle.nullDevice
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice

        final class Box: @unchecked Sendable { var data = Data() }
        let box = Box()
        let done = DispatchGroup()
        done.enter()
        DispatchQueue.global().async {
            box.data = pipe.fileHandleForReading.readDataToEndOfFile()
            done.leave()
        }
        do { try process.run() } catch { return fallback }
        if done.wait(timeout: .now() + 5) == .timedOut {
            process.terminate()
            return fallback
        }
        let text = String(decoding: box.data, as: UTF8.self)
        guard let range = text.range(of: marker, options: .backwards) else { return fallback }
        let path = text[range.upperBound...].trimmingCharacters(in: .whitespacesAndNewlines)
        return path.isEmpty ? fallback : "\(path):\(fallback)"
    }

    private static func findNode(path: String) -> String? {
        let fm = FileManager.default
        if let env = ProcessInfo.processInfo.environment["MARMOT_NODE"], fm.isExecutableFile(atPath: env) { return env }
        // The Node that ships inside the app, so a clean Mac needs nothing else.
        if let bundled = Bundle.main.resourceURL?.appendingPathComponent("node/bin/node").path,
           fm.isExecutableFile(atPath: bundled) { return bundled }
        for dir in path.split(separator: ":") {
            let candidate = "\(dir)/node"
            if fm.isExecutableFile(atPath: candidate) { return candidate }
        }
        for candidate in ["/opt/homebrew/bin/node", "/usr/local/bin/node"] where fm.isExecutableFile(atPath: candidate) {
            return candidate
        }
        let nvm = "\(NSHomeDirectory())/.nvm/versions/node"
        let versions = (try? fm.contentsOfDirectory(atPath: nvm)) ?? []
        let newest = versions.sorted { $0.compare($1, options: .numeric) == .orderedDescending }
        for v in newest {
            let candidate = "\(nvm)/\(v)/bin/node"
            if fm.isExecutableFile(atPath: candidate) { return candidate }
        }
        return nil
    }

    private static func findEngine() -> String? {
        let fm = FileManager.default
        if let env = ProcessInfo.processInfo.environment["MARMOT_ENGINE"], fm.fileExists(atPath: env) { return env }
        if let bundled = Bundle.main.resourceURL?.appendingPathComponent("engine/bin/marmot.mjs").path,
           fm.fileExists(atPath: bundled) { return bundled }
        // Development: the binary sits somewhere under marmot/macos/.build.
        var dir = Bundle.main.executableURL?.deletingLastPathComponent()
        while let current = dir, current.path != "/" {
            let script = current.appendingPathComponent("bin/marmot.mjs").path
            if fm.fileExists(atPath: script), fm.fileExists(atPath: current.appendingPathComponent("macos").path) {
                return script
            }
            dir = current.deletingLastPathComponent()
        }
        return nil
    }
}
