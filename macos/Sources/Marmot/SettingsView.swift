import ServiceManagement
import SwiftUI

struct SettingsView: View {
    @EnvironmentObject var store: Store

    var body: some View {
        TabView {
            GeneralPane().tabItem { Label("General", systemImage: "gearshape") }
            NotificationsPane().tabItem { Label("Notifications", systemImage: "bell.badge") }
            LimitsPane().tabItem { Label("Limits & budgets", systemImage: "gauge.with.dots.needle.67percent") }
            AdvancedPane().tabItem { Label("Advanced", systemImage: "wrench.and.screwdriver") }
        }
        .environmentObject(store)
        .frame(width: 520, height: 460)
        .onAppear { Task { await store.loadStatus() } }
    }
}

// MARK: - General

private struct GeneralPane: View {
    @EnvironmentObject var store: Store
    @AppStorage("menuBarDisplay") private var display = "percent"
    @AppStorage("menuBarLimit") private var whichLimit = "both"
    @AppStorage("limitsRefreshMins") private var refreshMins = 15
    @AppStorage("windowDays") private var windowDays = 30
    @State private var launchAtLogin = SMAppService.mainApp.status == .enabled
    @State private var loginError: String?

    var body: some View {
        Form {
            Section {
                Toggle("Launch at login", isOn: $launchAtLogin)
                    .onChange(of: launchAtLogin) { _, on in
                        do {
                            if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
                            loginError = nil
                        } catch {
                            loginError = error.localizedDescription
                            launchAtLogin = SMAppService.mainApp.status == .enabled
                        }
                    }
                if let loginError {
                    Text(loginError).font(.caption).foregroundStyle(.orange)
                }
                Picker("Menu bar shows", selection: $display) {
                    Text("Limit %").tag("percent")
                    Text("Today's cost").tag("cost")
                    Text("Limit % and cost").tag("both")
                    Text("Icon only").tag("icon")
                }
                Picker("Which limit", selection: $whichLimit) {
                    Text("5-hour session and weekly").tag("both")
                    Text("5-hour session").tag("session")
                    Text("Weekly").tag("weekly")
                    Text("Whichever is highest").tag("highest")
                }
                .disabled(display == "cost" || display == "icon")
            }
            Section {
                Toggle("Keep plan limits fresh", isOn: store.bool("limits.autoRefresh", true))
                Picker("Refresh limits every", selection: $refreshMins) {
                    Text("5 minutes").tag(5)
                    Text("15 minutes").tag(15)
                    Text("30 minutes").tag(30)
                    Text("Manually").tag(0)
                }
                .disabled((store.value("limits.autoRefresh") as? Bool) == false)
                Text("Runs `claude -p /usage`, which costs no tokens and creates no session.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Section {
                Picker("Totals window", selection: $windowDays) {
                    Text("7 days").tag(7)
                    Text("30 days").tag(30)
                }
                .onChange(of: windowDays) { _, _ in Task { await store.loadStatus() } }
            }
        }
        .formStyle(.grouped)
    }
}

// MARK: - Notifications

private struct NotificationsPane: View {
    @EnvironmentObject var store: Store

    private let sounds = ["Ping", "Glass", "Hero", "Pop", "Submarine", "Funk", "Purr"]
    private let rules: [(String, String)] = [
        ("limit-reached", "Limit marks"),
        ("limit-pace", "Limit pace"),
        ("session-cost", "Session cost cap"),
        ("daily-cost", "Daily cost cap"),
        ("daily-baseline", "Unusual day"),
        ("session-topics", "Session resumed across days"),
    ]

