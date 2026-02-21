import ActivityKit
import Foundation
import OSLog

struct LiveActivityUpdateEvent: Equatable {
    let latestSpeechText: String
    let isConnected: Bool
    let activityID: String?
}

enum LiveActivityRoutingDecision: Equatable {
    case selected(activityID: String)
    case ignoreUnknownRequestedID(requestedID: String)
    case noCandidates
}

enum LiveActivityRouter {
    static func chooseActivityID(
        requestedID: String?,
        storedID: String?,
        availableIDs: [String]
    ) -> LiveActivityRoutingDecision {
        if let requestedID = normalizedID(requestedID) {
            return availableIDs.contains(requestedID)
                ? .selected(activityID: requestedID)
                : .ignoreUnknownRequestedID(requestedID: requestedID)
        }

        if let storedID = normalizedID(storedID),
           availableIDs.contains(storedID) {
            return .selected(activityID: storedID)
        }

        if let first = availableIDs.first {
            return .selected(activityID: first)
        }
        return .noCandidates
    }

    private static func normalizedID(_ value: String?) -> String? {
        guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              !trimmed.isEmpty else {
            return nil
        }
        return trimmed
    }
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
            let text = sanitizeSpeechText(json["lastSpeakText"])
                ?? sanitizeSpeechText(json["last_speak_text"])
                ?? UserDefaults.shared.string(forKey: SharedKeys.lastSpeechText)
                ?? "Waiting for update..."
            return LiveActivityUpdateEvent(latestSpeechText: text, isConnected: true, activityID: nil)
        case "speak_text", "speakText":
            guard let text = sanitizeSpeechText(json["text"]) ?? sanitizeSpeechText(json["latestSpeechText"]) else {
                throw LiveActivityUpdateDecodeError.invalidSpeechText
            }
            return LiveActivityUpdateEvent(latestSpeechText: text, isConnected: true, activityID: nil)
        default:
            return nil
        }
    }

    static func decodeRemoteNotification(_ userInfo: [AnyHashable: Any]) throws -> LiveActivityUpdateEvent? {
        guard let aps = dictionaryValue(userInfo["aps"]) else {
            throw LiveActivityUpdateDecodeError.missingAPS
        }

        let activityID = extractActivityID(userInfo, aps: aps)
        if let event = (aps["event"] as? String)?.lowercased(),
           ["end", "ended", "dismiss", "dismissed", "stop", "stopped"].contains(event) {
            let fallbackText = UserDefaults.shared.string(forKey: SharedKeys.lastSpeechText) ?? "Disconnected"
            return LiveActivityUpdateEvent(latestSpeechText: fallbackText, isConnected: false, activityID: activityID)
        }

        let contentState = dictionaryValue(aps["content-state"]) ?? dictionaryValue(aps["content_state"])
        let voiceSquad = dictionaryValue(userInfo["voice_squad"])
        let text = firstSpeechText([
            contentState?["latestSpeechText"],
            contentState?["latest_speech_text"],
            contentState?["text"],
            voiceSquad?["latestSpeechText"],
            voiceSquad?["latest_speech_text"],
            voiceSquad?["text"],
            userInfo["latestSpeechText"],
            userInfo["latest_speech_text"],
            userInfo["text"],
        ])
            ?? extractAlertBody(aps["alert"])
            ?? UserDefaults.shared.string(forKey: SharedKeys.lastSpeechText)
        guard let text else {
            throw LiveActivityUpdateDecodeError.invalidSpeechText
        }

        if contentState == nil
            && voiceSquad == nil
            && userInfo["text"] == nil
            && userInfo["latestSpeechText"] == nil
            && userInfo["latest_speech_text"] == nil
            && aps["alert"] == nil {
            throw LiveActivityUpdateDecodeError.missingContentState
        }

        let isConnected = boolValue(contentState?["isConnected"])
            ?? boolValue(contentState?["is_connected"])
            ?? boolValue(voiceSquad?["isConnected"])
            ?? boolValue(voiceSquad?["is_connected"])
            ?? boolValue(userInfo["isConnected"])
            ?? boolValue(userInfo["is_connected"])
            ?? true
        return LiveActivityUpdateEvent(latestSpeechText: text, isConnected: isConnected, activityID: activityID)
    }

    private static func sanitizeSpeechText(_ value: Any?) -> String? {
        guard let text = value as? String else { return nil }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func firstSpeechText(_ candidates: [Any?]) -> String? {
        for candidate in candidates {
            if let text = sanitizeSpeechText(candidate) {
                return text
            }
        }
        return nil
    }

    private static func extractAlertBody(_ alert: Any?) -> String? {
        if let body = alert as? String {
            return sanitizeSpeechText(body)
        }
        if let alertDict = dictionaryValue(alert) {
            return sanitizeSpeechText(alertDict["body"])
        }
        return nil
    }

    private static func dictionaryValue(_ raw: Any?) -> [String: Any]? {
        if let dict = raw as? [String: Any] {
            return dict
        }
        if let dict = raw as? [AnyHashable: Any] {
            var normalized: [String: Any] = [:]
            normalized.reserveCapacity(dict.count)
            for (key, value) in dict {
                if let stringKey = key as? String {
                    normalized[stringKey] = value
                }
            }
            return normalized
        }
        return nil
    }

    private static func boolValue(_ value: Any?) -> Bool? {
        if let bool = value as? Bool { return bool }
        if let int = value as? Int { return int != 0 }
        if let string = value as? String {
            switch string.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
            case "true", "1", "yes", "connected", "online":
                return true
            case "false", "0", "no", "disconnected", "offline":
                return false
            default:
                return nil
            }
        }
        return nil
    }

    private static func extractActivityID(_ userInfo: [AnyHashable: Any], aps: [String: Any]) -> String? {
        if let activityID = aps["activity-id"] as? String { return activityID }
        if let activityID = aps["activity_id"] as? String { return activityID }
        if let activityID = userInfo["activityId"] as? String { return activityID }
        if let activityID = userInfo["activity_id"] as? String { return activityID }
        if let voiceSquad = dictionaryValue(userInfo["voice_squad"]) {
            if let activityID = voiceSquad["activityId"] as? String { return activityID }
            if let activityID = voiceSquad["activity_id"] as? String { return activityID }
        }
        return nil
    }
}

