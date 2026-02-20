import AppIntents

struct ToggleAutoReadIntent: AppIntent {
    static var title: LocalizedStringResource = "Toggle Auto Read"
    static var openAppWhenRun: Bool = false

    func perform() async throws -> some IntentResult {
        let current = UserDefaults.autoReadIsEnabled()
        UserDefaults.shared.set(!current, forKey: SharedKeys.autoReadEnabled)
        await LiveActivityManager.syncAutoReadForAllActivities()
        return .result()
    }
}
