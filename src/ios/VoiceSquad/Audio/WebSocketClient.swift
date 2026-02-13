import Foundation

@MainActor
final class WebSocketClient: ObservableObject {
    @Published private(set) var isConnected: Bool = false
    @Published private(set) var lastTranscription: String?
    @Published private(set) var lastSummaryText: String?
    @Published var lastTtsAudioData: Data?

    private var task: URLSessionWebSocketTask?
    private var url: URL?

    private var expectingTtsAudio = false

    func connect(url: URL) {
        self.url = url
        disconnect()

        let session = URLSession(configuration: .default)
        let task = session.webSocketTask(with: url)
        self.task = task
        task.resume()
        isConnected = true

        receiveLoop()
    }

    func disconnect() {
        isConnected = false
        expectingTtsAudio = false
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
    }

    func sendTextCommand(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        sendJSON(["type": "text_command", "text": trimmed])
    }

    func sendAudioStart(mimeType: String) {
        sendJSON(["type": "audio_start", "mimeType": mimeType])
    }

    func sendAudioChunk(_ data: Data) {
        guard let task else { return }
        task.send(.data(data)) { _ in }
    }

    func sendAudioEnd() {
        sendJSON(["type": "audio_end"])
    }

    private func sendJSON(_ obj: [String: Any]) {
        guard let task else { return }
        guard let data = try? JSONSerialization.data(withJSONObject: obj),
              let s = String(data: data, encoding: .utf8) else { return }
        task.send(.string(s)) { _ in }
    }

    private func receiveLoop() {
        guard let task else { return }
        task.receive { [weak self] result in
            guard let self else { return }
            Task { @MainActor in
                switch result {
                case .failure:
                    self.isConnected = false
                case .success(let msg):
                    switch msg {
                    case .string(let s):
                        self.handleTextMessage(s)
                    case .data(let d):
                        self.handleBinaryMessage(d)
                    @unknown default:
                        break
                    }
                    self.receiveLoop()
                }
            }
        }
    }

    private func handleTextMessage(_ s: String) {
        guard let data = s.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = json["type"] as? String else { return }

        switch type {
        case "connected":
            isConnected = true
        case "transcribing":
            lastTranscription = "Transcribing..."
        case "transcription":
            lastTranscription = json["text"] as? String
        case "stt_error":
            lastTranscription = json["message"] as? String
        case "speak_text":
            lastSummaryText = json["text"] as? String
            expectingTtsAudio = true
        case "tts_config":
            // Informational; the iOS client always requests mp3.
            break
        default:
            break
        }
    }

    private func handleBinaryMessage(_ data: Data) {
        // For VoiceSquad, the audio is a raw binary frame that follows speak_text.
        if expectingTtsAudio {
            expectingTtsAudio = false
            lastTtsAudioData = data
        }
    }
}

