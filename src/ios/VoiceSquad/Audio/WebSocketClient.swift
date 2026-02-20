import Foundation

@MainActor
final class WebSocketClient: ObservableObject {
    @Published private(set) var isConnected: Bool = false
    @Published private(set) var lastSpeakText: String?

    private var task: URLSessionWebSocketTask?
    private var url: URL?

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
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
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
                    case .data:
                        break // ignore binary TTS frames
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
            if let text = json["lastSpeakText"] as? String {
                lastSpeakText = text
            }
        case "speak_text":
            lastSpeakText = json["text"] as? String
        default:
            break
        }
    }
}
