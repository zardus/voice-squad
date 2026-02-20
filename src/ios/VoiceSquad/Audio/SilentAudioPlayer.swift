import AVFoundation

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
