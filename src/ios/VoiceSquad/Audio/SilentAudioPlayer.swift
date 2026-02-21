import AVFoundation
import OSLog
import UIKit

final class SilentAudioPlayer {
    private var engine: AVAudioEngine?
    private var playerNode: AVAudioPlayerNode?
    private let logger = Logger(subsystem: "com.voicesquad.app", category: "SilentAudio")
    private var shouldBeRunning = false
    private var interruptionObserver: NSObjectProtocol?
    private var resetObserver: NSObjectProtocol?
    private var foregroundObserver: NSObjectProtocol?

    func start() {
        shouldBeRunning = true
        installObserversIfNeeded()
        guard engine == nil, playerNode == nil else { return }
        startAudioEngine()
    }

    private func startAudioEngine() {
        guard shouldBeRunning else { return }

        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playback, options: .mixWithOthers)
            try session.setActive(true)
        } catch {
            logger.error("Failed to activate silent audio session: \(String(describing: error), privacy: .public)")
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
            logger.error("Failed to start silent audio engine: \(String(describing: error), privacy: .public)")
            return
        }

        player.scheduleBuffer(buffer, at: nil, options: .loops)
        player.play()

        self.engine = engine
        self.playerNode = player
    }

    func stop() {
        shouldBeRunning = false
        playerNode?.stop()
        engine?.stop()
        playerNode = nil
        engine = nil
        removeObservers()
        do {
            try AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        } catch {
            // Best-effort cleanup; ignore failures.
        }
    }

    private func installObserversIfNeeded() {
        if interruptionObserver == nil {
            interruptionObserver = NotificationCenter.default.addObserver(
                forName: AVAudioSession.interruptionNotification,
                object: AVAudioSession.sharedInstance(),
                queue: .main
            ) { [weak self] notification in
                self?.handleInterruption(notification)
            }
        }
        if resetObserver == nil {
            resetObserver = NotificationCenter.default.addObserver(
                forName: AVAudioSession.mediaServicesWereResetNotification,
                object: AVAudioSession.sharedInstance(),
                queue: .main
            ) { [weak self] _ in
                self?.handleMediaServicesReset()
            }
        }
        if foregroundObserver == nil {
            foregroundObserver = NotificationCenter.default.addObserver(
                forName: UIApplication.didBecomeActiveNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                guard let self, self.shouldBeRunning, self.engine == nil || self.playerNode == nil else { return }
                self.logger.info("Restarting silent audio after app became active")
                self.startAudioEngine()
            }
        }
    }

    private func removeObservers() {
        if let interruptionObserver {
            NotificationCenter.default.removeObserver(interruptionObserver)
            self.interruptionObserver = nil
        }
        if let resetObserver {
            NotificationCenter.default.removeObserver(resetObserver)
            self.resetObserver = nil
        }
        if let foregroundObserver {
            NotificationCenter.default.removeObserver(foregroundObserver)
            self.foregroundObserver = nil
        }
    }

    private func handleInterruption(_ notification: Notification) {
        guard shouldBeRunning else { return }
        guard let typeValue = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: typeValue) else { return }
        switch type {
        case .began:
            logger.info("Silent audio interrupted")
            engine?.stop()
            playerNode?.stop()
            engine = nil
            playerNode = nil
        case .ended:
            logger.info("Silent audio interruption ended; restarting engine")
            startAudioEngine()
        @unknown default:
            break
        }
    }

    private func handleMediaServicesReset() {
        guard shouldBeRunning else { return }
        logger.info("Audio media services reset; restarting silent audio")
        engine = nil
        playerNode = nil
        startAudioEngine()
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
        while !queue.isEmpty {
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
                    return
                }
                logger.error("Failed to start speech playback")
                self.player = nil
            } catch {
                logger.error("Failed to play speech audio: \(String(describing: error), privacy: .public)")
                self.player = nil
            }
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
