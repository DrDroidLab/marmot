import Charts
import SwiftUI

/// Cost or tokens per local day, oldest to today, for the menu.
struct UsageChart: View {
    let days: [Day]
    let today: String?
    let metric: String
    @State private var selection: Date?

    static let bar = Color(red: 0.72, green: 0.48, blue: 0.29)
    static let highlight = Color(red: 0.94, green: 0.74, blue: 0.43)

    struct Point: Identifiable {
        let date: Date
        let day: Day
        var id: String { day.day }
    }

    private var points: [Point] {
        days.compactMap { d in Fmt.localDay(d.day).map { Point(date: $0, day: d) } }
    }

    var body: some View {
        let pts = points
        let peak = pts.max { $0.day.value(metric) < $1.day.value(metric) }
        let selected = selection.flatMap { s in pts.first { Calendar.current.isDate($0.date, inSameDayAs: s) } }

        VStack(alignment: .leading, spacing: 4) {
            Chart {
                ForEach(pts) { p in
                    BarMark(
                        x: .value("Day", p.date, unit: .day),
                        y: .value(metric == "tokens" ? "Tokens" : "Cost", p.day.value(metric))
                    )
                    .foregroundStyle(p.day.day == today ? Self.highlight : Self.bar)
                    .opacity(selected == nil || selected?.id == p.id ? 1 : 0.4)
                    .cornerRadius(2)
                }
            }
            .chartXAxis(.hidden)
            .chartYAxis {
                AxisMarks(position: .trailing, values: .automatic(desiredCount: 3)) { value in
                    AxisGridLine().foregroundStyle(Color.primary.opacity(0.08))
                    AxisValueLabel {
                        if let v = value.as(Double.self) {
                            Text(Fmt.axis(v, metric: metric)).font(.system(size: 9))
                        }
                    }
                }
            }
            .chartXSelection(value: $selection)
            .frame(height: 76)

            VStack(alignment: .leading, spacing: 2) {
                if let selected {
                    Text("\(Fmt.dayLabel(selected.date)) · \(Fmt.usd(selected.day.cost ?? 0)) · \(Fmt.tokens(selected.day.tokens ?? 0)) tokens")
                        .foregroundStyle(.primary)
                } else {
                    HStack {
                        Text(Fmt.dayLabel(pts.first?.day.day))
                        Spacer()
                        if let peak, peak.day.value(metric) > 0 {
                            Text("peak \(Fmt.dayLabel(peak.date)) · \(Fmt.metric(peak.day.value(metric), metric))")
                        }
                        Spacer()
                        Text("today")
                    }
                }
                Text(modelsLine(selected ?? peak))
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            .font(.caption2)
            .foregroundStyle(.secondary)
            .frame(height: 28, alignment: .top)
        }
    }

    private func modelsLine(_ point: Point?) -> String {
        guard let models = point?.day.models, !models.isEmpty else { return " " }
        return models
            .sorted { $0.value(metric) > $1.value(metric) }
            .prefix(3)
            .map { "\(Fmt.shortModel($0.model)) \(Fmt.metric($0.value(metric), metric))" }
            .joined(separator: " · ")
    }
}
