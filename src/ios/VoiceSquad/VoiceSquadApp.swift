import SwiftUI

@main
struct VoiceSquadApp: App {
    @StateObject private var settings = AppSettings()
    @StateObject private var webSocket = WebSocketClient()
    @StateObject private var audio = AudioManager()
    @StateObject private var remote = RemoteControls()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(settings)
                .environmentObject(webSocket)
                .environmentObject(audio)
                .onAppear {
                    // Wire RemoteCommandCenter actions to the same recording toggle as the UI.
                    remote.onToggleRecording = { [weak audio, weak webSocket, weak settings] in
                        guard let audio, let webSocket, let settings else { return }
                        if audio.isRecording {
                            Task { await audio.stopAndSend(webSocket: webSocket) }
                        } else {
                            audio.startRecording()
                        }
                        // Keep the web UI preference in sync (even though the web controls are hidden).
                        settings.webBridge?.setAutoread(settings.autoRead)
                    }
                }
        }
    }
}

