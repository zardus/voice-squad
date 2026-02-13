import AVFoundation
import Foundation

@MainActor
final class AudioManager: NSObject, ObservableObject, AVAudioPlayerDelegate {
    @Published private(set) var isRecording: Bool = false
    @Published private(set) var isPlaying: Bool = false

    var autoReadEnabled: () -> Bool = { false }

    private let session = AVAudioSession.sharedInstance()
    private var recorder: AVAudioRecorder?
    private var recorderURL: URL?
    private var player: AVAudioPlayer?
    private var heldTtsAudio: Data?

    override init() {
        super.init()
        configureSession()
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleInterruption(_:)),
            name: AVAudioSession.interruptionNotification,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleRouteChange(_:)),
            name: AVAudioSession.routeChangeNotification,
            object: nil
        )
    }

    func configureSession() {
        do {
            try session.setCategory(
                .playAndRecord,
                mode: .default,
                options: [.allowBluetooth, .allowBluetoothA2DP, .defaultToSpeaker]
            )
            try session.setActive(true, options: [])
        } catch {
            // Best-effort; errors show up during simulator/headset variations.
        }
    }

    func startRecording() {
        configureSession()
        session.requestRecordPermission { [weak self] granted in
            guard let self else { return }
            Task { @MainActor in
                guard granted else { return }
                self.beginRecording()
            }
        }
    }

    private func beginRecording() {
        guard !isRecording else { return }
        stopPlayback()

        let tmp = FileManager.default.temporaryDirectory
        let url = tmp.appendingPathComponent("voicesquad-\(UUID().uuidString).m4a")
        recorderURL = url

        let settings: [String: Any] = [
            AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
            AVSampleRateKey: 44_100,
            AVNumberOfChannelsKey: 1,
            AVEncoderBitRateKey: 96_000
        ]

        do {
            let rec = try AVAudioRecorder(url: url, settings: settings)
            rec.isMeteringEnabled = false
            rec.prepareToRecord()
            rec.record()
            recorder = rec
            isRecording = true
        } catch {
            recorder = nil
            recorderURL = nil
            isRecording = false
        }
    }

    func stopAndSend(webSocket: WebSocketClient) async {
        guard isRecording else { return }
        recorder?.stop()
        recorder = nil
        isRecording = false

        guard let url = recorderURL else { return }
        recorderURL = nil

        let data: Data
        do {
            data = try Data(contentsOf: url)
        } catch {
            return
        }

        // Match the web client's framing: JSON start, binary frames, JSON end.
        webSocket.sendAudioStart(mimeType: "audio/mp4")
        let frameSize = 64 * 1024
        var offset = 0
        while offset < data.count {
            let end = min(offset + frameSize, data.count)
            webSocket.sendAudioChunk(data.subdata(in: offset..<end))
            offset = end
        }
        webSocket.sendAudioEnd()

        // If any TTS arrived while recording, play the latest once recording stops.
        if autoReadEnabled(), let held = heldTtsAudio {
            heldTtsAudio = nil
            playTtsAudio(held)
        } else {
            heldTtsAudio = nil
        }
    }

    func handleIncomingTtsAudio(_ data: Data) {
        if isRecording {
            // Hold only the latest response while recording to avoid a backlog.
            heldTtsAudio = data
            return
        }
        if autoReadEnabled() {
            playTtsAudio(data)
        } else {
            // Keep for manual replay later if we add UI; for now, drop.
        }
    }

    private func playTtsAudio(_ data: Data) {
        configureSession()
        do {
            let p = try AVAudioPlayer(data: data)
            p.delegate = self
            p.prepareToPlay()
            player = p
            isPlaying = true
            p.play()
        } catch {
            isPlaying = false
        }
    }

    private func stopPlayback() {
        player?.stop()
        player = nil
        isPlaying = false
    }

    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor in
            self.isPlaying = false
        }
    }

    @objc private func handleInterruption(_ notif: Notification) {
        guard let info = notif.userInfo,
              let rawType = info[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: rawType) else { return }
        switch type {
        case .began:
            stopPlayback()
        case .ended:
            configureSession()
        @unknown default:
            break
        }
    }

    @objc private func handleRouteChange(_ notif: Notification) {
        // Keep session configured for Bluetooth/headset changes.
        configureSession()
    }
}

