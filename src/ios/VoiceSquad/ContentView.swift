import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var settings: AppSettings
    @EnvironmentObject private var webSocket: WebSocketClient

    @State private var showSettings = false
    @State private var webViewID = UUID()
    @State private var autoReadEnabled = UserDefaults.autoReadIsEnabled()

    var body: some View {
        ZStack {
            VoiceSquadWebView(url: settings.makeWebURL(), webViewID: webViewID, autoReadEnabled: $autoReadEnabled)
                .ignoresSafeArea()

            VStack {
                HStack {
                    Spacer()
                    Button {
                        showSettings = true
                    } label: {
                        Image(systemName: "gearshape.fill")
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(.white)
                            .frame(width: 36, height: 36)
                            .background(.black.opacity(0.5), in: Circle())
                    }
                    .padding(.top, 54)
                    .padding(.trailing, 12)
                    .accessibilityLabel("Settings")
                }
                Spacer()
            }
        }
        .sheet(isPresented: $showSettings) {
            SettingsView(
                serverBaseURL: $settings.serverBaseURL,
                token: $settings.token
            )
        }
        .onAppear {
            connectWebSocket()
        }
        .onChange(of: settings.serverBaseURL) { _, _ in
            settings.persist()
            reconnectAll()
        }
        .onChange(of: settings.token) { _, _ in
            settings.persist()
            reconnectAll()
        }
    }

    private func connectWebSocket() {
        guard let url = settings.makeWebSocketURL() else { return }
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
    @State private var showScanner = false

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
                Section {
                    Button {
                        showScanner = true
                    } label: {
                        Label("Scan QR Code", systemImage: "qrcode.viewfinder")
                    }
                }
            }
            .navigationTitle("Settings")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .fullScreenCover(isPresented: $showScanner) {
                QRScannerView { baseURL, scannedToken in
                    serverBaseURL = baseURL
                    token = scannedToken
                    showScanner = false
                }
                .ignoresSafeArea()
            }
        }
    }
}
