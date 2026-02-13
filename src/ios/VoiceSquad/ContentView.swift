import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var settings: AppSettings
    @EnvironmentObject private var webSocket: WebSocketClient
    @EnvironmentObject private var audio: AudioManager

    @State private var showSettings = false
    @State private var webViewID = UUID()

    var body: some View {
        ZStack(alignment: .bottom) {
            VoiceSquadWebView(url: settings.makeWebURL(), webViewID: webViewID)
                .ignoresSafeArea(.all, edges: .top)

            NativeControlBar(
                autoRead: $settings.autoRead,
                isConnected: webSocket.isConnected,
                isRecording: audio.isRecording,
                onToggleRecording: {
                    if audio.isRecording {
                        Task { await audio.stopAndSend(webSocket: webSocket) }
                    } else {
                        audio.startRecording()
                    }
                },
                onSendText: { text in
                    webSocket.sendTextCommand(text)
                }
            )
        }
        .safeAreaInset(edge: .top) {
            HStack {
                Text("VoiceSquad")
                    .font(.headline)
                Spacer()
                Button {
                    showSettings = true
                } label: {
                    Image(systemName: "gearshape")
                        .font(.headline)
                }
                .accessibilityLabel("Settings")
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(.ultraThinMaterial)
        }
        .sheet(isPresented: $showSettings) {
            SettingsView(
                serverBaseURL: $settings.serverBaseURL,
                token: $settings.token
            )
        }
        .onAppear {
            audio.autoReadEnabled = { settings.autoRead }
            connectWebSocket()
        }
        .onChange(of: settings.autoRead) { _, newValue in
            settings.persist()
            settings.webBridge?.setAutoread(newValue)
        }
        .onChange(of: settings.serverBaseURL) { _, _ in
            settings.persist()
        }
        .onChange(of: settings.token) { _, _ in
            settings.persist()
        }
        .onChange(of: settings.serverBaseURL) { _, _ in
            reconnectAll()
        }
        .onChange(of: settings.token) { _, _ in
            reconnectAll()
        }
        .onReceive(webSocket.$lastTtsAudioData) { data in
            guard let data else { return }
            audio.handleIncomingTtsAudio(data)
        }
    }

    private func connectWebSocket() {
        guard let url = settings.makeWebSocketURL(tts: "mp3") else { return }
        webSocket.connect(url: url)
    }

    private func reconnectAll() {
        webSocket.disconnect()
        connectWebSocket()
        webViewID = UUID()
    }
}

private struct SettingsView: View {
    @Binding var serverBaseURL: String
    @Binding var token: String

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section("Server") {
                    TextField("Base URL (e.g. https://xxxx.trycloudflare.com)", text: $serverBaseURL)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.URL)
                        .autocorrectionDisabled()
                }
                Section("Auth") {
                    TextField("Token", text: $token)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }
            }
            .navigationTitle("Settings")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}

