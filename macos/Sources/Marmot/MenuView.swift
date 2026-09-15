import AppKit
import SwiftUI

struct MenuView: View {
    @EnvironmentObject var store: Store
    @Environment(\.openSettings) private var openSettings
    @State private var showAllRecs = false

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
                if let nudges = status.nudges, !nudges.isEmpty {
                    divider
                    standing(nudges)
                }
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
            ForEach(usable) { limit in
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
        if days.contains(where: { ($0.cost ?? 0) > 0 }) {
            UsageChart(days: days, today: status.today?.day)
                .padding(.top, 10)
        }
        if let models = status.models, !models.isEmpty {
            Text(models.prefix(3).map { "\(Fmt.shortModel($0.model)) \(Int((($0.share ?? 0) * 100).rounded()))%" }.joined(separator: " · "))
                .font(.caption)
                .foregroundStyle(.secondary)
                .padding(.top, 6)
        }
    }

    // MARK: recommendations

    private func recommendations(_ status: Status) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Recommendations").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            let all = (status.recommendations ?? []).filter { $0.line != nil }
            let recs = showAllRecs ? all : Array(all.prefix(3))
            if all.isEmpty {
                Text("Nothing to fix right now.").font(.callout).foregroundStyle(.secondary)
            }
            ForEach(Array(recs.enumerated()), id: \.offset) { _, rec in
                HStack(alignment: .top, spacing: 8) {
                    Circle().fill(Color.orange).frame(width: 6, height: 6).padding(.top, 6)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(rec.line ?? "").font(.callout).wraps()
                        if let action = rec.action {
                            Text(action).font(.caption).foregroundStyle(.secondary).wraps()
                        }
                    }
                }
            }
            if all.count > 3 {
                Button(showAllRecs ? "Show less" : "Show \(all.count - 3) more") { showAllRecs.toggle() }
                    .buttonStyle(.plain)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(Color.accentColor)
                    .padding(.leading, 14)
            }
        }
    }

    private func standing(_ nudges: [Nudge]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Standing").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            ForEach(Array(nudges.prefix(4).enumerated()), id: \.offset) { _, nudge in
                HStack(alignment: .top, spacing: 8) {
                    Circle().fill(nudge.urgent == true ? Color.red : Color.orange).frame(width: 6, height: 6).padding(.top, 6)
                    Text(nudge.label ?? nudge.id ?? "").font(.callout).wraps()
                }
                .help(nudge.detail ?? "")
            }
        }
    }

    // MARK: footer

    private var footer: some View {
        VStack(spacing: 1) {
            MenuRow(title: "Open session browser", systemImage: "safari") { store.openBrowser() }
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
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(title).font(.callout)
                Spacer()
                Text("\(Int(pct.rounded()))%").font(.callout.monospacedDigit().weight(.semibold))
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.primary.opacity(0.1))
                    Capsule().fill(color(pct)).frame(width: max(pct > 0 ? 3 : 0, geo.size.width * min(pct, 100) / 100))
                }
            }
            .frame(height: 6)
            HStack(spacing: 6) {
                if let resets = Fmt.resets(limit.resetsAt) {
                    Text(resets).font(.caption2).foregroundStyle(.secondary)
                }
                if limit.pace?.exhaustsBeforeReset == true {
                    Text("· faster than it refills").font(.caption2).foregroundStyle(.orange)
                }
            }
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

    private func color(_ pct: Double) -> Color {
        pct >= 80 ? .red : pct >= 50 ? .orange : .green
    }
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
