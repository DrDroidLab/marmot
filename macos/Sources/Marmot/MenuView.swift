import AppKit
import SwiftUI

struct MenuView: View {
    @EnvironmentObject var store: Store
    @Environment(\.openSettings) private var openSettings
    /// The one recommendation opened in place, if any. One at a time, so the
    /// menu grows by a line or two at most.
    @State private var expandedRec: Int?
    @AppStorage("chartMetric") private var metric = "cost"

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
                .padding(.bottom, 10)

            if let error = store.lastError {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(.orange)
                    .wraps()
                    .padding(.bottom, 10)
            }

            if let status = store.status {
                limits(status)
                divider
                costs(status)
                chart(status)
                divider
                recommendations(status)
            } else if store.lastError == nil {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Reading your Claude sessions…").foregroundStyle(.secondary)
                }
                .padding(.vertical, 12)
            }

            divider
            footer
        }
        .padding(14)
        .frame(width: 340)
        .onAppear { Task { await store.loadStatus() } }
    }

    private var divider: some View {
        Divider().padding(.vertical, 10)
    }

    // MARK: header

    private var header: some View {
        HStack(alignment: .firstTextBaseline) {
            Text("Claude").font(.headline)
            if let plan = store.status?.plan?.name {
                Text(plan)
                    .font(.caption2.weight(.semibold))
                    .padding(.horizontal, 6)
                    .padding(.vertical, 1)
                    .background(Capsule().fill(Color.brown.opacity(0.22)))
                    .foregroundStyle(Color.brown)
            }
            Spacer()
            if store.refreshingLimits {
                HStack(spacing: 4) {
                    ProgressView().controlSize(.mini)
                    Text("refreshing limits").font(.caption).foregroundStyle(.secondary)
                }
            } else if let plan = store.status?.plan, let age = plan.ageMins {
                Text(plan.stale == true ? "limits \(Fmt.duration(mins: age)) old" : age < 1 ? "updated just now" : "updated \(Fmt.duration(mins: age)) ago")
                    .font(.caption)
                    .foregroundStyle(plan.stale == true ? Color.orange : Color.secondary)
            }
        }
    }

    // MARK: limits

    @ViewBuilder
    private func limits(_ status: Status) -> some View {
        let usable = status.usableLimits
        VStack(alignment: .leading, spacing: 9) {
            if usable.isEmpty {
                HStack {
                    Text(status.plan?.paysPerToken == true ? "Pay-as-you-go: no plan limits to run out of." : "No current limit reading.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                    Spacer()
                    if status.plan?.paysPerToken != true {
                        Button("Refresh") { store.refreshNow() }
                            .controlSize(.small)
                            .disabled(store.refreshingLimits)
                    }
                }
            }
            // A per-model weekly limit at 0% says nothing; it earns a row once used.
            ForEach(usable.filter { !($0.kind == "weekly_scoped" && ($0.percent ?? 0) == 0) }) { limit in
                LimitRow(limit: limit)
            }
            if let spend = status.spend, spend.enabled == true {
                HStack {
                    Text("Usage credits").font(.callout)
                    Spacer()
                    Text("\(Fmt.usd(spend.used ?? 0)) of \(Fmt.usd(spend.limit))")
                        .font(.callout.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
            }
            if let note = store.lastRefreshNote {
                Text(note).font(.caption2).foregroundStyle(.secondary).wraps()
            }
        }
    }

    // MARK: costs

    private func costs(_ status: Status) -> some View {
        let days = status.window?.days ?? store.windowDays
        return VStack(alignment: .leading, spacing: 8) {
            Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 8) {
                GridRow {
                    Stat(label: "Today", value: Fmt.usd(status.today?.cost))
                    Stat(label: "\(days) days", value: Fmt.usd(status.window?.cost))
                }
                GridRow {
                    Stat(label: "Tokens today", value: Fmt.tokens(status.today?.tokens))
                    Stat(label: "Tokens · \(days)d", value: Fmt.tokens(status.window?.tokens))
                }
            }
            Text(status.plan?.paysPerToken == true ? "Spend at API rates — this is the bill." : "Modelled at API rates — not your bill.")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
    }

    @ViewBuilder
    private func chart(_ status: Status) -> some View {
        let days = Array((status.daily ?? []).suffix(14))
        if days.contains(where: { ($0.cost ?? 0) > 0 || ($0.tokens ?? 0) > 0 }) {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    Text("Last 14 days").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    Spacer()
                    Picker("Metric", selection: $metric) {
                        Text("Cost").tag("cost")
                        Text("Tokens").tag("tokens")
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    .controlSize(.small)
                    .frame(width: 120)
                    Button {
                        UsageWindowController.shared.show()
                    } label: {
                        Image(systemName: "arrow.up.left.and.arrow.down.right")
                    }
                    .buttonStyle(.borderless)
                    .help("Expand")
                }
                UsageChart(days: days, today: status.today?.day, metric: metric)
            }
            .padding(.top, 10)
        }
    }

    // MARK: recommendations

    /// Two lines at most, one line each: the menu is a glance, not a reading
    /// list. Click one to see what to do; everything lives in the window.
    private func recommendations(_ status: Status) -> some View {
        let items = AttentionItem.all(status)
        return VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("Recommendations").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                Spacer()
                if items.count > 2 {
                    Button("See all \(items.count) ›") { UsageWindowController.shared.show(tab: .recommendations) }
                        .buttonStyle(.plain)
                        .font(.caption.weight(.medium))
                        .foregroundStyle(Color.accentColor)
                }
            }
            if items.isEmpty {
                Text("Nothing to fix right now.").font(.callout).foregroundStyle(.secondary)
            }
            ForEach(Array(items.prefix(2).enumerated()), id: \.offset) { index, item in
                let open = expandedRec == index
                Button {
                    withAnimation(.easeInOut(duration: 0.15)) { expandedRec = open ? nil : index }
                } label: {
                    HStack(alignment: .top, spacing: 8) {
                        Circle().fill(item.color).frame(width: 6, height: 6).padding(.top, 6)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(item.headline)
                                .font(.callout)
                                .lineLimit(open ? nil : 1)
                                .truncationMode(.tail)
                                .multilineTextAlignment(.leading)
                                .fixedSize(horizontal: false, vertical: true)
                            if open {
                                if let detail = item.detail, detail != item.headline {
                                    Text(detail).font(.caption).foregroundStyle(.secondary).wraps()
                                }
                                if let action = item.action {
                                    Text(action).font(.caption).foregroundStyle(.secondary).wraps()
                                }
                            }
                        }
                        Spacer(minLength: 4)
                        Image(systemName: open ? "chevron.up" : "chevron.down")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                            .padding(.top, 3)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help(open ? "" : item.headline)
            }
        }
    }

    // MARK: footer

    private var footer: some View {
        VStack(spacing: 1) {
            MenuRow(title: "View Insights in Browser", systemImage: "safari") { store.openBrowser() }
            MenuRow(title: "Refresh", systemImage: "arrow.clockwise", shortcut: "⌘R") { store.refreshNow() }
                .keyboardShortcut("r")
            MenuRow(title: "Settings…", systemImage: "gearshape", shortcut: "⌘,") {
                openSettings()
                NSApp.activate(ignoringOtherApps: true)
            }
            .keyboardShortcut(",")
            MenuRow(title: "Quit Marmot", systemImage: "xmark.square", shortcut: "⌘Q") { NSApp.terminate(nil) }
                .keyboardShortcut("q")
        }
        .padding(.horizontal, -6)
    }
}

