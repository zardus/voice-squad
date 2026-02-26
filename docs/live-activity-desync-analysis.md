# Live Activity Desync Investigation (Main Branch)

## Scope
Investigated end-to-end path on `main` as of February 26, 2026:

1. Server state/event emission
2. APNs live activity push fanout
3. iOS notification/websocket decoding and routing
4. `Activity.update()` execution and ordering/staleness guards
5. PWA/native bridging boundaries

## End-to-End Pipeline Trace

### 1) Server emits updates
- Voice summary changes are emitted through `handleSpeakRequest` in [src/voice-server/server.js](src/voice-server/server.js:776).
- Server broadcasts websocket `speak_text` to connected clients at [src/voice-server/server.js](src/voice-server/server.js:806) and [src/voice-server/server.js](src/voice-server/server.js:814).
- Server pushes Live Activity APNs **only** from this speak path via `pushLiveActivitySummaryUpdate(...)` at [src/voice-server/server.js](src/voice-server/server.js:845).

### 2) APNs delivery payload
- Push payload is built in `sendLiveActivityUpdate` at [src/voice-server/server.js](src/voice-server/server.js:237).
- `content-state` currently hardcodes:
  - `isConnected: true` at [src/voice-server/server.js](src/voice-server/server.js:252)
  - `autoReadEnabled: true` at [src/voice-server/server.js](src/voice-server/server.js:253)
- APNs timestamp is truncated to seconds at [src/voice-server/server.js](src/voice-server/server.js:245).

### 3) iOS receives and decodes
- Foreground/response/background notification handling routes to `LiveActivityManager.handleRemoteNotification(...)` from:
  - [src/ios/VoiceSquad/VoiceSquadApp.swift](src/ios/VoiceSquad/VoiceSquadApp.swift:192)
  - [src/ios/VoiceSquad/VoiceSquadApp.swift](src/ios/VoiceSquad/VoiceSquadApp.swift:204)
  - [src/ios/VoiceSquad/VoiceSquadApp.swift](src/ios/VoiceSquad/VoiceSquadApp.swift:219)
- Decoder picks timestamp candidates in this order at [src/ios/VoiceSquad/LiveActivityManager.swift](src/ios/VoiceSquad/LiveActivityManager.swift:165):
  1. `aps.timestamp` (seconds)
  2. then richer top-level/voice_squad timestamps

### 4) LiveActivityManager applies update
- Staleness gate: `eventDate < latestAppliedEventDate` at [src/ios/VoiceSquad/LiveActivityManager.swift](src/ios/VoiceSquad/LiveActivityManager.swift:567).
- Serialized update chain around `updateTask` at [src/ios/VoiceSquad/LiveActivityManager.swift](src/ios/VoiceSquad/LiveActivityManager.swift:369).
- `Activity.update(...)` called at [src/ios/VoiceSquad/LiveActivityManager.swift](src/ios/VoiceSquad/LiveActivityManager.swift:383).
- **Important:** even if `Activity.update()` throws, `markApplied(...)` still runs at [src/ios/VoiceSquad/LiveActivityManager.swift](src/ios/VoiceSquad/LiveActivityManager.swift:387).

### 5) UI surface
- Live Activity widget renders only:
  - `latestSpeechText`
  - `isConnected`
  - `autoReadEnabled`
  at [src/ios/VoiceSquadLiveActivity/VoiceSquadLiveActivityWidget.swift](src/ios/VoiceSquadLiveActivity/VoiceSquadLiveActivityWidget.swift:20), [src/ios/VoiceSquadLiveActivity/VoiceSquadLiveActivityWidget.swift](src/ios/VoiceSquadLiveActivity/VoiceSquadLiveActivityWidget.swift:12), [src/ios/VoiceSquadLiveActivity/VoiceSquadLiveActivityWidget.swift](src/ios/VoiceSquadLiveActivity/VoiceSquadLiveActivityWidget.swift:28).

## Root Causes

## Root Cause 1: Server Pushes Only Summary Events, Not Full Activity State

### Evidence
- APNs pushes are triggered only from `/api/speak` flow (`handleSpeakRequest`) at [src/voice-server/server.js](src/voice-server/server.js:845).
- No push path exists for connection-state transitions, auto-read changes, or any other app state changes (`rg` shows only one caller of `pushLiveActivitySummaryUpdate`).

### Why this causes desync
If any non-summary state changes (or summary-equivalent state transitions that are not new `speak` text), Live Activity is not updated via APNs. In background/terminated scenarios, this leaves lock-screen state stale until next `speak_text` event.

### Proposed fix
- Introduce a canonical server-side `liveActivityState` object and a `pushLiveActivityStateUpdate(state)` function.
- Emit APNs updates from all relevant state transitions, not only speak.
- Add explicit state change endpoints/events for `isConnected` and (if intended) auto-read state.

## Root Cause 2: APNs Payload Hardcodes Wrong Fields (`isConnected`/`autoReadEnabled`)

### Evidence
- Server sets `isConnected: true` and `autoReadEnabled: true` unconditionally in push payload at [src/voice-server/server.js](src/voice-server/server.js:252) and [src/voice-server/server.js](src/voice-server/server.js:253).

### Why this causes desync
Even if app/runtime truth is disconnected or auto-read disabled, APNs updates overwrite Live Activity with optimistic values. This creates exactly the “lock screen differs from app state” symptom.

### Proposed fix
- Populate payload from actual state, never hardcoded constants.
- Ensure `voice_squad` and top-level mirrors match `content-state` exactly.
- Add tests asserting disconnected/auto-read-off payloads are preserved end-to-end.

