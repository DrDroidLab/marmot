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

    func start() {
        guard timer == nil else { return }
        Task {
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
            let (status, data) = try await engine.json(Status.self, ["status", "--json", "--days", String(windowDays)], timeout: 60)
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

    func tick() async {
        do {
            let (result, _) = try await engine.json(TickResult.self, ["tick", "--json", "--app"], timeout: 60)
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
                let out = try await engine.run(["browse"], timeout: 180)
                if out.code != 0 { lastError = out.stderr.split(separator: "\n").last.map(String.init) ?? "Could not build the session page." }
            } catch {
                lastError = error.localizedDescription
            }
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
    func set(_ path: String, _ value: Any, debounce: Bool = true) {
        config = ConfigPath.setting(config, path.split(separator: ".").map(String.init), value)
        pendingValues[path] = value
        pendingWrites[path]?.cancel()
        let work = DispatchWorkItem { [weak self] in
            Task { @MainActor in await self?.flush(path) }
        }
        pendingWrites[path] = work
        DispatchQueue.main.asyncAfter(deadline: .now() + (debounce ? 0.6 : 0), execute: work)
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
