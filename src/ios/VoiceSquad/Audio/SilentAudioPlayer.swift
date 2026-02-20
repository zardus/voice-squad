import AVFoundation
import OSLog

final class SilentAudioPlayer {
    private var engine: AVAudioEngine?
    private var playerNode: AVAudioPlayerNode?

    func start() {
        guard engine == nil, playerNode == nil else { return }

        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playback, options: .mixWithOthers)
            try session.setActive(true)
        } catch {
            return
        }

        let engine = AVAudioEngine()
        let player = AVAudioPlayerNode()
        engine.attach(player)

        let format = AVAudioFormat(standardFormatWithSampleRate: 44100, channels: 1)!
        engine.connect(player, to: engine.mainMixerNode, format: format)

        // Create a short buffer of silence and loop it
        let frameCount = AVAudioFrameCount(44100) // 1 second of silence
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frameCount) else { return }
        buffer.frameLength = frameCount
        // Buffer is already zeroed out (silence)

        do {
            try engine.start()
        } catch {
            return
        }

        player.scheduleBuffer(buffer, at: nil, options: .loops)
        player.play()

        self.engine = engine
        self.playerNode = player
    }

    func stop() {
        playerNode?.stop()
        engine?.stop()
        playerNode = nil
        engine = nil
        do {
            try AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        } catch {
            // Best-effort cleanup; ignore failures.
        }
    }
}

final class SpeechAudioPlayer: NSObject, AVAudioPlayerDelegate {
    private let logger = Logger(subsystem: "com.voicesquad.app", category: "SpeechAudio")
    private var queue: [Data] = []
    private var player: AVAudioPlayer?

    func enqueue(_ audioData: Data) {
        guard !audioData.isEmpty else { return }
        queue.append(audioData)
        if player == nil {
            playNext()
        }
    }

    private func playNext() {
        guard !queue.isEmpty else { return }
        let next = queue.removeFirst()
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, options: [.mixWithOthers, .allowBluetoothHFP, .allowAirPlay])
            try session.setActive(true)

            let player = try AVAudioPlayer(data: next)
            player.delegate = self
            player.prepareToPlay()
            if player.play() {
                self.player = player
            } else {
                logger.error("Failed to start speech playback")
                self.player = nil
                playNext()
            }
        } catch {
            logger.error("Failed to play speech audio: \(String(describing: error), privacy: .public)")
            self.player = nil
            playNext()
        }
    }

    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        self.player = nil
        playNext()
    }

    func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        logger.error("Speech decode error: \(String(describing: error), privacy: .public)")
        self.player = nil
        playNext()
    }
}
