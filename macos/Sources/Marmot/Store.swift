import AppKit
import Foundation
import SwiftUI

@MainActor
final class Store: ObservableObject {
    static let shared = Store()

    @Published var status: Status?
    @Published var config: [String: Any] = [:]
    @Published var lastError: String?
    @Published var loading = false
    @Published var refreshingLimits = false
    @Published var lastRefreshNote: String?
    /// The expanded usage window's payloads, one per range in days.
    @Published var usage: [Int: Status] = [:]
    @Published var usageLoading: Set<Int> = []
    /// The menu's "Install hooks" card: in progress, and what happened.
    @Published var installingHooks = false
    @Published var hooksNote: String?

    private let engine = Engine.shared
    private var timer: Timer?
    private var lastLimitAttempt: Date?
    private var pendingWrites: [String: DispatchWorkItem] = [:]
    private var pendingValues: [String: Any] = [:]

    init() {
        UserDefaults.standard.register(defaults: [
            "menuBarDisplay": "percent",
            "limitsRefreshMins": 15,
            "windowDays": 30,
        ])
    }

    var windowDays: Int { max(1, UserDefaults.standard.integer(forKey: "windowDays")) }

    /// Synthetic sessions instead of this machine's own, for screenshots and
    /// demos. `MARMOT_DEMO=1` turns it on for one launch; the Advanced setting
    /// keeps it on. Every engine call carries it, so nothing real can leak into
    /// a picture — the menu says "demo" while it is on.
    var demoMode: Bool {
        if ProcessInfo.processInfo.environment["MARMOT_DEMO"] == "1" { return true }
        return UserDefaults.standard.bool(forKey: "demoMode")
    }

    private func args(_ base: [String]) -> [String] { demoMode ? base + ["--demo"] : base }

    /// Called when the setting is flipped: drop what was read under the old mode.
    func reloadEverything() {
        usage.removeAll()
        Task {
            await loadStatus()
        }
    }

    func start() {
        guard timer == nil else { return }
        Task {
            // Tick first: its heartbeat is what tells the engine's alert() the
            // app is here to post notifications, instead of opening a dialog.
            await tick()
            await loadStatus()
            await maybeRefreshLimits()
        }
        timer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { _ in
            Task { @MainActor in await Store.shared.cycle() }
        }
    }

    func cycle() async {
        await tick()
        await loadStatus()
        await maybeRefreshLimits()
    }

    // MARK: engine calls

    func loadStatus() async {
        loading = true
        defer { loading = false }
        do {
            let (status, data) = try await engine.json(Status.self, args(["status", "--json", "--days", String(windowDays)]), timeout: 60)
            self.status = status
            if let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               var cfg = root["config"] as? [String: Any] {
                // Writes still in flight win over what the engine read a moment ago.
                for (key, value) in pendingValues {
                    cfg = ConfigPath.setting(cfg, key.split(separator: ".").map(String.init), value)
                }
                config = cfg
            }
            lastError = nil
        } catch {
            lastError = error.localizedDescription
        }
    }

    func loadUsage(days: Int) async {
        guard !usageLoading.contains(days) else { return }
        usageLoading.insert(days)
        defer { usageLoading.remove(days) }
        do {
            let (status, _) = try await engine.json(Status.self, args(["status", "--json", "--days", String(days)]), timeout: 90)
            usage[days] = status
        } catch {
            lastError = error.localizedDescription
        }
    }

    /// Sends a real test through the engine, the same `alert()` a nudge takes,
    /// then ticks at once so the app shows it now rather than within a minute.
    func sendEngineTest(digest: Bool) async {
        await tick()
        _ = await runText(["test-notification"] + (digest ? ["--digest"] : []))
        await tick()
    }

    /// Back to the plan's marks for one window.
    func resetWindow(key: String, windowArg: String) async {
        let path = "limits.byWindow.\(key)"
        pendingWrites[path]?.cancel()
        pendingWrites[path] = nil
        pendingValues[path] = nil
        config = ConfigPath.removing(config, path.split(separator: ".").map(String.init))
        _ = await runText(["remind", "--window", windowArg, "--reset"])
        await loadStatus()
    }

    func tick() async {
        do {
            let (result, _) = try await engine.json(TickResult.self, args(["tick", "--json", "--app"]), timeout: 60)
            for n in result.notifications ?? [] {
                Notifier.shared.deliver(n, config: config)
            }
        } catch {
            // A failed tick costs one minute of notifications; the status call surfaces errors.
        }
    }

    func maybeRefreshLimits(force: Bool = false) async {
        guard !refreshingLimits else { return }
        let every = UserDefaults.standard.integer(forKey: "limitsRefreshMins")
        if !force {
            guard every > 0 else { return }
            if (ConfigPath.value(config, "limits.autoRefresh") as? Bool) == false { return }
            if let age = status?.plan?.ageMins, age <= Double(every) { return }
            if let last = lastLimitAttempt, Date().timeIntervalSince(last) < Double(every) * 60 { return }
        }
        lastLimitAttempt = Date()
        refreshingLimits = true
        defer { refreshingLimits = false }
        do {
            let (result, _) = try await engine.json(RefreshResult.self, ["refresh-limits", "--json"], timeout: 120)
            lastRefreshNote = result.refreshed == true ? nil : (result.reason ?? "Claude Code did not return new limits.")
        } catch {
            lastRefreshNote = error.localizedDescription
        }
        await loadStatus()
    }

