import ActivityKit
import Foundation
import OSLog

struct LiveActivityUpdateEvent: Equatable {
    let latestSpeechText: String
    let isConnected: Bool
    let activityID: String?
}

enum LiveActivityUpdateDecodeError: Error, Equatable {
    case invalidJSON
    case missingAPS
    case missingContentState
    case invalidSpeechText
}

enum LiveActivityUpdateEventDecoder {
    static func decodeWebSocketMessage(_ message: String) throws -> LiveActivityUpdateEvent? {
        guard let data = message.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = json["type"] as? String else {
            throw LiveActivityUpdateDecodeError.invalidJSON
        }

        switch type {
        case "connected":
            guard let text = sanitizeSpeechText(json["lastSpeakText"]) else { return nil }
            return LiveActivityUpdateEvent(latestSpeechText: text, isConnected: true, activityID: nil)
        case "speak_text":
            guard let text = sanitizeSpeechText(json["text"]) else {
                throw LiveActivityUpdateDecodeError.invalidSpeechText
            }
            return LiveActivityUpdateEvent(latestSpeechText: text, isConnected: true, activityID: nil)
        default:
            return nil
        }
    }

    static func decodeRemoteNotification(_ userInfo: [AnyHashable: Any]) throws -> LiveActivityUpdateEvent? {
        guard let aps = userInfo["aps"] as? [String: Any] else {
            throw LiveActivityUpdateDecodeError.missingAPS
        }

        if let event = aps["event"] as? String, event != "update" {
            return nil
        }

        let contentState = aps["content-state"] as? [String: Any] ?? aps["content_state"] as? [String: Any]
        guard let contentState else {
            throw LiveActivityUpdateDecodeError.missingContentState
        }
        guard let text = sanitizeSpeechText(contentState["latestSpeechText"]) else {
            throw LiveActivityUpdateDecodeError.invalidSpeechText
        }

        let isConnected = contentState["isConnected"] as? Bool ?? true
        let activityID = extractActivityID(userInfo)
        return LiveActivityUpdateEvent(latestSpeechText: text, isConnected: isConnected, activityID: activityID)
    }

    private static func sanitizeSpeechText(_ value: Any?) -> String? {
        guard let text = value as? String else { return nil }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func extractActivityID(_ userInfo: [AnyHashable: Any]) -> String? {
        if let activityID = userInfo["activityId"] as? String { return activityID }
        if let activityID = userInfo["activity_id"] as? String { return activityID }
        if let voiceSquad = userInfo["voice_squad"] as? [String: Any] {
            if let activityID = voiceSquad["activityId"] as? String { return activityID }
            if let activityID = voiceSquad["activity_id"] as? String { return activityID }
        }
        return nil
    }
}

@MainActor
final class LiveActivityManager: ObservableObject {
    static let waitingText = "Waiting for update..."
    private let logger = Logger(subsystem: "com.voicesquad.app", category: "LiveActivity")
    private var activity: Activity<VoiceSquadAttributes>?
    private var pushTokenTask: Task<Void, Never>?
    private var activityStateTask: Task<Void, Never>?

    func startActivityIfNeeded() {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }

