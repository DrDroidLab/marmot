import AppKit
import SwiftUI

@main
@MainActor
struct MarmotApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @ObservedObject private var store = Store.shared

    var body: some Scene {
        MenuBarExtra {
            MenuView()
                .environmentObject(store)
        } label: {
            MenuBarLabel()
                .environmentObject(store)
        }
        .menuBarExtraStyle(.window)

        Settings {
            SettingsView()
                .environmentObject(store)
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        Notifier.shared.setup()
        Store.shared.start()
    }
}

/// The item in the menu bar: the marmot, and the one number worth seeing.
struct MenuBarLabel: View {
    @EnvironmentObject var store: Store
    @AppStorage("menuBarDisplay") private var display = "percent"
    @AppStorage("menuBarLimit") private var whichLimit = "both"

    var body: some View {
        HStack(spacing: 3) {
            MenuBarIcon()
            if let text = labelText {
                Text(text).monospacedDigit()
            }
        }
    }

    private var labelText: String? {
        guard let status = store.status else { return nil }
        let pct = limitText(status)
        let cost = status.today?.cost.map { Fmt.usdShort($0) }
        switch display {
        case "icon": return nil
        case "cost": return cost
        case "both":
            let parts = [pct, cost].compactMap { $0 }
            return parts.isEmpty ? nil : parts.joined(separator: " · ")
        default: return pct ?? cost
        }
    }

    /// Which limit the menu bar quotes: the 5-hour session, the week, both, or
    /// whichever is highest.
    private func limitText(_ status: Status) -> String? {
        let usable = status.usableLimits
        let pct = { (l: Limit) in "\(Int(l.percent?.rounded() ?? 0))%" }
        let session = usable.first { ["session", "five_hour"].contains($0.kind ?? "") }
        let weekly = usable.first { ["weekly_all", "seven_day"].contains($0.kind ?? "") }
        switch whichLimit {
        case "session": return (session ?? status.tightestLimit).map(pct)
        case "weekly": return (weekly ?? status.tightestLimit).map(pct)
        case "highest": return status.tightestLimit.map(pct)
        default:
            let parts = [session.map { "5h \(pct($0))" }, weekly.map { "W \(pct($0))" }].compactMap { $0 }
            return parts.isEmpty ? status.tightestLimit.map(pct) : parts.joined(separator: " · ")
        }
    }
}

struct MenuBarIcon: View {
    var body: some View {
        if let image = Self.templateImage {
            Image(nsImage: image)
        } else {
            Image(systemName: "gauge.with.dots.needle.33percent")
        }
    }

    static let templateImage: NSImage? = {
        guard let url = Bundle.main.url(forResource: "marmot-menubar", withExtension: "png"),
              let image = NSImage(contentsOf: url) else { return nil }
        image.size = NSSize(width: 18, height: 18)
        image.isTemplate = true
        return image
    }()
}
