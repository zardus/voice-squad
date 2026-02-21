import XCTest
@testable import VoiceSquad

final class VoiceSquadTests: XCTestCase {
    func testDecodeWebSocketSpeakText() throws {
        let message = #"{"type":"speak_text","text":"Captain update"}"#
        let event = try LiveActivityUpdateEventDecoder.decodeWebSocketMessage(message)
        XCTAssertEqual(event, .init(latestSpeechText: "Captain update", isConnected: true, activityID: nil))
    }

    func testDecodeWebSocketConnectedUsesLastSpeakText() throws {
        let message = #"{"type":"connected","lastSpeakText":"Recovered text"}"#
        let event = try LiveActivityUpdateEventDecoder.decodeWebSocketMessage(message)
        XCTAssertEqual(event?.latestSpeechText, "Recovered text")
        XCTAssertEqual(event?.isConnected, true)
    }

    func testDecodeWebSocketSpeakTextRejectsEmptyText() {
        let message = #"{"type":"speak_text","text":"   "}"#
        XCTAssertThrowsError(try LiveActivityUpdateEventDecoder.decodeWebSocketMessage(message)) { error in
            XCTAssertEqual(error as? LiveActivityUpdateDecodeError, .invalidSpeechText)
        }
    }

    func testDecodeWebSocketSpeakTextSupportsSummaryFieldAndTimestamp() throws {
        let message = #"{"type":"speak_text","summary":"Voice summary","timestamp":"2026-02-21T12:34:56Z"}"#
        let event = try LiveActivityUpdateEventDecoder.decodeWebSocketMessage(message)
        XCTAssertEqual(event?.latestSpeechText, "Voice summary")
        XCTAssertEqual(event?.eventDate?.timeIntervalSince1970, 1_771_677_296, accuracy: 0.001)
    }

    func testDecodeRemoteNotificationLiveActivityPayload() throws {
        let payload: [AnyHashable: Any] = [
            "aps": [
                "event": "update",
                "content-state": [
                    "latestSpeechText": "Background update",
                    "isConnected": false
                ]
            ],
            "voice_squad": [
                "activityId": "activity-123"
            ]
        ]

        let event = try LiveActivityUpdateEventDecoder.decodeRemoteNotification(payload)
        XCTAssertEqual(
            event,
            .init(latestSpeechText: "Background update", isConnected: false, activityID: "activity-123")
        )
    }

    func testDecodeRemoteNotificationSupportsAnyHashableNestedPayload() throws {
        let payload: [AnyHashable: Any] = [
            "aps": [
                AnyHashable("event"): "update",
                AnyHashable("content-state"): [
                    AnyHashable("latestSpeechText"): "Foreground payload",
                    AnyHashable("isConnected"): true
                ],
                AnyHashable("activity-id"): "activity-foreground"
            ]
        ]

        let event = try LiveActivityUpdateEventDecoder.decodeRemoteNotification(payload)
        XCTAssertEqual(
            event,
            .init(latestSpeechText: "Foreground payload", isConnected: true, activityID: "activity-foreground")
        )
    }

    func testDecodeRemoteNotificationExtractsActivityIdFromVoiceSquadPayload() throws {
        let payload: [AnyHashable: Any] = [
            "aps": [
                "event": "update",
                "content-state": [
                    "latestSpeechText": "Routing test",
                    "isConnected": true
                ]
            ],
            "voice_squad": [
                AnyHashable("activity_id"): "voice-squad-activity-id"
            ]
        ]

        let event = try LiveActivityUpdateEventDecoder.decodeRemoteNotification(payload)
        XCTAssertEqual(event?.activityID, "voice-squad-activity-id")
    }

    func testDecodeRemoteNotificationSupportsAnyHashableTopLevelKeys() throws {
        let payload: [AnyHashable: Any] = [
            AnyHashable("aps"): [
                AnyHashable("event"): "update",
                AnyHashable("content-state"): [
                    AnyHashable("latestSpeechText"): "Top-level AnyHashable",
                    AnyHashable("isConnected"): true
                ]
            ],
            AnyHashable("voice_squad"): [
                AnyHashable("activity_id"): "top-level-activity-id"
            ]
        ]

        let event = try LiveActivityUpdateEventDecoder.decodeRemoteNotification(payload)
        XCTAssertEqual(event?.latestSpeechText, "Top-level AnyHashable")
        XCTAssertEqual(event?.activityID, "top-level-activity-id")
    }

    func testDecodeRemoteNotificationRequiresAPS() {
        XCTAssertThrowsError(try LiveActivityUpdateEventDecoder.decodeRemoteNotification([:])) { error in
            XCTAssertEqual(error as? LiveActivityUpdateDecodeError, .missingAPS)
        }
    }