    var body: some View {
        Form {
            Section {
                Toggle("Desktop notifications", isOn: store.bool("notify.desktop", true))
                Toggle("Play a sound", isOn: store.bool("notify.bell", true))
                Picker("Sound", selection: store.string("notify.sound", "Ping")) {
                    ForEach(sounds, id: \.self) { Text($0).tag($0) }
                }
                .disabled((store.value("notify.bell") as? Bool) == false)
                HStack {
                    Button("Send test notification") { Notifier.shared.sendTest(config: store.config) }
                    Spacer()
                    Text("Nothing arriving? Check Focus / Do Not Disturb first.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            Section("How they arrive") {
                Picker("Nudges", selection: store.style("nudge")) {
                    Text("Alert — stays until dismissed").tag("alert")
                    Text("Alert only near a limit").tag("auto")
                    Text("Banner").tag("banner")
                }
                Picker("Daily digest", selection: store.style("digest")) {
                    Text("Alert").tag("alert")
                    Text("Banner").tag("banner")
                }
                Picker("Digest", selection: store.string("digest.cadence", "daily")) {
                    Text("Daily").tag("daily")
                    Text("Off").tag("off")
                }
                Stepper(value: store.int("interrupt.minGapMins", 20), in: 0...120, step: 5) {
                    LabeledContent("Quiet gap between nudges", value: "\((store.value("interrupt.minGapMins") as? NSNumber)?.intValue ?? 20) min")
                }
                Stepper(value: store.int("interrupt.maxPerNudge", 1), in: 1...5) {
                    LabeledContent("Findings per notification", value: "\((store.value("interrupt.maxPerNudge") as? NSNumber)?.intValue ?? 1)")
                }
                Toggle("When a limit runs out", isOn: store.bool("notify.depleted", true))
            }
            Section {
                ForEach(rules, id: \.0) { rule in
                    Toggle(rule.1, isOn: store.liveRule(rule.0))
                }
            } header: {
                Text("May interrupt mid-session")
            } footer: {
                Text("Everything else waits for the daily digest.").font(.caption).foregroundStyle(.secondary)
            }
            Section("Recent nudges") {
                let recent = store.status?.recent ?? []
                if recent.isEmpty {
                    Text("None yet.").foregroundStyle(.secondary)
                }
                ForEach(Array(recent.prefix(8).enumerated()), id: \.offset) { _, item in
                    HStack(alignment: .firstTextBaseline) {
                        Text(Fmt.time(item.at)).font(.caption.monospacedDigit()).foregroundStyle(.secondary).frame(width: 90, alignment: .leading)
                        Text((item.labels ?? []).joined(separator: ", ").isEmpty ? (item.event ?? "") : (item.labels ?? []).joined(separator: ", "))
                    }
                }
            }
        }
        .formStyle(.grouped)
    }
}

// MARK: - Limits & budgets

private struct LimitsPane: View {
    @EnvironmentObject var store: Store
    @State private var marks = ""

    private var quotaIsCeiling: Bool {
        store.status?.plan?.paysPerToken == false && !(store.status?.usableLimits.isEmpty ?? true)
    }

    var body: some View {
        Form {
            Section("Plan limits") {
                Toggle("Notify on plan limits", isOn: store.bool("limits.enabled", true))
                TextField("Marks (%)", text: $marks, prompt: Text("50, 75, 90"))
                    .onSubmit(saveMarks)
                Text(store.status?.plan?.name.map { "Applies to \($0) and as the default. Press Return to save." } ?? "Press Return to save.")
                    .font(.caption).foregroundStyle(.secondary)
                Stepper(value: store.double("limits.paceRatio", 1.5), in: 1.1...3.0, step: 0.1) {
                    LabeledContent("Pace warning at", value: String(format: "%.1f× refill rate", (store.value("limits.paceRatio") as? NSNumber)?.doubleValue ?? 1.5))
                }
                Stepper(value: store.int("limits.paceMinElapsed", 15), in: 0...100, step: 5) {
                    LabeledContent("…once the window is", value: "\((store.value("limits.paceMinElapsed") as? NSNumber)?.intValue ?? 15)% through")
                }
                Stepper(value: store.int("limits.paceMinUsed", 20), in: 0...100, step: 5) {
                    LabeledContent("…and at least", value: "\((store.value("limits.paceMinUsed") as? NSNumber)?.intValue ?? 20)% used")
                }
            }
            Section {
                TextField("Session cost cap ($)", value: store.double("session.costCap", 25), format: .number)
                TextField("Daily cost cap ($)", value: store.double("daily.costCap", 50), format: .number)
                Stepper(value: store.double("daily.baselineSigma", 2.5), in: 1.0...5.0, step: 0.5) {
                    LabeledContent("Unusual day at", value: String(format: "%.1fσ above normal", (store.value("daily.baselineSigma") as? NSNumber)?.doubleValue ?? 2.5))
                }
            } header: {
                Text("Budgets")
            } footer: {
                if quotaIsCeiling {
                    Text("Your plan reports quota, so dollar caps stay quiet.").font(.caption).foregroundStyle(.secondary)
                }
            }
        }
        .formStyle(.grouped)
        .onAppear(perform: loadMarks)
    }

    private func loadMarks() {
        let plan = store.status?.plan?.name
        let byPlan = plan.flatMap { (store.value("limits.byPlan") as? [String: Any])?[$0] as? [NSNumber] }
        let steps = byPlan ?? (store.value("limits.steps") as? [NSNumber]) ?? [50, 75, 90]
        marks = steps.map { "\($0.intValue)" }.joined(separator: ", ")
    }

    private func saveMarks() {
        let steps = marks.split(whereSeparator: { $0 == "," || $0 == " " })
            .compactMap { Int($0) }
            .filter { $0 > 0 && $0 <= 100 }
            .sorted()
        guard !steps.isEmpty else { return }
        store.set("limits.steps", steps, debounce: false)
        if let plan = store.status?.plan?.name {
            // `byPlan` takes precedence, so setting only `steps` would do nothing on a known plan.
            store.set("limits.byPlan.\(plan)", steps, debounce: false)
        }
        marks = steps.map(String.init).joined(separator: ", ")
    }
}

// MARK: - Advanced

private struct AdvancedPane: View {
    @EnvironmentObject var store: Store
    @State private var doctor: String?
    @State private var working = false

    var body: some View {
        Form {
            Section("Nudge hooks") {
                let hooks = store.status?.hooks
                LabeledContent("Claude Code hooks") {
                    if hooks?.installed == true, (hooks?.missing ?? []).isEmpty {
                        Label("Installed", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
                    } else {
                        Label(hooks?.missing?.isEmpty == false ? "Missing \(hooks!.missing!.joined(separator: ", "))" : "Not installed", systemImage: "exclamationmark.circle.fill")
                            .foregroundStyle(.orange)
                    }
                }
                HStack {
                    Button("Install hooks") { run(["init", "--hooks", "--force"]) }
                    Button("Remove") { run(["init", "--hooks", "--remove"]) }
                    if working { ProgressView().controlSize(.small) }
                }
                Text("Hooks let Marmot judge a session the moment a turn ends. Restart Claude Code after changing them.")
                    .font(.caption).foregroundStyle(.secondary)
                if hooks?.plugin == true {
                    Text("The Marmot Claude Code plugin is also enabled — nudges can arrive twice. Remove it with `claude plugin uninstall marmot`.")
                        .font(.caption).foregroundStyle(.orange)
                }
            }
            Section("Engine") {
                Toggle("Measure MCP servers automatically", isOn: store.bool("mcp.autoAudit", true))
                Toggle("Keep a log of what the hooks did", isOn: store.bool("log.hooks", true))
                HStack {
                    Button("Open marmot.json") { store.openConfigFile() }
                    Button("Run doctor") {
                        working = true
                        Task {
                            doctor = await store.runText(["doctor"])
                            working = false
                        }
                    }
                }
                LabeledContent("Node", value: Engine.shared.nodePath ?? "not found")
                    .font(.caption).textSelection(.enabled)
                LabeledContent("Engine", value: Engine.shared.enginePath ?? "not found")
                    .font(.caption).textSelection(.enabled)
            }
        }
        .formStyle(.grouped)
        .sheet(isPresented: Binding(get: { doctor != nil }, set: { if !$0 { doctor = nil } })) {
            VStack(alignment: .leading) {
                ScrollView {
                    Text(doctor ?? "")
                        .font(.system(.caption, design: .monospaced))
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                HStack {
                    Spacer()
                    Button("Done") { doctor = nil }.keyboardShortcut(.defaultAction)
                }
            }
            .padding()
            .frame(width: 560, height: 420)
        }
    }

    private func run(_ args: [String]) {
        working = true
        Task {
            _ = await store.runText(args)
            await store.loadStatus()
            working = false
        }
    }
}
