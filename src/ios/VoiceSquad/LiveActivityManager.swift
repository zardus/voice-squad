import ActivityKit
import Foundation

@MainActor
final class LiveActivityManager: ObservableObject {
    private var activity: Activity<VoiceSquadAttributes>?

    func startActivity() {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }

        // End any stale activities from a previous session.
        for existing in Activity<VoiceSquadAttributes>.activities {
            Task { await existing.end(nil, dismissalPolicy: .immediate) }
        }

        let attributes = VoiceSquadAttributes()
        let initialState = VoiceSquadAttributes.ContentState(
            latestSpeechText: "Listening...",
            isConnected: true
        )

        do {
            activity = try Activity<VoiceSquadAttributes>.request(
                attributes: attributes,
                content: .init(state: initialState, staleDate: nil)
            )
        } catch {
            // Live Activities may be disabled by the user.
        }
    }

    func updateActivity(text: String, isConnected: Bool) {
        guard let activity else { return }
        let state = VoiceSquadAttributes.ContentState(
            latestSpeechText: text,
            isConnected: isConnected
        )
        Task {
            await activity.update(.init(state: state, staleDate: nil))
        }
    }

    func endActivity() {
        guard let activity else { return }
        Task {
            await activity.end(nil, dismissalPolicy: .immediate)
        }
        self.activity = nil
    }
}