    func testDecodeRemoteNotificationSupportsSnakeCaseContentState() throws {
        let payload: [AnyHashable: Any] = [
            "aps": [
                "event": "update",
                "content_state": [
                    "latest_speech_text": "Snake case payload",
                    "is_connected": false
                ]
            ]
        ]

        let event = try LiveActivityUpdateEventDecoder.decodeRemoteNotification(payload)
        XCTAssertEqual(
            event,
            .init(latestSpeechText: "Snake case payload", isConnected: false, activityID: nil)
        )
    }

    func testDecodeRemoteNotificationFallsBackToAlertBody() throws {
        let payload: [AnyHashable: Any] = [
            "aps": [
                "event": "update",
                "alert": [
                    "body": "Alert body text"
                ]
            ]
        ]

        let event = try LiveActivityUpdateEventDecoder.decodeRemoteNotification(payload)
        XCTAssertEqual(event?.latestSpeechText, "Alert body text")
        XCTAssertEqual(event?.isConnected, true)
    }

    func testDecodeRemoteNotificationSupportsRootSpeechTextFallback() throws {
        let payload: [AnyHashable: Any] = [
            "aps": [
                "event": "update"
            ],
            "latestSpeechText": "Root fallback text",
            "isConnected": false
        ]

        let event = try LiveActivityUpdateEventDecoder.decodeRemoteNotification(payload)
        XCTAssertEqual(event?.latestSpeechText, "Root fallback text")
        XCTAssertEqual(event?.isConnected, false)
    }

    func testDecodeRemoteNotificationSupportsSummaryFallbackAndTimestamp() throws {
        let payload: [AnyHashable: Any] = [
            "aps": [
                "event": "update",
                "timestamp": 1_771_677_296
            ],
            "summary": "Summary field payload",
            "isConnected": true
        ]

        let event = try LiveActivityUpdateEventDecoder.decodeRemoteNotification(payload)
        XCTAssertEqual(event?.latestSpeechText, "Summary field payload")
        XCTAssertEqual(event?.eventDate?.timeIntervalSince1970, 1_771_677_296, accuracy: 0.001)
    }

    func testDecodeRemoteNotificationEndEventMarksDisconnected() throws {
        let payload: [AnyHashable: Any] = [
            "aps": [
                "event": "ended",
                "activity-id": "activity-xyz"
            ]
        ]

        let event = try LiveActivityUpdateEventDecoder.decodeRemoteNotification(payload)
        XCTAssertEqual(event?.isConnected, false)
        XCTAssertEqual(event?.activityID, "activity-xyz")
    }

    func testLiveActivityRouterUsesRequestedIdWhenPresent() {
        let decision = LiveActivityRouter.chooseActivityID(
            requestedID: "requested",
            storedID: "stored",
            availableIDs: ["stored", "requested", "other"]
        )
        XCTAssertEqual(decision, .selected(activityID: "requested"))
    }

    func testLiveActivityRouterFallsBackToStoredWhenRequestedIdNotFound() {
        // When the server sends a stale activity ID that no longer exists on the device,
        // the router should fall back to the stored/available activity instead of dropping.
        let decision = LiveActivityRouter.chooseActivityID(
            requestedID: "missing",
            storedID: "stored",
            availableIDs: ["stored", "other"]
        )
        XCTAssertEqual(decision, .selected(activityID: "stored"))
    }

    func testLiveActivityRouterFallsBackToFirstWhenRequestedAndStoredBothMissing() {
        let decision = LiveActivityRouter.chooseActivityID(
            requestedID: "stale-server-id",
            storedID: "also-missing",
            availableIDs: ["first", "second"]
        )
        XCTAssertEqual(decision, .selected(activityID: "first"))
    }

    func testLiveActivityRouterReturnsNoCandidatesWhenNoneAvailable() {
        let decision = LiveActivityRouter.chooseActivityID(
            requestedID: "missing",
            storedID: "also-missing",
            availableIDs: []
        )
        XCTAssertEqual(decision, .noCandidates)
    }

    func testLiveActivityRouterFallsBackToStoredIdWhenNoRequestedId() {
        let decision = LiveActivityRouter.chooseActivityID(
            requestedID: nil,
            storedID: "stored",
            availableIDs: ["stored", "other"]
        )
        XCTAssertEqual(decision, .selected(activityID: "stored"))
    }

    func testLiveActivityRouterUsesFirstAvailableWhenStoredIdMissing() {
        let decision = LiveActivityRouter.chooseActivityID(
            requestedID: nil,
            storedID: "missing",
            availableIDs: ["first", "second"]
        )
        XCTAssertEqual(decision, .selected(activityID: "first"))
    }

    func testConnectionTransitionPolicyKeepsBackgroundDisconnectDuringGrace() {
        let startedAt = Date()
        let evaluationTime = startedAt.addingTimeInterval(ConnectionTransitionPolicy.backgroundDisconnectGrace - 1)
        let shouldMark = ConnectionTransitionPolicy.shouldMarkDisconnected(
            disconnectStartedAt: startedAt,
            now: evaluationTime,
            runtimeState: .background,
            isConnected: false
        )
        XCTAssertFalse(shouldMark)
    }

