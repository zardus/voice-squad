import UserNotifications
import Foundation
import UIKit

/// Time-windowed deduplication for notification content.
/// Prevents the same text from triggering repeated notifications
/// (e.g., on WebSocket reconnection cycles).
struct NotificationDedup {
    private(set) var lastText: String?
    private(set) var lastTime: Date?
    let windowSeconds: TimeInterval
    private let nowProvider: () -> Date

    init(windowSeconds: TimeInterval = 300, nowProvider: @escaping () -> Date = Date.init) {
        self.windowSeconds = windowSeconds
        self.nowProvider = nowProvider
    }

    /// Returns `true` if the text should be posted (not a duplicate within the window).
    mutating func shouldPost(text: String) -> Bool {
        let now = nowProvider()
        if let lastText, lastText == text,
           let lastTime, now.timeIntervalSince(lastTime) < windowSeconds {
            return false
        }
        lastText = text
        lastTime = now
        return true
    }

    mutating func reset() {
        lastText = nil
        lastTime = nil
    }
}

@MainActor
final class NotificationManager: ObservableObject {
    private var dedup = NotificationDedup()

    func requestPermission() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
        UIApplication.shared.registerForRemoteNotifications()
    }

    /// Posts a speak notification, returning `true` if posted or `false` if deduplicated.
    @discardableResult
    func postSpeakNotification(text: String) -> Bool {
        guard dedup.shouldPost(text: text) else { return false }

        let content = UNMutableNotificationContent()
        content.title = "VoiceSquad"
        content.body = text
        content.sound = .default

        // Use a stable identifier so iOS replaces any pending speak notification
        // instead of stacking duplicates.
        let request = UNNotificationRequest(
            identifier: "voicesquad-speak-latest",
            content: content,
            trigger: nil
        )
        UNUserNotificationCenter.current().add(request)
        return true
    }

    func resetDedup() {
        dedup.reset()
    }
}
