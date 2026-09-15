import AppKit
import Foundation
import UserNotifications

/// Delivers what the engine decided to say. Deciding *whether* to say it —
/// dedupe, quiet gaps, marks — already happened in Node.
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    static let shared = Notifier()

    /// UNUserNotificationCenter crashes outside an .app bundle.
    var isBundled: Bool { Bundle.main.bundleURL.pathExtension == "app" }

    func setup() {
        guard isBundled else { return }
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
    }

    /// Mirrors `notifyStyle()` in src/notify.mjs, including treating a typo as the default.
    static func style(config: [String: Any], urgent: Bool, kind: String) -> String {
        let raw = ConfigPath.value(config, "notify.style")
        let s = (raw as? String) ?? ((raw as? [String: Any])?[kind] as? String)
        if s == "banner" { return "banner" }
        if s == "auto" { return urgent ? "alert" : "banner" }
        return "alert"
    }

    @MainActor
    func deliver(_ n: EngineNotification, config: [String: Any]) {
        if (ConfigPath.value(config, "notify.desktop") as? Bool) == false { return }
        let title = n.title ?? "Marmot"
        let body = n.body ?? ""
        let sound = (ConfigPath.value(config, "notify.bell") as? Bool) != false
        let style = Self.style(config: config, urgent: n.urgent == true, kind: n.kind ?? "nudge")

        post(title: title, body: body, sound: sound && style == "banner", id: n.key ?? n.id)
        if style == "alert" {
            AlertPanels.shared.show(title: title, body: body)
            if sound, let name = ConfigPath.value(config, "notify.sound") as? String {
                (NSSound(named: NSSound.Name(name)) ?? NSSound(named: NSSound.Name("Ping")))?.play()
            }
        }
    }

    @MainActor
    func sendTest(config: [String: Any]) {
        deliver(
            EngineNotification(
                id: "test",
                key: "test-\(UUID().uuidString)",
                title: "Marmot · 75% of your weekly limit",
                body: "75% of your weekly limit is gone on Max 20×. It resets in 2.1d.\n\nRun /compact, or start a new session for the next distinct piece of work.",
                urgent: false,
                kind: "nudge",
                source: "test",
                at: nil
            ),
            config: config
        )
    }

    private func post(title: String, body: String, sound: Bool, id: String?) {
        guard isBundled else {
            print("[marmot] \(title): \(body)")
            return
        }
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        if sound { content.sound = .default }
        let request = UNNotificationRequest(identifier: "marmot-\(id ?? UUID().uuidString)-\(Int(Date().timeIntervalSince1970))", content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request)
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound, .list])
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        completionHandler()
    }
}