    func testConnectionTransitionPolicyMarksBackgroundDisconnectAfterGrace() {
        let startedAt = Date()
        let evaluationTime = startedAt.addingTimeInterval(ConnectionTransitionPolicy.backgroundDisconnectGrace + 1)
        let shouldMark = ConnectionTransitionPolicy.shouldMarkDisconnected(
            disconnectStartedAt: startedAt,
            now: evaluationTime,
            runtimeState: .background,
            isConnected: false
        )
        XCTAssertTrue(shouldMark)
    }

    func testConnectionTransitionPolicyNeverMarksWhileConnected() {
        let startedAt = Date().addingTimeInterval(-120)
        let shouldMark = ConnectionTransitionPolicy.shouldMarkDisconnected(
            disconnectStartedAt: startedAt,
            now: Date(),
            runtimeState: .active,
            isConnected: true
        )
        XCTAssertFalse(shouldMark)
    }

    func testConnectionTransitionPolicyKeepsActiveDisconnectDuringGrace() {
        let startedAt = Date()
        let evaluationTime = startedAt.addingTimeInterval(ConnectionTransitionPolicy.activeDisconnectGrace - 1)
        let shouldMark = ConnectionTransitionPolicy.shouldMarkDisconnected(
            disconnectStartedAt: startedAt,
            now: evaluationTime,
            runtimeState: .active,
            isConnected: false
        )
        XCTAssertFalse(shouldMark)
    }

    func testConnectionTransitionPolicyMarksActiveDisconnectAfterGrace() {
        let startedAt = Date()
        let evaluationTime = startedAt.addingTimeInterval(ConnectionTransitionPolicy.activeDisconnectGrace + 1)
        let shouldMark = ConnectionTransitionPolicy.shouldMarkDisconnected(
            disconnectStartedAt: startedAt,
            now: evaluationTime,
            runtimeState: .active,
            isConnected: false
        )
        XCTAssertTrue(shouldMark)
    }

    func testConnectionTransitionPolicyKeepsInactiveDisconnectDuringGrace() {
        let startedAt = Date()
        let evaluationTime = startedAt.addingTimeInterval(ConnectionTransitionPolicy.inactiveDisconnectGrace - 1)
        let shouldMark = ConnectionTransitionPolicy.shouldMarkDisconnected(
            disconnectStartedAt: startedAt,
            now: evaluationTime,
            runtimeState: .inactive,
            isConnected: false
        )
        XCTAssertFalse(shouldMark)
    }

    func testConnectionTransitionPolicyMarksInactiveDisconnectAfterGrace() {
        let startedAt = Date()
        let evaluationTime = startedAt.addingTimeInterval(ConnectionTransitionPolicy.inactiveDisconnectGrace + 1)
        let shouldMark = ConnectionTransitionPolicy.shouldMarkDisconnected(
            disconnectStartedAt: startedAt,
            now: evaluationTime,
            runtimeState: .inactive,
            isConnected: false
        )
        XCTAssertTrue(shouldMark)
    }

    // MARK: - NotificationDedup tests

    func testNotificationDedupSuppressesSameTextWithinWindow() {
        var dedup = NotificationDedup(windowSeconds: 300)
        XCTAssertTrue(dedup.shouldPost(text: "Hello"))
        XCTAssertFalse(dedup.shouldPost(text: "Hello"))
    }

    func testNotificationDedupAllowsDifferentText() {
        var dedup = NotificationDedup(windowSeconds: 300)
        XCTAssertTrue(dedup.shouldPost(text: "Message A"))
        XCTAssertTrue(dedup.shouldPost(text: "Message B"))
    }

    func testNotificationDedupAllowsSameTextAfterWindowExpires() {
        var dedup = NotificationDedup(windowSeconds: 0)
        XCTAssertTrue(dedup.shouldPost(text: "Repeat"))
        // With a 0-second window, the next check should pass (window expired immediately).
        XCTAssertTrue(dedup.shouldPost(text: "Repeat"))
    }

    func testNotificationDedupResetClearsState() {
        var dedup = NotificationDedup(windowSeconds: 300)
        XCTAssertTrue(dedup.shouldPost(text: "First"))
        dedup.reset()
        // After reset, same text should be allowed again.
        XCTAssertTrue(dedup.shouldPost(text: "First"))
    }

    func testNotificationDedupSequenceOfTexts() {
        var dedup = NotificationDedup(windowSeconds: 300)
        XCTAssertTrue(dedup.shouldPost(text: "A"))
        XCTAssertFalse(dedup.shouldPost(text: "A"))
        XCTAssertTrue(dedup.shouldPost(text: "B"))
        XCTAssertFalse(dedup.shouldPost(text: "B"))
        // Going back to A should be allowed (last was B).
        XCTAssertTrue(dedup.shouldPost(text: "A"))
    }
}
