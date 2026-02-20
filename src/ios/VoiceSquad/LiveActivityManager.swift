import ActivityKit
import Foundation

@MainActor
final class LiveActivityManager: ObservableObject {
    static let waitingText = "Waiting for update..."
    private var activity: Activity<VoiceSquadAttributes>?

    func startActivity() {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }

        // End any stale activities from a previous session.
        for existing in Activity<VoiceSquadAttributes>.activities {
            Task { await existing.end(nil, dismissalPolicy: .immediate) }
        }

        let attributes = VoiceSquadAttributes()
        let initialText = UserDefaults.shared.string(forKey: SharedKeys.lastSpeechText) ?? Self.waitingText
        let initialState = VoiceSquadAttributes.ContentState(
            latestSpeechText: initialText,
            isConnected: true,
            autoReadEnabled: UserDefaults.autoReadIsEnabled()
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
        if isConnected {
            UserDefaults.shared.set(text, forKey: SharedKeys.lastSpeechText)
        }
        let state = VoiceSquadAttributes.ContentState(
            latestSpeechText: text,
            isConnected: isConnected,
            autoReadEnabled: UserDefaults.autoReadIsEnabled()
        )
        Task {
            await activity.update(.init(state: state, staleDate: nil))
        }
    }

    static func syncAutoReadForAllActivities() async {
        let autoReadEnabled = UserDefaults.autoReadIsEnabled()
        for activity in Activity<VoiceSquadAttributes>.activities {
            let s = activity.content.state
            let newState = VoiceSquadAttributes.ContentState(
                latestSpeechText: s.latestSpeechText,
                isConnected: s.isConnected,
                autoReadEnabled: autoReadEnabled
            )
            await activity.update(.init(state: newState, staleDate: nil))
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
