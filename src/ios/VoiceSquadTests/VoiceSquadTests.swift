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

    func testLiveActivityRouterIgnoresUnknownRequestedId() {
        let decision = LiveActivityRouter.chooseActivityID(
            requestedID: "missing",
            storedID: "stored",
            availableIDs: ["stored", "other"]
        )
        XCTAssertEqual(decision, .ignoreUnknownRequestedID(requestedID: "missing"))
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
}
