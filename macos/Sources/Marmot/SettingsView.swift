import ServiceManagement
import SwiftUI

struct SettingsView: View {
    @EnvironmentObject var store: Store

    var body: some View {
        TabView {
            GeneralPane().tabItem { Label("General", systemImage: "gearshape") }
            NotificationsPane().tabItem { Label("Notifications", systemImage: "bell.badge") }
            AdvancedLimitsPane().tabItem { Label("Advanced limits", systemImage: "gauge.with.dots.needle.67percent") }
            AdvancedPane().tabItem { Label("Advanced", systemImage: "wrench.and.screwdriver") }
        }
        .environmentObject(store)
        .frame(width: 580, height: 640)
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
    @State private var testNote: String?
    @State private var digestNote: String?
    @State private var sending = false

    private let sounds = ["Ping", "Glass", "Hero", "Pop", "Submarine", "Funk", "Purr"]

    var body: some View {
        Form {
            delivery
            LimitWindowSection(
                title: "5-hour session limit",
                caption: "Notify me when my 5-hour session usage reaches:",
                key: "session",
                remindWindow: "session",
                kinds: ["session", "five_hour"]
            )
            LimitWindowSection(
                title: "Weekly limit",
                caption: "Notify me when my weekly usage (all models) reaches:",
                key: "weekly_all",
                remindWindow: "weekly",
                kinds: ["weekly_all", "seven_day"]
            )
            if let scoped = store.status?.limits?.first(where: { $0.kind == "weekly_scoped" }) {
                LimitWindowSection(
                    title: "Weekly model limit",
                    caption: "Notify me when my \(modelName(scoped)) weekly usage reaches:",
                    key: "weekly_scoped",
                    remindWindow: "weekly-model",
                    kinds: ["weekly_scoped"]
                )
            }
            otherReminders
            digest
            recent
        }
        .formStyle(.grouped)
    }

    // 1. Delivery

    private var delivery: some View {
        Section {
            Toggle("Show notifications", isOn: store.bool("notify.desktop", true))
            Toggle("Play a sound", isOn: store.bool("notify.bell", true))
            Picker("Sound", selection: store.string("notify.sound", "Ping")) {
                ForEach(sounds, id: \.self) { Text($0).tag($0) }
            }
            .disabled((store.value("notify.bell") as? Bool) == false)
            Picker("Nudge style", selection: store.style("nudge")) {
                Text("Stays until dismissed").tag("alert")
                Text("Stays only near a limit").tag("auto")
                Text("Banner").tag("banner")
            }
            Picker("Daily digest style", selection: store.style("digest")) {
                Text("Stays until dismissed").tag("alert")
                Text("Banner").tag("banner")
            }
            Stepper(value: store.int("interrupt.minGapMins", 20), in: 0...120, step: 5) {
                LabeledContent("Quiet time between nudges", value: "\((store.value("interrupt.minGapMins") as? NSNumber)?.intValue ?? 20) min")
            }
            HStack {
                Button("Send test notification") {
                    send(digest: false)
                }
                .disabled(sending)
                if let testNote {
                    Text(testNote).font(.caption).foregroundStyle(.secondary)
                }
            }
        } header: {
            Text("Delivery")
        } footer: {
            Text("How notifications reach you. Nothing arriving? Check Focus / Do Not Disturb first.")
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    // 5. Other reminders

    private var otherReminders: some View {
        let plan = store.status?.plan
        let showCaps = plan?.paysPerToken == true || plan?.name == nil || plan?.name == "Enterprise"
        let turnMarks = ConfigPath.ints(store.value("session.turnMarks")) ?? [10, 15, 20]
        return Section {
            Toggle("When a limit runs out", isOn: store.bool("notify.depleted", true))
            Toggle("When a limit is burning faster than it refills", isOn: store.liveRule("limit-pace"))
            VStack(alignment: .leading, spacing: 6) {
                Text("Long sessions").font(.callout.weight(.medium))
                Text("Notify me when one session reaches this many prompts:")
                    .font(.caption).foregroundStyle(.secondary)
                MarkListEditor(
                    marks: turnMarks,
                    range: 1...500,
                    format: { "\($0) prompts" },
                    offText: "Off — you won't be notified about long sessions."
                ) { store.set("session.turnMarks", $0, delay: 0.4) }
            }
            if showCaps {
                TextField("Session cost cap ($)", value: store.double("session.costCap", 25), format: .number)
                TextField("Daily cost cap ($)", value: store.double("daily.costCap", 50), format: .number)
            } else {
                Text("On your plan, the limits above are the ceiling — dollar caps stay quiet.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        } header: {
            Text("Other reminders")
        }
    }

    // 6. Daily digest

    private var digest: some View {
        Section {
            Picker("Send a digest", selection: store.string("digest.cadence", "daily")) {
                Text("Daily").tag("daily")
                Text("Off").tag("off")
            }
            HStack {
                Button("Send test digest") {
                    send(digest: true)
                }
                .disabled(sending)
                if let digestNote {
                    Text(digestNote).font(.caption).foregroundStyle(.secondary)
                }
            }
        } header: {
            Text("Daily digest")
        } footer: {
            Text("Once a day, at the start of your first Claude Code session: yesterday's spend and anything flagged.")
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    // 7. Recent

    private var recent: some View {
        Section("Recent notifications") {
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

    private func send(digest: Bool) {
        sending = true
        if digest { digestNote = "Sending…" } else { testNote = "Sending…" }
        Task {
            await store.sendEngineTest(digest: digest)
            sending = false
            let note = (store.value("notify.desktop") as? Bool) == false
                ? "Notifications are off above."
                : "Sent — it appears through Marmot now."
            if digest { digestNote = note } else { testNote = note }
            await store.loadStatus()
        }
    }

    private func modelName(_ limit: Limit) -> String {
        if let label = limit.label, let dot = label.range(of: "· ") {
            return String(label[dot.upperBound...])
        }
        return "model"
    }
}

/// One plan window's marks: the list, an editor, and today's usage against them.
private struct LimitWindowSection: View {
    @EnvironmentObject var store: Store
    let title: String
    let caption: String
    /// `limits.byWindow` key: session, weekly_all or weekly_scoped.
    let key: String
    /// The name `marmot remind --window` takes.
    let remindWindow: String
    let kinds: [String]

    private var current: (marks: [Int], custom: Bool) {
        if let own = ConfigPath.ints(store.value("limits.byWindow.\(key)")) {
            return (own.sorted(), true)
        }
        let effective = store.status?.limitMarks?[key]
        return (effective?.marks ?? [50, 75, 90], effective?.custom ?? false)
    }

    var body: some View {
        let state = current
        let limit = store.status?.limits?.first { kinds.contains($0.kind ?? "") }
        Section {
            Text(caption).font(.callout)
            MarkListEditor(
                marks: state.marks,
                range: 1...100,
                format: { "\($0)%" },
                offText: "Off — you won't be notified for this window."
            ) { store.set("limits.byWindow.\(key)", $0, delay: 0.4) }
            LimitPreviewBar(limit: limit, marks: state.marks)
            if state.custom {
                Button("Reset to plan default") {
                    Task { await store.resetWindow(key: key, windowArg: remindWindow) }
                }
                .buttonStyle(.link)
            }
        } header: {
            Text(title)
        }
    }
}

/// Chips with ✕, plus a field that adds one.
struct MarkListEditor: View {
    let marks: [Int]
    let range: ClosedRange<Int>
    let format: (Int) -> String
    let offText: String
    let onChange: ([Int]) -> Void

    @State private var draft = ""
    @State private var hint: String?

    /// "%" or "prompts": whatever the chips carry, taken from the formatter.
    private var unit: String {
        format(0).replacingOccurrences(of: "0", with: "").trimmingCharacters(in: .whitespaces)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if marks.isEmpty {
                Text(offText).font(.caption).foregroundStyle(.orange)
            } else {
                FlowLayout(spacing: 6) {
                    ForEach(marks, id: \.self) { mark in
                        HStack(spacing: 4) {
                            Text(format(mark)).font(.callout.monospacedDigit())
                            Button {
                                hint = nil
                                onChange(marks.filter { $0 != mark })
                            } label: {
                                Image(systemName: "xmark").font(.caption2.weight(.bold))
                            }
                            .buttonStyle(.plain)
                            .foregroundStyle(.secondary)
                            .help("Remove \(format(mark))")
                        }
                        .padding(.horizontal, 8)
                        .padding(.vertical, 3)
                        .background(Capsule().fill(Color.accentColor.opacity(0.15)))
                    }
                }
            }
            // A grouped Form draws text fields borderless, which leaves nothing
            // to click on. Give the field its own border and its unit, so it
            // reads as the place you type.
            HStack(spacing: 8) {
                HStack(spacing: 4) {
                    TextField("New mark", text: $draft, prompt: Text(range.upperBound == 100 ? "e.g. 60" : "e.g. 25"))
                        .textFieldStyle(.roundedBorder)
                        .labelsHidden()
                        .multilineTextAlignment(.trailing)
                        .frame(width: 70)
                        .onSubmit(add)
                    if !unit.isEmpty {
                        Text(unit).foregroundStyle(.secondary)
                    }
                }
                Button(action: add) {
                    Label("Add", systemImage: "plus")
                }
                .buttonStyle(.bordered)
                .disabled(draft.trimmingCharacters(in: .whitespaces).isEmpty)
                if let hint {
                    Text(hint).font(.caption).foregroundStyle(.orange)
                }
            }
        }
    }

    private func add() {
        let text = draft.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: "%", with: "")
        guard let value = Int(text), range.contains(value) else {
            hint = "Enter a whole number from \(range.lowerBound) to \(range.upperBound)."
            return
        }
        guard !marks.contains(value) else {
            hint = "\(format(value)) is already in the list."
            return
        }
        hint = nil
        draft = ""
        onChange((marks + [value]).sorted())
    }
}

/// Current usage for a window, with a tick at each chosen mark.
struct LimitPreviewBar: View {
    let limit: Limit?
    let marks: [Int]

    var body: some View {
        let pct = limit?.percent ?? 0
        VStack(alignment: .leading, spacing: 4) {
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.primary.opacity(0.1)).frame(height: 8)
                    Capsule()
                        .fill(limitColor(pct))
                        .frame(width: max(pct > 0 ? 4 : 0, geo.size.width * min(pct, 100) / 100), height: 8)
                    ForEach(marks, id: \.self) { mark in
                        Rectangle()
                            .fill(Color.primary.opacity(0.6))
                            .frame(width: 1.5, height: 14)
                            .offset(x: max(0, geo.size.width * CGFloat(min(mark, 100)) / 100 - 0.75))
                    }
                }
                .frame(height: 14)
            }
            .frame(height: 14)
            Text(caption).font(.caption).foregroundStyle(.secondary)
        }
    }

    private var caption: String {
        guard let limit, let pct = limit.percent else { return "No current reading for this window." }
        let now = "Now \(Int(pct.rounded()))%"
        if let resets = Fmt.resets(limit.resetsAt) { return "\(now) · \(resets)" }
        return now
    }
}

/// Wraps its children onto as many rows as they need.
struct FlowLayout: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxWidth = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, row: CGFloat = 0, widest: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > 0, x + size.width > maxWidth {
                y += row + spacing
                x = 0
                row = 0
            }
            x += size.width + spacing
            row = max(row, size.height)
            widest = max(widest, x - spacing)
        }
        return CGSize(width: proposal.width ?? widest, height: y + row)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, row: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > bounds.minX, x + size.width > bounds.maxX {
                y += row + spacing
                x = bounds.minX
                row = 0
            }
            view.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            row = max(row, size.height)
        }
    }
}

