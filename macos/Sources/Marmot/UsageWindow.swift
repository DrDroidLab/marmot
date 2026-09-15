import AppKit
import Charts
import SwiftUI

/// The expanded usage view: a plain resizable window, opened from the menu's
/// chart. An AppKit window rather than a SwiftUI `Window` scene, so a menu bar
/// app never opens it by itself at launch.
/// The window's two views. Remembered, so it opens where the menu sent you.
enum InsightsTab: String {
    case usage, recommendations
}

@MainActor
final class UsageWindowController {
    static let shared = UsageWindowController()
    private var window: NSWindow?

    func show(tab: InsightsTab = .usage) {
        UserDefaults.standard.set(tab.rawValue, forKey: "insightsTab")
        if window == nil {
            let host = NSHostingController(rootView: AnyView(UsageWindowView().environmentObject(Store.shared)))
            let w = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: 760, height: 540),
                styleMask: [.titled, .closable, .miniaturizable, .resizable],
                backing: .buffered,
                defer: false
            )
            w.title = "Marmot"
            w.contentViewController = host
            w.minSize = NSSize(width: 560, height: 420)
            w.setContentSize(NSSize(width: 760, height: 540))
            w.isReleasedWhenClosed = false
            w.center()
            w.setFrameAutosaveName("MarmotUsageWindow")
            window = w
        }
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
    }
}

struct UsageWindowView: View {
    @EnvironmentObject var store: Store
    @AppStorage("chartMetric") private var metric = "cost"
    @AppStorage("usageRange") private var range = 30
    @State private var selection: Date?

    private struct Segment: Identifiable {
        let date: Date
        let model: String
        let value: Double
        var id: String { "\(date.timeIntervalSince1970)-\(model)" }
    }

    private struct ModelTotal: Identifiable {
        let model: String
        var cost: Double
        var tokens: Double
        var id: String { model }
    }

