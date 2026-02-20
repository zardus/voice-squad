import SwiftUI
import UIKit
import OSLog

@main
struct VoiceSquadApp: App {
    @StateObject private var settings = AppSettings()
    @StateObject private var webSocket = WebSocketClient()
    @StateObject private var liveActivity = LiveActivityManager()
    @StateObject private var notifications = NotificationManager()
    @State private var silentAudio = SilentAudioPlayer()
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            Group {
                if settings.serverBaseURL.isEmpty {
                    QRScannerView { baseURL, token in
                        settings.serverBaseURL = baseURL
                        settings.token = token
                        settings.persist()
                    }
                } else {
                    ContentView()
                }
            }
            .environmentObject(settings)
            .environmentObject(webSocket)
            .onAppear {
                appDelegate.liveActivityManager = liveActivity
                notifications.requestPermission()
                liveActivity.startActivityIfNeeded()
                silentAudio.start()
            }
            .onDisappear {
                silentAudio.stop()
            }
            .onReceive(webSocket.$lastIncomingTextMessage) { message in
                guard let message else { return }
                liveActivity.handleWebSocketMessage(message)
            }
            .onReceive(webSocket.$lastSpeakText) { text in
                guard let text else { return }
                if scenePhase != .active {
                    notifications.postSpeakNotification(text: text)
                }
            }
            .onReceive(webSocket.$isConnected) { connected in
                if !connected {
                    liveActivity.updateActivity(with: .init(
                        latestSpeechText: "Disconnected",
                        isConnected: false,
                        activityID: nil
                    ))
                }
            }
            .onChange(of: scenePhase) { _, newPhase in
                switch newPhase {
                case .active:
                    liveActivity.startActivityIfNeeded()
                    silentAudio.start()
                case .inactive, .background:
                    // Keep silent audio running to maintain background activity.
                    break
                @unknown default:
                    break
                }
            }
        }
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate {
    weak var liveActivityManager: LiveActivityManager?
    private let logger = Logger(subsystem: "com.voicesquad.app", category: "Push")

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        logger.info("APNs device token registered (\(token.count, privacy: .public) hex chars)")
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        logger.error("Failed to register APNs device token: \(String(describing: error), privacy: .public)")
    }

    func application(
        _ application: UIApplication,
        didReceiveRemoteNotification userInfo: [AnyHashable: Any]
    ) async -> UIBackgroundFetchResult {
        guard let liveActivityManager else { return .noData }
        let handled = await liveActivityManager.handleRemoteNotification(userInfo)
        return handled ? .newData : .noData
    }
}