@MainActor
final class LiveActivityManager: ObservableObject {
    static let shared = LiveActivityManager()
    static let waitingText = "Waiting for update..."
    private let logger = Logger(subsystem: "com.voicesquad.app", category: "LiveActivity")
    private var activity: Activity<VoiceSquadAttributes>?
    private var pushTokenTask: Task<Void, Never>?
    private var activityStateTask: Task<Void, Never>?

    private init() {}

    func startActivityIfNeeded() {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            logger.error("Live activities are disabled; cannot start activity")
            return
        }

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
            logger.warning("Dropped live activity update requestedId=\(event.activityID ?? "none", privacy: .public)")
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
        logger.debug("Queueing live activity update id=\(targetActivity.id, privacy: .public) connected=\(event.isConnected, privacy: .public) textChars=\(event.latestSpeechText.count, privacy: .public)")
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
        var activities = Activity<VoiceSquadAttributes>.activities
        let storedID = UserDefaults.shared.string(forKey: SharedKeys.liveActivityID)
        var decision = LiveActivityRouter.chooseActivityID(
            requestedID: requestedID,
            storedID: storedID,
            availableIDs: activities.map(\.id)
        )

        if case .noCandidates = decision {
            startActivityIfNeeded()
            activities = Activity<VoiceSquadAttributes>.activities
            decision = LiveActivityRouter.chooseActivityID(
                requestedID: requestedID,
                storedID: UserDefaults.shared.string(forKey: SharedKeys.liveActivityID),
                availableIDs: activities.map(\.id)
            )
        }

        switch decision {
        case .selected(let selectedID):
            guard let match = activities.first(where: { $0.id == selectedID }) else {
                logger.error("Routing selected unknown live activity id=\(selectedID, privacy: .public)")
                return nil
            }
            if UserDefaults.shared.string(forKey: SharedKeys.liveActivityID) != match.id {
                UserDefaults.shared.set(match.id, forKey: SharedKeys.liveActivityID)
                logger.info("Updated stored live activity id to \(match.id, privacy: .public)")
            }
            return match
        case .ignoreUnknownRequestedID(let missingID):
            logger.warning("Ignoring live activity update for unknown requested id=\(missingID, privacy: .public)")
            return nil
        case .noCandidates:
            logger.error("No live activity available after recovery attempt")
            return nil
        }
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