private extension View {
    func wraps() -> some View { fixedSize(horizontal: false, vertical: true) }
}

struct LimitRow: View {
    let limit: Limit

    var body: some View {
        let pct = limit.percent ?? 0
        // One line of text per limit: name, when it resets, how much is gone.
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(title).font(.callout)
                if limit.pace?.exhaustsBeforeReset == true {
                    Image(systemName: "bolt.fill")
                        .font(.caption2)
                        .foregroundStyle(.orange)
                        .help("Spending this faster than it refills")
                }
                Spacer()
                if limit.justReset == true {
                    Text("just reset").font(.caption2).foregroundStyle(.secondary)
                } else if let resets = Fmt.resets(limit.resetsAt) {
                    Text(resets).font(.caption2).foregroundStyle(.secondary)
                }
                Text("\(Int(pct.rounded()))%").font(.callout.monospacedDigit().weight(.semibold))
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.primary.opacity(0.1))
                    Capsule().fill(limitColor(pct)).frame(width: max(pct > 0 ? 3 : 0, geo.size.width * min(pct, 100) / 100))
                }
            }
            .frame(height: 6)
        }
    }

    private var title: String {
        switch limit.kind {
        case "session", "five_hour": return "5-hour session"
        case "weekly_all", "seven_day": return "Weekly · all models"
        default:
            if let label = limit.label, label.hasPrefix("weekly") { return "Weekly" + label.dropFirst("weekly".count) }
            return limit.label ?? limit.kind ?? "Limit"
        }
    }
}

/// Every limit bar: green below 50%, yellow from 50%, red from 75%.
func limitColor(_ pct: Double) -> Color {
    pct >= 75 ? .red : pct >= 50 ? .yellow : .green
}

struct Stat: View {
    let label: String
    let value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label).font(.caption).foregroundStyle(.secondary)
            Text(value).font(.title3.monospacedDigit().weight(.semibold))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// One list for the menu and the window: nudges standing now (a threshold you
/// set was crossed) first, then recommendations, strongest first.
struct AttentionItem {
    let headline: String
    let detail: String?
    let action: String?
    let color: Color
    let source: String

    static func all(_ status: Status) -> [AttentionItem] {
        let nudges = (status.nudges ?? []).map { n in
            AttentionItem(
                headline: n.label ?? n.id ?? "",
                detail: n.detail,
                action: n.action,
                color: n.urgent == true ? .red : .orange,
                source: "A threshold you set in Notifications"
            )
        }
        let recs = (status.recommendations ?? []).compactMap { r -> AttentionItem? in
            guard let line = r.line else { return nil }
            return AttentionItem(
                headline: line,
                detail: nil,
                action: r.action,
                color: .blue,
                source: r.source == "claude-code" ? "Claude Code's own /usage report" : "Measured by Marmot from your session files"
            )
        }
        return nudges + recs
    }
}

struct MenuRow: View {
    let title: String
    let systemImage: String
    var shortcut: String? = nil
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Image(systemName: systemImage).frame(width: 16)
                Text(title)
                Spacer()
                if let shortcut {
                    Text(shortcut).foregroundStyle(hovering ? Color.white.opacity(0.8) : Color.secondary)
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .foregroundStyle(hovering ? Color.white : Color.primary)
            .background(RoundedRectangle(cornerRadius: 5).fill(hovering ? Color.accentColor : Color.clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
    }
}
