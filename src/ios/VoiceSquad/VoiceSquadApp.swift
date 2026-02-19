import SwiftUI

@main
struct VoiceSquadApp: App {
    @StateObject private var settings = AppSettings()
    @StateObject private var webSocket = WebSocketClient()
    @StateObject private var liveActivity = LiveActivityManager()
    @StateObject private var notifications = NotificationManager()

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
                notifications.requestPermission()
                liveActivity.startActivity()
            }
            .onReceive(webSocket.$lastSpeakText) { text in
                guard let text else { return }
                liveActivity.updateActivity(text: text, isConnected: webSocket.isConnected)
                if scenePhase != .active {
                    notifications.postSpeakNotification(text: text)
                }
            }
            .onReceive(webSocket.$isConnected) { connected in
                if !connected {
                    liveActivity.updateActivity(text: "Disconnected", isConnected: false)
                }
            }
            .onChange(of: scenePhase) { _, newPhase in
                if newPhase == .active {
                    liveActivity.startActivity()
                }
            }
        }
    }
}