## Root Cause 3: Timestamp Precision + Ordering Mismatch Allows Out-of-Order Rollbacks

### Evidence
- Server truncates APNs timestamp to seconds at [src/voice-server/server.js](src/voice-server/server.js:245).
- Decoder prefers coarse `aps.timestamp` first at [src/ios/VoiceSquad/LiveActivityManager.swift](src/ios/VoiceSquad/LiveActivityManager.swift:165).
- Stale check only rejects strictly older (`<`), not same-time events at [src/ios/VoiceSquad/LiveActivityManager.swift](src/ios/VoiceSquad/LiveActivityManager.swift:572).

### Why this causes desync
Multiple updates within one second can share the same `aps.timestamp`. If APNs delivers them out of order, stale guard cannot reject the rollback because timestamps are equal, so older content can overwrite newer content.

### Proposed fix
- Prefer high-resolution ISO timestamp from `voice_squad.timestamp`/top-level `timestamp` before `aps.timestamp` in decoder.
- Add a monotonic per-update sequence number in payload and stale-check on `(sequence, timestamp)`.
- If sequence absent, treat equal timestamp + different text conservatively (prefer newest arrival only if source is websocket and app active).

## Root Cause 4: Stale Cursor Advances Even When `Activity.update()` Fails

### Evidence
- On `Activity.update()` error, code logs at [src/ios/VoiceSquad/LiveActivityManager.swift](src/ios/VoiceSquad/LiveActivityManager.swift:385), but still calls `markApplied(...)` at [src/ios/VoiceSquad/LiveActivityManager.swift](src/ios/VoiceSquad/LiveActivityManager.swift:387).

### Why this causes desync
If update fails (invalidated activity, lifecycle race, etc.), app records event as applied anyway. Later legitimate updates with earlier/equal timestamps can be filtered as stale despite never having rendered, leaving Live Activity stuck.

### Proposed fix
- Call `markApplied(...)` only after successful `Activity.update()`.
- On failure, trigger recovery path: refresh resolved activity, retry once, then log structured failure metric.

## Root Cause 5: Two Independent WebSocket Truth Sources (PWA + Native) Without Reconciliation

### Evidence
- Native app opens its own websocket for Live Activity routing via `WebSocketClient` callbacks in [src/ios/VoiceSquad/VoiceSquadApp.swift](src/ios/VoiceSquad/VoiceSquadApp.swift:97).
- Embedded PWA also runs websocket connection and UI state handling in [src/voice-server/public/app.js](src/voice-server/public/app.js:942).
- Native bridge from PWA to iOS only covers auto-read message handler at [src/ios/VoiceSquad/WebView/VoiceSquadWebView.swift](src/ios/VoiceSquad/WebView/VoiceSquadWebView.swift:107); summary/connection state is not bridged.

### Why this causes desync
User-visible app UI (PWA) and Live Activity updater (native socket/APNs) can diverge under transient networking/lifecycle differences. There is no reconciliation loop to align Live Activity with currently rendered PWA state.

### Proposed fix
- Choose one authoritative stream for Live Activity updates:
  - either bridge PWA’s resolved state to native,
  - or remove PWA websocket in native host mode and render PWA from native-fed state.
- Add periodic “state snapshot reconcile” from native to Live Activity when app becomes active.

## Additional Fragility: Speak Dedup Can Suppress Needed Live Activity Retries

### Evidence
- Duplicate speak text within 5 minutes is dropped at [src/voice-server/server.js](src/voice-server/server.js:50), [src/voice-server/server.js](src/voice-server/server.js:70), and [src/voice-server/server.js](src/voice-server/server.js:786).
- Dedup path returns without websocket/apns update at [src/voice-server/server.js](src/voice-server/server.js:793).

### Why this matters
APNs is best-effort. If a push is lost and same text is re-issued, dedup suppresses retry; Live Activity can remain stale longer than expected.

### Proposed fix
- Split dedup policy by channel:
  - keep TTS/audio dedup if needed,
  - but allow live-activity push retries for duplicate text when latest successful push is unknown/old.

## Architectural Issues Making This Fragile

1. No canonical shared state model for Live Activity (summary-only push with hardcoded fields).
2. Multi-source updates (websocket + APNs + local disconnect timer + auto-read intent) without a globally ordered sequence.
3. Dual websocket consumers (PWA + native) with no state reconciliation contract.
4. Error handling updates logical ordering state even when UI update fails.

## Recommended Fix Plan (Order)

1. Fix correctness bugs first:
   - Remove hardcoded `isConnected/autoReadEnabled` in APNs payload.
   - Stop advancing stale cursor on failed `Activity.update()`.
2. Fix ordering:
   - Add monotonic `sequence` in server pushes.
   - Decode/use high-resolution timestamp before `aps.timestamp`.
3. Fix state coverage:
   - Push full state changes, not only `speak_text`.
4. Fix architecture:
   - Unify authoritative state source (or add explicit reconciliation loop).
5. Add regression tests:
   - APNs out-of-order same-second events.
   - Failed `Activity.update()` should not advance stale boundary.
   - Non-speak state change should update Live Activity.

## Conclusion
The remaining desync is not one bug; it is a combination of:
- incomplete server push coverage,
- incorrect payload values,
- timestamp/ordering weaknesses,
- and a dual-source architecture without reconciliation.

The strongest direct correctness defects are Root Causes 2, 3, and 4.
