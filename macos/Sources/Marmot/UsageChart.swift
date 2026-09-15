import Charts
import SwiftUI

/// Modelled cost per day, oldest to today.
struct UsageChart: View {
    let days: [Day]
    let today: String?

    private static let bar = Color(red: 0.72, green: 0.48, blue: 0.29)
    private static let highlight = Color(red: 0.94, green: 0.74, blue: 0.43)

    var body: some View {
        let peak = days.max { ($0.cost ?? 0) < ($1.cost ?? 0) }
        VStack(alignment: .leading, spacing: 3) {
            Chart(days) { day in
                BarMark(
                    x: .value("Day", day.day),
                    y: .value("Cost", day.cost ?? 0)
                )
                .foregroundStyle(day.day == today ? Self.highlight : Self.bar)
                .cornerRadius(2)
            }
            .chartXAxis(.hidden)
            .chartYAxis(.hidden)
            .frame(height: 56)

            HStack {
                Text(label(days.first?.day))
                Spacer()
                if let peak, (peak.cost ?? 0) > 0 {
                    Text("peak \(label(peak.day)) · \(Fmt.usd(peak.cost))")
                }
                Spacer()
                Text("today")
            }
            .font(.caption2)
            .foregroundStyle(.secondary)
        }
    }

    private func label(_ day: String?) -> String {
        guard let day, let date = Fmt.date("\(day)T12:00:00Z") else { return day ?? "" }
        let f = DateFormatter()
        f.dateFormat = "d MMM"
        return f.string(from: date)
    }
}
