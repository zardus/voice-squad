import ActivityKit
import AppIntents

struct ToggleAutoReadIntent: AppIntent {
    static var title: LocalizedStringResource = "Toggle Auto Read"
    static var openAppWhenRun: Bool = false

    func perform() async throws -> some IntentResult {
        let current = UserDefaults.autoReadIsEnabled()
        UserDefaults.shared.set(!current, forKey: SharedKeys.autoReadEnabled)
        for activity in Activity<VoiceSquadAttributes>.activities {
            let s = activity.content.state
            let newState = VoiceSquadAttributes.ContentState(
                latestSpeechText: s.latestSpeechText,
                isConnected: s.isConnected,
                autoReadEnabled: !current
            )
            await activity.update(.init(state: newState, staleDate: nil))
        }
        return .result()
    }
}
