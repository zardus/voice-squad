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
        if let engine, engine.isRunning, playerNode != nil {
            return
        }
        engine = nil
        playerNode = nil
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
                guard let self, self.shouldBeRunning else { return }
                if let engine = self.engine, engine.isRunning, self.playerNode != nil {
                    return
                }
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
            if engine?.isRunning != true {
                logger.error("Silent audio engine restart failed after interruption end")
            }
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

final class SpeechAudioPlayer: NSObject {
    private let logger = Logger(subsystem: "com.voicesquad.app", category: "SpeechAudio")
    private var queue: [Data] = []
    private var playback: SpeechPlayback?
    private let audioSession: SpeechAudioSessionControlling
    private let playbackFactory: SpeechPlaybackFactory
    private var sessionPrepared = false

    init(
        audioSession: SpeechAudioSessionControlling = AVAudioSession.sharedInstance(),
        playbackFactory: SpeechPlaybackFactory = AVFoundationSpeechPlaybackFactory()
    ) {
        self.audioSession = audioSession
        self.playbackFactory = playbackFactory
        super.init()
    }

    func enqueue(_ audioData: Data) {
        guard !audioData.isEmpty else { return }
        queue.append(audioData)
        if playback == nil {
            playNext()
        }
    }

    var queuedItemCountForTesting: Int { queue.count }
    var isPlayingForTesting: Bool { playback != nil }

    private func playNext() {
        while !queue.isEmpty {
            let next = queue.removeFirst()
            do {
                try prepareAudioSessionIfNeeded()
                try audioSession.setActive(true, options: [])

                let playback = try playbackFactory.makePlayback(data: next)
                playback.onFinish = { [weak self] successfully in
                    self?.handleFinish(successfully: successfully)
                }
                playback.onDecodeError = { [weak self] error in
                    self?.handleDecodeError(error)
                }
                playback.prepareToPlay()
                if playback.play() {
                    self.playback = playback
                    return
                }
                logger.error("Failed to start speech playback")
                self.playback = nil
            } catch {
                logger.error("Failed to play speech audio: \(String(describing: error), privacy: .public)")
                self.playback = nil
            }
        }
    }

    private func prepareAudioSessionIfNeeded() throws {
        guard !sessionPrepared else { return }
        // Keep category aligned with SilentAudioPlayer's long-lived engine configuration.
        try audioSession.setCategory(.playback, options: [.mixWithOthers, .allowAirPlay])
        sessionPrepared = true
    }

    private func handleFinish(successfully: Bool) {
        if !successfully {
            logger.error("Speech playback ended unsuccessfully")
        }
        playback = nil
        playNext()
    }

    private func handleDecodeError(_ error: Error?) {
        logger.error("Speech decode error: \(String(describing: error), privacy: .public)")
        playback = nil
        playNext()
    }

}

protocol SpeechAudioSessionControlling {
    func setCategory(_ category: AVAudioSession.Category, options: AVAudioSession.CategoryOptions) throws
    func setActive(_ active: Bool, options: AVAudioSession.SetActiveOptions) throws
}

extension AVAudioSession: SpeechAudioSessionControlling {}

protocol SpeechPlayback: AnyObject {
    var onFinish: ((Bool) -> Void)? { get set }
    var onDecodeError: ((Error?) -> Void)? { get set }
    func prepareToPlay()
    func play() -> Bool
}

protocol SpeechPlaybackFactory {
    func makePlayback(data: Data) throws -> SpeechPlayback
}

final class AVFoundationSpeechPlaybackFactory: SpeechPlaybackFactory {
    func makePlayback(data: Data) throws -> SpeechPlayback {
        let player = try AVAudioPlayer(data: data)
        return AVAudioPlayerPlayback(player: player)
    }
}

private final class AVAudioPlayerPlayback: NSObject, SpeechPlayback, AVAudioPlayerDelegate {
    var onFinish: ((Bool) -> Void)?
    var onDecodeError: ((Error?) -> Void)?
    private let player: AVAudioPlayer

    init(player: AVAudioPlayer) {
        self.player = player
        super.init()
        self.player.delegate = self
    }

    func prepareToPlay() {
        player.prepareToPlay()
    }

    func play() -> Bool {
        player.play()
    }

    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        onFinish?(flag)
    }

    func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        onDecodeError?(error)
    }
}
