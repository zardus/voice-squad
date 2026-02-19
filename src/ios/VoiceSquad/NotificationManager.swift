import UserNotifications
import Foundation

@MainActor
final class NotificationManager: ObservableObject {
    func requestPermission() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }

    func postSpeakNotification(text: String) {
        let content = UNMutableNotificationContent()
        content.title = "VoiceSquad"
        content.body = text
        content.sound = .default

        let request = UNNotificationRequest(
            identifier: UUID().uuidString,
            content: content,
            trigger: nil
        )
        UNUserNotificationCenter.current().add(request)
    }
}