    private var payload: Status? { store.usage[range] }
    @AppStorage("insightsTab") private var tab = InsightsTab.usage.rawValue

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Picker("View", selection: $tab) {
                Text("Usage").tag(InsightsTab.usage.rawValue)
                Text("Recommendations").tag(InsightsTab.recommendations.rawValue)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .frame(width: 280)
            .frame(maxWidth: .infinity)

            if tab == InsightsTab.recommendations.rawValue {
                RecommendationsList()
            } else {
                usageBody
            }
        }
        .padding(18)
        .frame(minWidth: 560, minHeight: 420)
        .onAppear { Task { await store.loadUsage(days: range) } }
        .onChange(of: range) { _, newValue in
            selection = nil
            Task { await store.loadUsage(days: newValue) }
        }
    }

    @ViewBuilder
    private var usageBody: some View {
        header
        if let status = payload {
            content(status)
        } else {
            Spacer()
            HStack {
                Spacer()
                ProgressView("Reading \(range) days of sessions…")
                Spacer()
            }
            Spacer()
        }
    }

    private var header: some View {
        HStack(spacing: 12) {
            Text("Usage").font(.title2.weight(.semibold))
            if let plan = store.status?.plan?.name {
                Text(plan)
                    .font(.caption.weight(.semibold))
                    .padding(.horizontal, 7)
                    .padding(.vertical, 2)
                    .background(Capsule().fill(Color.brown.opacity(0.22)))
                    .foregroundStyle(Color.brown)
            }
            if store.usageLoading.contains(range) && payload != nil {
                ProgressView().controlSize(.small)
            }
            Spacer()
            Picker("Range", selection: $range) {
                Text("7 days").tag(7)
                Text("30 days").tag(30)
                Text("90 days").tag(90)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .frame(width: 210)
            Picker("Metric", selection: $metric) {
                Text("Cost").tag("cost")
                Text("Tokens").tag("tokens")
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .frame(width: 130)
        }
    }

    @ViewBuilder
    private func content(_ status: Status) -> some View {
        let days = (status.daily ?? []).compactMap { d in Fmt.localDay(d.day).map { (date: $0, day: d) } }
        let segments = segments(days)
        let selected = selection.flatMap { s in days.first { Calendar.current.isDate($0.date, inSameDayAs: s) } }

        inspector(selected)

        Chart {
            ForEach(segments) { s in
                BarMark(
                    x: .value("Day", s.date, unit: .day),
                    y: .value(metric == "tokens" ? "Tokens" : "Cost", s.value)
                )
                .foregroundStyle(by: .value("Model", s.model))
                .opacity(selected == nil || Calendar.current.isDate(s.date, inSameDayAs: selected!.date) ? 1 : 0.45)
            }
        }
        .chartLegend(position: .top, alignment: .leading)
        .chartXAxis {
            AxisMarks(values: .stride(by: .day, count: range <= 7 ? 1 : range <= 30 ? 5 : 15)) { _ in
                AxisGridLine().foregroundStyle(Color.primary.opacity(0.06))
                AxisValueLabel(format: .dateTime.day().month(.abbreviated))
            }
        }
        .chartYAxis {
            AxisMarks(position: .leading, values: .automatic(desiredCount: 4)) { value in
                AxisGridLine().foregroundStyle(Color.primary.opacity(0.08))
                AxisValueLabel {
                    if let v = value.as(Double.self) { Text(Fmt.axis(v, metric: metric)) }
                }
            }
        }
        .chartXSelection(value: $selection)
        .frame(minHeight: 180)

        totals(days.map(\.day), today: status.today?.day)

        modelsTable(days.map(\.day))

        HStack {
            Text(status.plan?.paysPerToken == true ? "Spend at API rates — this is the bill." : "Modelled at API rates — not your bill. Days are your local calendar days.")
                .font(.caption)
                .foregroundStyle(.secondary)
            Spacer()
            Button {
                store.openBrowser()
            } label: {
                Label("View Insights in Browser", systemImage: "safari")
            }
        }
    }

    private func segments(_ days: [(date: Date, day: Day)]) -> [Segment] {
        var out: [Segment] = []
        for (date, day) in days {
            let models = day.models ?? []
            if models.isEmpty {
                if day.value(metric) > 0 { out.append(Segment(date: date, model: "other", value: day.value(metric))) }
                continue
            }
            for m in models where m.value(metric) > 0 {
                out.append(Segment(date: date, model: Fmt.shortModel(m.model), value: m.value(metric)))
            }
        }
        return out
    }

    private func inspector(_ selected: (date: Date, day: Day)?) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            if let selected {
                Text("\(Fmt.dayLabel(selected.date)) · \(Fmt.usd(selected.day.cost ?? 0)) · \(Fmt.tokens(selected.day.tokens ?? 0)) tokens")
                    .font(.callout.weight(.semibold).monospacedDigit())
                let models = (selected.day.models ?? []).sorted { $0.value(metric) > $1.value(metric) }
                Text(models.isEmpty ? "No usage this day." : models.map { "\(Fmt.shortModel($0.model)) \(Fmt.usd($0.cost ?? 0)) · \(Fmt.tokens($0.tokens ?? 0))" }.joined(separator: "   "))
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            } else {
                Text("Hover over a bar for that day's breakdown.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                Text(" ").font(.caption)
            }
        }
        .frame(height: 40, alignment: .topLeading)
    }

    private func totals(_ days: [Day], today: String?) -> some View {
        let total = days.reduce(0) { $0 + $1.value(metric) }
        let active = max(1, days.count)
        let peak = days.max { $0.value(metric) < $1.value(metric) }
        let todayValue = days.first { $0.day == today }?.value(metric) ?? days.last?.value(metric) ?? 0
        return HStack(alignment: .top, spacing: 18) {
            UsageTotal(label: "Total · \(range) days", value: Fmt.metric(total, metric))
            UsageTotal(label: "Average per day", value: Fmt.metric(total / Double(active), metric))
            UsageTotal(label: "Peak day", value: peak.map { Fmt.metric($0.value(metric), metric) } ?? "—", note: peak.map { Fmt.dayLabel($0.day) })
            UsageTotal(label: "Today", value: Fmt.metric(todayValue, metric))
        }
    }

    private func modelsTable(_ days: [Day]) -> some View {
        var byModel: [String: ModelTotal] = [:]
        for day in days {
            for m in day.models ?? [] {
                var row = byModel[m.model] ?? ModelTotal(model: m.model, cost: 0, tokens: 0)
                row.cost += m.cost ?? 0
                row.tokens += m.tokens ?? 0
                byModel[m.model] = row
            }
        }
        let rows = byModel.values.sorted { (metric == "tokens" ? $0.tokens : $0.cost) > (metric == "tokens" ? $1.tokens : $1.cost) }
        let whole = rows.reduce(0) { $0 + (metric == "tokens" ? $1.tokens : $1.cost) }
        return Table(rows) {
            TableColumn("Model") { row in Text(Fmt.shortModel(row.model)) }
            TableColumn("Cost") { row in Text(Fmt.usd(row.cost)).monospacedDigit() }
            TableColumn("Tokens") { row in Text(Fmt.tokens(row.tokens)).monospacedDigit() }
            TableColumn("Share") { row in
                let part = metric == "tokens" ? row.tokens : row.cost
                Text(whole > 0 ? "\(Int((part / whole * 100).rounded()))%" : "—").monospacedDigit()
            }
        }
        .frame(height: 120)
    }
}

/// Everything the menu has room for only two of, in full: what is happening,
/// what to do about it, and where the finding came from.
private struct RecommendationsList: View {
    @EnvironmentObject var store: Store

    var body: some View {
        let items = store.status.map(AttentionItem.all) ?? []
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Recommendations").font(.title2.weight(.semibold))
                    Text("From the last \(store.status?.window?.days ?? 30) days of Claude sessions on this Mac. Thresholds you set come first, then the biggest savings.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if items.isEmpty {
                    Text("Nothing to fix right now.").font(.body).foregroundStyle(.secondary).padding(.top, 8)
                }
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    HStack(alignment: .top, spacing: 10) {
                        Circle().fill(item.color).frame(width: 8, height: 8).padding(.top, 6)
                        VStack(alignment: .leading, spacing: 5) {
                            Text(item.headline)
                                .font(.body.weight(.medium))
                                .fixedSize(horizontal: false, vertical: true)
                            if let detail = item.detail, detail != item.headline {
                                Text(detail).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                            }
                            if let action = item.action {
                                Label(action, systemImage: "arrow.turn.down.right")
                                    .font(.callout)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            Text(item.source).font(.caption).foregroundStyle(.tertiary)
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 8).fill(Color.primary.opacity(0.045)))
                }
                HStack {
                    Spacer()
                    Button {
                        store.openBrowser()
                    } label: {
                        Label("View Insights in Browser", systemImage: "safari")
                    }
                }
                .padding(.top, 4)
            }
            .padding(.bottom, 6)
        }
    }
}

private struct UsageTotal: View {
    let label: String
    let value: String
    var note: String? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.caption).foregroundStyle(.secondary)
            Text(value).font(.title3.monospacedDigit().weight(.semibold))
            if let note { Text(note).font(.caption2).foregroundStyle(.secondary) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