// MARK: - Advanced limits

private struct AdvancedLimitsPane: View {
    @EnvironmentObject var store: Store

    var body: some View {
        Form {
            Section {
                Toggle("Notify on plan limits", isOn: store.bool("limits.enabled", true))
            } footer: {
                Text("The marks themselves are set per window in Notifications.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Section {
                Stepper(value: store.double("limits.paceRatio", 1.5), in: 1.1...3.0, step: 0.1) {
                    LabeledContent("Pace warning at", value: String(format: "%.1f× refill rate", (store.value("limits.paceRatio") as? NSNumber)?.doubleValue ?? 1.5))
                }
                Stepper(value: store.int("limits.paceMinElapsed", 15), in: 0...100, step: 5) {
                    LabeledContent("…once the window is", value: "\((store.value("limits.paceMinElapsed") as? NSNumber)?.intValue ?? 15)% through")
                }
                Stepper(value: store.int("limits.paceMinUsed", 20), in: 0...100, step: 5) {
                    LabeledContent("…and at least", value: "\((store.value("limits.paceMinUsed") as? NSNumber)?.intValue ?? 20)% used")
                }
            } header: {
                Text("Pace")
            }
            Section {
                Stepper(value: store.double("daily.baselineSigma", 2.5), in: 1.0...5.0, step: 0.5) {
                    LabeledContent("Unusual day at", value: String(format: "%.1fσ above normal", (store.value("daily.baselineSigma") as? NSNumber)?.doubleValue ?? 2.5))
                }
            } header: {
                Text("Unusual days")
            }
        }
        .formStyle(.grouped)
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
