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
}