        if let existing = resolveCurrentActivity() {
            activity = existing
            cleanupDuplicateActivities(keeping: existing.id)
            observeLifecycle(for: existing)
            return
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
                content: .init(state: initialState, staleDate: nil),
                pushType: .token
            )
            if let activity {
                UserDefaults.shared.set(activity.id, forKey: SharedKeys.liveActivityID)
                observeLifecycle(for: activity)
                logger.info("Started live activity id=\(activity.id, privacy: .public)")
            }
        } catch {
            logger.error("Failed to start live activity: \(String(describing: error), privacy: .public)")
        }
    }

    func updateActivity(text: String, isConnected: Bool) {
        updateActivity(with: .init(latestSpeechText: text, isConnected: isConnected, activityID: nil))
    }

    func updateActivity(with event: LiveActivityUpdateEvent) {
        guard let targetActivity = resolveActivity(for: event.activityID) else {
            logger.error("No live activity found for update. requestedId=\(event.activityID ?? "none", privacy: .public)")
            return
        }

        activity = targetActivity
        if event.isConnected {
            UserDefaults.shared.set(event.latestSpeechText, forKey: SharedKeys.lastSpeechText)
        }
        let state = VoiceSquadAttributes.ContentState(
            latestSpeechText: event.latestSpeechText,
            isConnected: event.isConnected,
            autoReadEnabled: UserDefaults.autoReadIsEnabled()
        )
        Task {
            await targetActivity.update(.init(state: state, staleDate: nil))
        }
    }

    func handleWebSocketMessage(_ message: String) {
        do {
            guard let event = try LiveActivityUpdateEventDecoder.decodeWebSocketMessage(message) else { return }
            updateActivity(with: event)
        } catch {
            logger.error("Ignoring invalid websocket live activity payload: \(String(describing: error), privacy: .public)")
        }
    }

    func handleRemoteNotification(_ userInfo: [AnyHashable: Any]) async -> Bool {
        do {
            guard let event = try LiveActivityUpdateEventDecoder.decodeRemoteNotification(userInfo) else {
                return false
            }
            updateActivity(with: event)
            return true
        } catch {
            logger.error("Ignoring invalid remote notification live activity payload: \(String(describing: error), privacy: .public)")
            return false
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
        pushTokenTask?.cancel()
        activityStateTask?.cancel()
        UserDefaults.shared.removeObject(forKey: SharedKeys.liveActivityID)
        UserDefaults.shared.removeObject(forKey: SharedKeys.liveActivityPushToken)
        self.activity = nil
    }

    private func resolveActivity(for requestedID: String?) -> Activity<VoiceSquadAttributes>? {
        if let requestedID {
            if let match = Activity<VoiceSquadAttributes>.activities.first(where: { $0.id == requestedID }) {
                return match
            }
            logger.error("Requested live activity id not found: \(requestedID, privacy: .public)")
        }

        if let current = resolveCurrentActivity() {
            return current
        }

        startActivityIfNeeded()
        return resolveCurrentActivity()
    }

    private func resolveCurrentActivity() -> Activity<VoiceSquadAttributes>? {
        if let currentID = UserDefaults.shared.string(forKey: SharedKeys.liveActivityID),
           let match = Activity<VoiceSquadAttributes>.activities.first(where: { $0.id == currentID }) {
            return match
        }
        if let first = Activity<VoiceSquadAttributes>.activities.first {
            UserDefaults.shared.set(first.id, forKey: SharedKeys.liveActivityID)
            return first
        }
        return nil
    }

    private func cleanupDuplicateActivities(keeping activityID: String) {
        for existing in Activity<VoiceSquadAttributes>.activities where existing.id != activityID {
            Task { await existing.end(nil, dismissalPolicy: .immediate) }
        }
    }

    private func observeLifecycle(for activity: Activity<VoiceSquadAttributes>) {
        pushTokenTask?.cancel()
        activityStateTask?.cancel()

        pushTokenTask = Task {
            for await tokenData in activity.pushTokenUpdates {
                let token = tokenData.map { String(format: "%02x", $0) }.joined()
                UserDefaults.shared.set(token, forKey: SharedKeys.liveActivityPushToken)
                logger.info("Live activity push token updated for id=\(activity.id, privacy: .public)")
            }
        }

        activityStateTask = Task {
            for await state in activity.activityStateUpdates {
                logger.info("Live activity state=\(String(describing: state), privacy: .public) id=\(activity.id, privacy: .public)")
                if state == .ended || state == .dismissed {
                    if UserDefaults.shared.string(forKey: SharedKeys.liveActivityID) == activity.id {
                        UserDefaults.shared.removeObject(forKey: SharedKeys.liveActivityID)
                        UserDefaults.shared.removeObject(forKey: SharedKeys.liveActivityPushToken)
                    }
                }
            }
        }
    }
}