    func refreshNow() {
        Task {
            await loadStatus()
            await maybeRefreshLimits(force: true)
        }
    }

    func openBrowser() {
        Task {
            do {
                let out = try await engine.run(args(["browse"]), timeout: 180)
                if out.code != 0 { lastError = out.stderr.split(separator: "\n").last.map(String.init) ?? "Could not build the session page." }
            } catch {
                lastError = error.localizedDescription
            }
        }
    }

    /// The same command as Settings → Advanced → Install hooks, from the menu's
    /// setup card. Homebrew cannot do this: it would mean editing Claude Code's
    /// settings behind the user's back, so the app asks once instead.
    func installHooks() {
        guard !installingHooks else { return }
        installingHooks = true
        hooksNote = nil
        Task {
            defer { installingHooks = false }
            do {
                let out = try await engine.run(["init", "--hooks", "--force"], timeout: 30)
                hooksNote = out.code == 0
                    ? "Installed. Restart Claude Code to start long-session nudges and the daily digest."
                    : (out.stderr.split(separator: "\n").last.map(String.init) ?? "Could not install the hooks.")
            } catch {
                hooksNote = error.localizedDescription
            }
            await loadStatus()
        }
    }

    func runText(_ args: [String], timeout: TimeInterval = 60) async -> String {
        do {
            let out = try await engine.run(args, timeout: timeout)
            let text = String(decoding: out.stdout, as: UTF8.self) + (out.stderr.isEmpty ? "" : "\n\(out.stderr)")
            return text.trimmingCharacters(in: .whitespacesAndNewlines)
        } catch {
            return error.localizedDescription
        }
    }

    func openConfigFile() {
        Task {
            _ = await runText(["config", "--no-open"])
            let path = status?.paths?.config ?? "\(NSHomeDirectory())/.claude/marmot.json"
            NSWorkspace.shared.open(URL(fileURLWithPath: path))
        }
    }

    // MARK: config

    func value(_ path: String) -> Any? { ConfigPath.value(config, path) }

    /// Updates the UI now, writes through `marmot config set` shortly after.
    func set(_ path: String, _ value: Any, debounce: Bool = true, delay: Double = 0.6) {
        config = ConfigPath.setting(config, path.split(separator: ".").map(String.init), value)
        pendingValues[path] = value
        pendingWrites[path]?.cancel()
        let work = DispatchWorkItem { [weak self] in
            Task { @MainActor in await self?.flush(path) }
        }
        pendingWrites[path] = work
        DispatchQueue.main.asyncAfter(deadline: .now() + (debounce ? delay : 0), execute: work)
    }

    private func flush(_ path: String) async {
        guard let value = pendingValues[path] else { return }
        pendingWrites[path] = nil
        let out = try? await engine.run(["config", "set", "\(path)=\(ConfigPath.encode(value))"], timeout: 20)
        pendingValues[path] = nil
        if let out, out.code != 0 {
            lastError = out.stderr.split(separator: "\n").last.map(String.init) ?? "Could not save \(path)."
        }
        await loadStatus()
    }

    // Typed bindings for Settings.

    func bool(_ path: String, _ fallback: Bool) -> Binding<Bool> {
        Binding(get: { (self.value(path) as? Bool) ?? fallback }, set: { self.set(path, $0, debounce: false) })
    }

    func double(_ path: String, _ fallback: Double) -> Binding<Double> {
        Binding(get: { (self.value(path) as? NSNumber)?.doubleValue ?? fallback }, set: { self.set(path, $0) })
    }

    func int(_ path: String, _ fallback: Int) -> Binding<Int> {
        Binding(get: { (self.value(path) as? NSNumber)?.intValue ?? fallback }, set: { self.set(path, $0) })
    }

    func string(_ path: String, _ fallback: String) -> Binding<String> {
        Binding(get: { (self.value(path) as? String) ?? fallback }, set: { self.set(path, $0, debounce: false) })
    }

    /// `notify.style` may be one string for both kinds; writing one kind keeps the other.
    func style(_ kind: String) -> Binding<String> {
        Binding(
            get: {
                let raw = self.value("notify.style")
                if let s = raw as? String { return s }
                return ((raw as? [String: Any])?[kind] as? String) ?? "alert"
            },
            set: { newValue in
                let raw = self.value("notify.style")
                var both: [String: Any] = ["nudge": "alert", "digest": "alert"]
                if let s = raw as? String { both = ["nudge": s, "digest": s] }
                if let d = raw as? [String: Any] { both.merge(d) { _, new in new } }
                both[kind] = newValue
                self.set("notify.style", both, debounce: false)
            }
        )
    }

    func liveRule(_ id: String) -> Binding<Bool> {
        Binding(
            get: { ((self.value("live") as? [String]) ?? []).contains(id) },
            set: { on in
                var live = (self.value("live") as? [String]) ?? []
                live.removeAll { $0 == id }
                if on { live.append(id) }
                self.set("live", live, debounce: false)
            }
        )
    }
}
