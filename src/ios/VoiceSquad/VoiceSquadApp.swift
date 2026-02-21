import SwiftUI
import UIKit
import OSLog
import UserNotifications

@main
struct VoiceSquadApp: App {
    @StateObject private var settings = AppSettings()
    @StateObject private var webSocket = WebSocketClient()
    @StateObject private var liveActivity = LiveActivityManager.shared
    @StateObject private var notifications = NotificationManager()
    @State private var silentAudio = SilentAudioPlayer()
    @State private var speechAudio = SpeechAudioPlayer()
    @State private var disconnectStartedAt: Date?
    @State private var disconnectEvaluationTask: Task<Void, Never>?
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    @Environment(\.scenePhase) private var scenePhase
    private let logger = Logger(subsystem: "com.voicesquad.app", category: "Lifecycle")

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
                notifications.requestPermission()
                liveActivity.startActivityIfNeeded()
                silentAudio.start()
                ensureWebSocketConnected(reason: "app_appear")
            }
            .onDisappear {
                disconnectEvaluationTask?.cancel()
                silentAudio.stop()
            }
            .onReceive(webSocket.$lastIncomingTextMessage) { message in
                guard let message else { return }
                liveActivity.handleWebSocketMessage(message)
            }
            .onReceive(webSocket.$lastIncomingAudioData) { audioData in
                guard let audioData else { return }
                speechAudio.enqueue(audioData)
            }
            .onReceive(webSocket.$lastSpeakText) { text in
                guard let text else { return }
                if scenePhase != .active {
                    notifications.postSpeakNotification(text: text)
                }
            }
            .onReceive(webSocket.$isConnected) { connected in
                if connected {
                    disconnectStartedAt = nil
                    disconnectEvaluationTask?.cancel()
                    return
                }
                disconnectStartedAt = Date()
                scheduleDisconnectEvaluation(reason: "socket_disconnected")
            }
            .onChange(of: scenePhase) { _, newPhase in
                logger.info("Scene phase changed to \(scenePhaseLabel(newPhase), privacy: .public)")
                switch newPhase {
                case .active:
                    liveActivity.startActivityIfNeeded()
                    silentAudio.start()
                    ensureWebSocketConnected(reason: "scene_active")
                    if disconnectStartedAt != nil {
                        scheduleDisconnectEvaluation(reason: "scene_active_recheck")
                    }
                case .inactive, .background:
                    // Keep silent audio running to maintain background activity.
                    silentAudio.start()
                    if disconnectStartedAt != nil {
                        scheduleDisconnectEvaluation(reason: "scene_background_recheck")
                    }
                @unknown default:
                    break
                }
            }
        }
    }

    private func ensureWebSocketConnected(reason: String) {
        guard let url = settings.makeWebSocketURL() else { return }
        webSocket.ensureConnected(url: url, reason: reason)
    }

    private func currentRuntimeState() -> AppRuntimeState {
        switch scenePhase {
        case .active:
            return .active
        case .inactive:
            return .inactive
        case .background:
            return .background
        @unknown default:
            return .inactive
        }
    }

    private func scheduleDisconnectEvaluation(reason: String) {
        guard let disconnectStartedAt else { return }
        disconnectEvaluationTask?.cancel()
        let runtimeState = currentRuntimeState()
        let grace = ConnectionTransitionPolicy.disconnectGrace(for: runtimeState)
        logger.info("Scheduling disconnect evaluation reason=\(reason, privacy: .public) state=\(String(describing: runtimeState), privacy: .public) grace=\(grace, privacy: .public)s")
        disconnectEvaluationTask = Task {
            try? await Task.sleep(nanoseconds: UInt64(grace * 1_000_000_000))
            guard !Task.isCancelled else { return }
            await MainActor.run {
                guard let activeDisconnectStartedAt = self.disconnectStartedAt else { return }
                let state = self.currentRuntimeState()
                if ConnectionTransitionPolicy.shouldMarkDisconnected(
                    disconnectStartedAt: activeDisconnectStartedAt,
                    runtimeState: state,
                    isConnected: self.webSocket.isConnected
                ) {
                    self.logger.info("Publishing disconnected live activity state after grace window")
                    self.liveActivity.updateActivity(with: .init(
                        latestSpeechText: "Disconnected",
                        isConnected: false,
                        activityID: nil
                    ))
                }
            }
        }
    }

    private func scenePhaseLabel(_ phase: ScenePhase) -> String {
        switch phase {
        case .active:
            return "active"
        case .inactive:
            return "inactive"
        case .background:
            return "background"
        @unknown default:
            return "unknown"
        }
    }
}

final class AppDelegate: NSObject, @preconcurrency UIApplicationDelegate, UNUserNotificationCenterDelegate {
    private let logger = Logger(subsystem: "com.voicesquad.app", category: "Push")

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

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
        logger.info("Received remote notification while appState=\(application.applicationState.rawValue, privacy: .public)")
        let handled = await LiveActivityManager.shared.handleRemoteNotification(userInfo)
        if !handled {
            logger.debug("Remote notification did not contain a live activity update")
        }
        return handled ? .newData : .noData
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        logger.info("Will present notification while app is foregrounded")
        Task {
            let handled = await LiveActivityManager.shared.handleRemoteNotification(notification.request.content.userInfo)
            if handled {
                logger.debug("Foreground notification applied to live activity")
            }
        }
        completionHandler([.banner, .list, .sound])
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        logger.info("User interacted with notification id=\(response.notification.request.identifier, privacy: .public)")
        Task {
            let handled = await LiveActivityManager.shared.handleRemoteNotification(response.notification.request.content.userInfo)
            if handled {
                logger.debug("Notification response payload applied to live activity")
            }
            completionHandler()
        }
    }
}
