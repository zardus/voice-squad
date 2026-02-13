import AVFoundation
import MediaPlayer
import Foundation

@MainActor
final class RemoteControls: ObservableObject {
    var onToggleRecording: (() -> Void)?

    private var configured = false

    init() {
        configureIfNeeded()
    }

    func configureIfNeeded() {
        guard !configured else { return }
        configured = true

        let center = MPRemoteCommandCenter.shared()

        // Best-effort mapping: many headsets (including AirPods) map squeeze/press to play/pause.
        center.playCommand.isEnabled = true
        center.pauseCommand.isEnabled = true
        center.togglePlayPauseCommand.isEnabled = true

        center.playCommand.addTarget { [weak self] _ in
            Task { @MainActor in self?.onToggleRecording?() }
            return .success
        }
        center.pauseCommand.addTarget { [weak self] _ in
            Task { @MainActor in self?.onToggleRecording?() }
            return .success
        }
        center.togglePlayPauseCommand.addTarget { [weak self] _ in
            Task { @MainActor in self?.onToggleRecording?() }
            return .success
        }

        MPNowPlayingInfoCenter.default().nowPlayingInfo = [
            MPMediaItemPropertyTitle: "VoiceSquad",
            MPMediaItemPropertyArtist: "VoiceSquad",
        ]
    }
}

