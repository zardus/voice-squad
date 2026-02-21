import Foundation
import OSLog

@MainActor
final class WebSocketClient: ObservableObject {
    @Published private(set) var isConnected: Bool = false
    @Published private(set) var lastSpeakText: String?
    @Published private(set) var lastIncomingTextMessage: String?
    @Published private(set) var lastIncomingAudioData: Data?

    private var session: URLSession?
    private var task: URLSessionWebSocketTask?
    private var reconnectTask: Task<Void, Never>?
    private var url: URL?
    private var shouldReconnect = false
    private var reconnectAttempt = 0
    private let logger = Logger(subsystem: "com.voicesquad.app", category: "WebSocket")

    func connect(url: URL, reason: String = "manual") {
        self.url = url
        shouldReconnect = true
        reconnectAttempt = 0
        reconnectTask?.cancel()
        teardownActiveSocket()
        openSocket(url: url, reason: reason)
    }

    func ensureConnected(url: URL, reason: String = "ensure_connected") {
        if self.url != url {
            connect(url: url, reason: reason)
            return
        }
        guard task == nil || !isConnected else { return }
        shouldReconnect = true
        openSocket(url: url, reason: reason)
    }

    func disconnect() {
        shouldReconnect = false
        reconnectTask?.cancel()
        reconnectTask = nil
        teardownActiveSocket()
        isConnected = false
        logger.info("WebSocket disconnected by caller")
    }

    private func openSocket(url: URL, reason: String) {
        teardownActiveSocket()
        session = URLSession(configuration: .default)
        guard let session else { return }
        let task = session.webSocketTask(with: url)
        self.task = task
        logger.info("Opening WebSocket (\(reason, privacy: .public))")
        task.resume()
        receiveLoop(for: task)
    }

    private func teardownActiveSocket() {
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        session?.invalidateAndCancel()
        session = nil
    }

    private func receiveLoop(for receiveTask: URLSessionWebSocketTask) {
        receiveTask.receive { [weak self] result in
            guard let self else { return }
            Task { @MainActor in
                guard self.task === receiveTask else { return }
                switch result {
                case .failure(let error):
                    self.handleSocketFailure(error)
                case .success(let msg):
                    if !self.isConnected {
                        self.isConnected = true
                        self.reconnectAttempt = 0
                        self.logger.info("WebSocket connected")
                    }
                    switch msg {
                    case .string(let s):
                        self.handleTextMessage(s)
                    case .data(let data):
                        self.lastIncomingAudioData = data
                    @unknown default:
                        break
                    }
                    self.receiveLoop(for: receiveTask)
                }
            }
        }
    }

    private func handleSocketFailure(_ error: Error) {
        logger.error("WebSocket receive failed: \(String(describing: error), privacy: .public)")
        teardownActiveSocket()
        isConnected = false
        scheduleReconnectIfNeeded()
    }

    private func scheduleReconnectIfNeeded() {
        guard shouldReconnect, let url else { return }
        reconnectTask?.cancel()
        reconnectAttempt += 1
        let delaySeconds = min(pow(2.0, Double(max(0, reconnectAttempt - 1))), 15.0)
        logger.info("Scheduling reconnect attempt=\(self.reconnectAttempt, privacy: .public) delay=\(delaySeconds, privacy: .public)s")
        reconnectTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delaySeconds * 1_000_000_000))
            guard let self else { return }
            guard !Task.isCancelled else { return }
            guard self.task == nil, self.shouldReconnect, let reconnectURL = self.url else { return }
            self.openSocket(url: reconnectURL, reason: "auto_reconnect")
        }
    }

    private func handleTextMessage(_ s: String) {
        lastIncomingTextMessage = s

        guard let data = s.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = json["type"] as? String else {
            logger.error("Invalid websocket JSON message")
            return
        }

        switch type {
        case "connected":
            isConnected = true
            reconnectAttempt = 0
            if let text = json["lastSpeakText"] as? String {
                lastSpeakText = text
            }
        case "speak_text":
            lastSpeakText = json["text"] as? String
        default:
            logger.debug("Ignoring websocket message type=\(type, privacy: .public)")
        }
    }
}
