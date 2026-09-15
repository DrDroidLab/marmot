import AppKit
import SwiftUI

/// The "alert" style: a floating card with the marmot that stays until dismissed.
/// It does what `display dialog` did for the CLI, without stealing focus.
@MainActor
final class AlertPanels {
    static let shared = AlertPanels()
    private var panels: [NSPanel] = []

    func show(title: String, body: String) {
        let panel = KeyablePanel(
            contentRect: NSRect(x: 0, y: 0, width: 380, height: 120),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.hidesOnDeactivate = false

        let card = AlertCard(title: title, message: body) { [weak self, weak panel] in
            guard let self, let panel else { return }
            self.close(panel)
        } open: {
            Store.shared.openBrowser()
        }
        let host = NSHostingView(rootView: card)
        host.frame = NSRect(x: 0, y: 0, width: 380, height: 10)
        let size = host.fittingSize
        host.frame = NSRect(x: 0, y: 0, width: 380, height: size.height)
        panel.setContentSize(NSSize(width: 380, height: size.height))
        panel.contentView = host

        panels.append(panel)
        layout()
        panel.orderFrontRegardless()
    }

    private func close(_ panel: NSPanel) {
        panel.orderOut(nil)
        panels.removeAll { $0 === panel }
        layout()
    }

    private func layout() {
        guard let screen = NSScreen.main?.visibleFrame else { return }
        var top = screen.maxY - 12
        for panel in panels {
            let frame = panel.frame
            let origin = NSPoint(x: screen.maxX - frame.width - 12, y: top - frame.height)
            panel.setFrameOrigin(origin)
            top = origin.y - 10
        }
    }
}

private final class KeyablePanel: NSPanel {
    override var canBecomeKey: Bool { true }
}

struct AlertCard: View {
    let title: String
    let message: String
    let dismiss: () -> Void
    let open: () -> Void

    private static let marmot: NSImage? = {
        guard let url = Bundle.main.url(forResource: "marmot", withExtension: "png") else { return nil }
        return NSImage(contentsOf: url)
    }()

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            if let image = Self.marmot {
                Image(nsImage: image).resizable().frame(width: 44, height: 44)
            } else {
                Image(systemName: "exclamationmark.circle.fill").font(.largeTitle).foregroundStyle(.orange)
            }
            VStack(alignment: .leading, spacing: 6) {
                Text(title).font(.headline).fixedSize(horizontal: false, vertical: true)
                Text(message).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                HStack {
                    Button("View session data", action: open).buttonStyle(.link)
                    Spacer()
                    Button("Dismiss", action: dismiss).keyboardShortcut(.defaultAction)
                }
                .padding(.top, 4)
            }
        }
        .padding(14)
        .frame(width: 380, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 14).fill(.regularMaterial))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Color.primary.opacity(0.1)))
    }
}
