import XCTest
import AVFoundation
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
        let clock = MutableClock(start: Date(timeIntervalSince1970: 1_700_000_000))
        var dedup = NotificationDedup(windowSeconds: 300, nowProvider: { clock.now })
        XCTAssertTrue(dedup.shouldPost(text: "Hello"))
        XCTAssertFalse(dedup.shouldPost(text: "Hello"))
    }

    func testNotificationDedupAllowsDifferentText() {
        let clock = MutableClock(start: Date(timeIntervalSince1970: 1_700_000_000))
        var dedup = NotificationDedup(windowSeconds: 300, nowProvider: { clock.now })
        XCTAssertTrue(dedup.shouldPost(text: "Message A"))
        XCTAssertTrue(dedup.shouldPost(text: "Message B"))
    }

    func testNotificationDedupAllowsSameTextAfterWindowExpires() {
        let clock = MutableClock(start: Date(timeIntervalSince1970: 1_700_000_000))
        var dedup = NotificationDedup(windowSeconds: 0, nowProvider: { clock.now })
        XCTAssertTrue(dedup.shouldPost(text: "Repeat"))
        // With a 0-second window, the next check should pass (window expired immediately).
        XCTAssertTrue(dedup.shouldPost(text: "Repeat"))
    }

    func testNotificationDedupAllowsSameTextAfterRealWindowExpires() {
        let clock = MutableClock(start: Date(timeIntervalSince1970: 1_700_000_000))
        var dedup = NotificationDedup(windowSeconds: 1, nowProvider: { clock.now })
        XCTAssertTrue(dedup.shouldPost(text: "Repeat"))
        XCTAssertFalse(dedup.shouldPost(text: "Repeat"))
        clock.advance(by: 1.1)
        XCTAssertTrue(dedup.shouldPost(text: "Repeat"))
    }

    func testNotificationDedupResetClearsState() {
        let clock = MutableClock(start: Date(timeIntervalSince1970: 1_700_000_000))
        var dedup = NotificationDedup(windowSeconds: 300, nowProvider: { clock.now })
        XCTAssertTrue(dedup.shouldPost(text: "First"))
        dedup.reset()
        // After reset, same text should be allowed again.
        XCTAssertTrue(dedup.shouldPost(text: "First"))
    }

    func testNotificationDedupSequenceOfTexts() {
        let clock = MutableClock(start: Date(timeIntervalSince1970: 1_700_000_000))
        var dedup = NotificationDedup(windowSeconds: 300, nowProvider: { clock.now })
        XCTAssertTrue(dedup.shouldPost(text: "A"))
        XCTAssertFalse(dedup.shouldPost(text: "A"))
        XCTAssertTrue(dedup.shouldPost(text: "B"))
        XCTAssertFalse(dedup.shouldPost(text: "B"))
        // Going back to A should be allowed (last was B).
        XCTAssertTrue(dedup.shouldPost(text: "A"))
    }

    // MARK: - SpeechAudioPlayer tests

    func testSpeechAudioPlayerPlaysQueuedAudioInOrder() {
        let session = MockSpeechAudioSession()
        let first = MockSpeechPlayback(playReturns: true)
        let second = MockSpeechPlayback(playReturns: true)
        let factory = MockSpeechPlaybackFactory(playbacks: [first, second])
        let player = SpeechAudioPlayer(audioSession: session, playbackFactory: factory)

        player.enqueue(Data([0x01]))
        player.enqueue(Data([0x02]))

        XCTAssertEqual(factory.makePlaybackCallCount, 1)
        XCTAssertEqual(first.playCallCount, 1)
        XCTAssertTrue(player.isPlayingForTesting)
        XCTAssertEqual(player.queuedItemCountForTesting, 1)

        first.triggerFinish(successfully: true)
        XCTAssertEqual(factory.makePlaybackCallCount, 2)
        XCTAssertEqual(second.playCallCount, 1)
        XCTAssertTrue(player.isPlayingForTesting)
        XCTAssertEqual(player.queuedItemCountForTesting, 0)

        second.triggerFinish(successfully: true)
        XCTAssertFalse(player.isPlayingForTesting)
        XCTAssertEqual(player.queuedItemCountForTesting, 0)
    }

    func testSpeechAudioPlayerContinuesAfterDecodeError() {
        let session = MockSpeechAudioSession()
        let first = MockSpeechPlayback(playReturns: true)
        let second = MockSpeechPlayback(playReturns: true)
        let factory = MockSpeechPlaybackFactory(playbacks: [first, second])
        let player = SpeechAudioPlayer(audioSession: session, playbackFactory: factory)

        player.enqueue(Data([0x10]))
        player.enqueue(Data([0x20]))

        first.triggerDecodeError()
        XCTAssertEqual(factory.makePlaybackCallCount, 2)
        XCTAssertEqual(second.playCallCount, 1)
        XCTAssertTrue(player.isPlayingForTesting)
    }

    func testSpeechAudioPlayerSkipsFailedPlaybackAndAdvancesQueue() {
        let session = MockSpeechAudioSession()
        let failed = MockSpeechPlayback(playReturns: false)
        let good = MockSpeechPlayback(playReturns: true)
        let factory = MockSpeechPlaybackFactory(playbacks: [failed, good])
        let player = SpeechAudioPlayer(audioSession: session, playbackFactory: factory)

        player.enqueue(Data([0xAA]))
        player.enqueue(Data([0xBB]))

        XCTAssertEqual(factory.makePlaybackCallCount, 2)
        XCTAssertEqual(failed.playCallCount, 1)
        XCTAssertEqual(good.playCallCount, 1)
        XCTAssertTrue(player.isPlayingForTesting)
        XCTAssertEqual(player.queuedItemCountForTesting, 0)
    }

    // MARK: - WebSocketClient tests

    @MainActor
    func testWebSocketClientConnectedReplayUpdatesLastSpeakWithoutNewEvent() {
        let client = WebSocketClient()
        client.processTextMessageForTesting(#"{"type":"connected","lastSpeakText":"Recovered"}"#)

        XCTAssertTrue(client.isConnected)
        XCTAssertEqual(client.lastSpeakText, "Recovered")
        XCTAssertNil(client.newestSpeakTextEvent)
    }

    @MainActor
    func testWebSocketClientSpeakTextPublishesNewEvent() {
        let client = WebSocketClient()
        client.processTextMessageForTesting(#"{"type":"speak_text","text":"New summary"}"#)

        XCTAssertEqual(client.lastSpeakText, "New summary")
        XCTAssertEqual(client.newestSpeakTextEvent, "New summary")
    }

    @MainActor
    func testWebSocketClientConnectDisconnectLifecycle() {
        let client = WebSocketClient()
        client.networkingEnabledForTesting = false

        var opened: [(URL, String)] = []
        client.onSocketOpenedForTesting = { url, reason in
            opened.append((url, reason))
        }

        let url = URL(string: "ws://localhost:3000?token=test&tts=mp3")!
        client.connect(url: url, reason: "unit_test_connect")
        client.processTextMessageForTesting(#"{"type":"connected"}"#)
        XCTAssertTrue(client.isConnected)

        client.ensureConnected(url: url, reason: "unit_test_ensure")
        XCTAssertEqual(opened.count, 2)

        client.disconnect()
        XCTAssertFalse(client.isConnected)
    }
}

private final class MutableClock {
    var now: Date

    init(start: Date) {
        self.now = start
    }

    func advance(by delta: TimeInterval) {
        now = now.addingTimeInterval(delta)
    }
}

private final class MockSpeechAudioSession: SpeechAudioSessionControlling {
    private(set) var setCategoryCallCount = 0
    private(set) var setActiveCallCount = 0

    func setCategory(_ category: AVAudioSession.Category, options: AVAudioSession.CategoryOptions) throws {
        setCategoryCallCount += 1
    }

    func setActive(_ active: Bool, options: AVAudioSession.SetActiveOptions) throws {
        setActiveCallCount += 1
    }
}

private final class MockSpeechPlaybackFactory: SpeechPlaybackFactory {
    private var playbacks: [MockSpeechPlayback]
    private(set) var makePlaybackCallCount = 0

    init(playbacks: [MockSpeechPlayback]) {
        self.playbacks = playbacks
    }

    func makePlayback(data: Data) throws -> SpeechPlayback {
        makePlaybackCallCount += 1
        guard !playbacks.isEmpty else {
            throw NSError(domain: "VoiceSquadTests", code: 1)
        }
        return playbacks.removeFirst()
    }
}

private final class MockSpeechPlayback: SpeechPlayback {
    var onFinish: ((Bool) -> Void)?
    var onDecodeError: ((Error?) -> Void)?
    private let playReturns: Bool
    private(set) var playCallCount = 0

    init(playReturns: Bool) {
        self.playReturns = playReturns
    }

    func prepareToPlay() {}

    func play() -> Bool {
        playCallCount += 1
        return playReturns
    }

    func triggerFinish(successfully: Bool) {
        onFinish?(successfully)
    }

    func triggerDecodeError() {
        onDecodeError?(NSError(domain: "VoiceSquadTests", code: 2))
    }
}
