import Foundation

// Mirrors `marmot status --json`. Every field is optional: a missing one costs
// a row in the menu, never the menu.

struct Status: Decodable {
    var version: Int?
    var generatedAt: String?
    var demo: Bool?
    var plan: Plan?
    var limits: [Limit]?
    var spend: Spend?
    var today: Today?
    var window: WindowTotals?
    var daily: [Day]?
    var models: [ModelShare]?
    var recommendations: [Recommendation]?
    var nudges: [Nudge]?
    var recent: [RecentNudge]?
    var hooks: Hooks?
    var paths: Paths?

    var usableLimits: [Limit] { (limits ?? []).filter { $0.usable ?? !($0.expired ?? false) } }
    var tightestLimit: Limit? { usableLimits.max { ($0.percent ?? 0) < ($1.percent ?? 0) } }
}

struct Plan: Decodable {
    var name: String?
    var paysPerToken: Bool?
    var fetchedAt: Double?
    var ageMins: Double?
    var stale: Bool?
}

struct Limit: Decodable, Identifiable {
    var kind: String?
    var label: String?
    var percent: Double?
    var resetsAt: String?
    var expired: Bool?
    var usable: Bool?
    var pace: Pace?

    var id: String { (kind ?? "") + (label ?? "") }
}

struct Pace: Decodable {
    var pace: Double?
    var elapsedPct: Double?
    var exhaustsBeforeReset: Bool?
    var exhaustsInMins: Double?
}

struct Spend: Decodable {
    var used: Double?
    var limit: Double?
    var currency: String?
    var enabled: Bool?
}

struct Today: Decodable {
    var day: String?
    var cost: Double?
    var tokens: Double?
    var sessions: Int?
    var prompts: Int?
}

struct WindowTotals: Decodable {
    var days: Int?
    var cost: Double?
    var tokens: Double?
    var sessions: Int?
    var prompts: Int?
    var cacheHitRate: Double?
}

struct Day: Decodable, Identifiable {
    var day: String
    var cost: Double?
    var tokens: Double?
    var id: String { day }
}

struct ModelShare: Decodable, Identifiable {
    var model: String
    var cost: Double?
    var tokens: Double?
    var share: Double?
    var id: String { model }
}

struct Recommendation: Decodable {
    var id: String?
    var line: String?
    var action: String?
    var score: Double?
    var source: String?
}

struct Nudge: Decodable {
    var id: String?
    var key: String?
    var label: String?
    var detail: String?
    var action: String?
    var urgent: Bool?
}

struct RecentNudge: Decodable {
    var at: String?
    var event: String?
    var labels: [String]?
}

struct Hooks: Decodable {
    var installed: Bool?
    var missing: [String]?
    var plugin: Bool?
}

struct Paths: Decodable {
    var config: String?
    var configExists: Bool?
    var root: String?
}

// `marmot tick --json --app`
struct TickResult: Decodable {
    var version: Int?
    var notifications: [EngineNotification]?
    var held: Int?
}

struct EngineNotification: Decodable {
    var id: String?
    var key: String?
    var title: String?
    var body: String?
    var urgent: Bool?
    var kind: String?
    var source: String?
    var at: String?
}

// `marmot refresh-limits --json`
struct RefreshResult: Decodable {
    var refreshed: Bool?
    var fetchedAt: Double?
    var reason: String?
}

// MARK: - config, which is free-form JSON

enum ConfigPath {
    static func value(_ config: [String: Any], _ path: String) -> Any? {
        var node: Any? = config
        for key in path.split(separator: ".").map(String.init) {
            guard let dict = node as? [String: Any] else { return nil }
            node = dict[key]
        }
        return node
    }

    static func setting(_ config: [String: Any], _ path: [String], _ value: Any) -> [String: Any] {
        guard let first = path.first else { return config }
        var copy = config
        if path.count == 1 {
            copy[first] = value
        } else {
            let child = copy[first] as? [String: Any] ?? [:]
            copy[first] = setting(child, Array(path.dropFirst()), value)
        }
        return copy
    }

    /// The value as `config set` wants it: JSON, so numbers, booleans and arrays mean themselves.
    static func encode(_ value: Any) -> String {
        if let data = try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed]),
           let text = String(data: data, encoding: .utf8) {
            return text
        }
        return "\(value)"
    }
}

// MARK: - formatting

enum Fmt {
    private static let currency: NumberFormatter = {
        let f = NumberFormatter()
        f.numberStyle = .currency
        f.currencyCode = "USD"
        f.locale = Locale(identifier: "en_US")
        f.maximumFractionDigits = 2
        f.minimumFractionDigits = 2
        return f
    }()

    static func usd(_ value: Double?) -> String {
        guard let value else { return "—" }
        return currency.string(from: NSNumber(value: value)) ?? String(format: "$%.2f", value)
    }

    /// For the menu bar, where every character is width.
    static func usdShort(_ value: Double) -> String {
        value >= 1000 ? String(format: "$%.1fK", value / 1000) : value >= 100 ? String(format: "$%.0f", value) : String(format: "$%.2f", value)
    }

    static func tokens(_ value: Double?) -> String {
        guard let v = value else { return "—" }
        func trim(_ n: Double, _ suffix: String) -> String {
            n < 10 ? String(format: "%.1f%@", n, suffix) : String(format: "%.0f%@", n, suffix)
        }
        if v >= 1e9 { return trim(v / 1e9, "B") }
        if v >= 1e6 { return trim(v / 1e6, "M") }
        if v >= 1e3 { return trim(v / 1e3, "K") }
        return String(format: "%.0f", v)
    }

    static func duration(mins: Double) -> String {
        let m = max(0, Int(mins.rounded()))
        if m < 60 { return "\(m)m" }
        let h = m / 60
        if h < 48 { return m % 60 == 0 ? "\(h)h" : "\(h)h \(m % 60)m" }
        let d = h / 24
        return h % 24 == 0 ? "\(d)d" : "\(d)d \(h % 24)h"
    }

    /// Accepts Python-style timestamps with six fractional digits, which
    /// ISO8601DateFormatter refuses.
    static func date(_ iso: String?) -> Date? {
        guard var s = iso, !s.isEmpty else { return nil }
        if let dot = s.firstIndex(of: "."), let end = s[dot...].firstIndex(where: { $0 == "Z" || $0 == "+" || $0 == "-" }) {
            s.removeSubrange(dot..<end)
        } else if let dot = s.firstIndex(of: ".") {
            s.removeSubrange(dot..<s.endIndex)
            s += "Z"
        }
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: s)
    }

    static func resets(_ iso: String?) -> String? {
        guard let date = date(iso) else { return nil }
        let mins = date.timeIntervalSinceNow / 60
        return mins <= 0 ? "resets shortly" : "resets in \(duration(mins: mins))"
    }

    static func time(_ iso: String?) -> String {
        guard let date = date(iso) else { return iso ?? "" }
        let f = DateFormatter()
        f.dateFormat = Calendar.current.isDateInToday(date) ? "HH:mm" : "d MMM HH:mm"
        return f.string(from: date)
    }

    static func shortModel(_ model: String) -> String {
        model.hasPrefix("claude-") ? String(model.dropFirst("claude-".count)) : model
    }
}
