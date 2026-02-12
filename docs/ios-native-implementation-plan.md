# VoiceSquad Native iOS App: Implementation Plan (Research)

Date: February 12, 2026

This document builds on `docs/ios-app-research.md` and goes deeper into practical implementation details for a native iOS client for VoiceSquad, with an emphasis on AirPods controls, background audio, and TestFlight distribution.

Scope: RESEARCH ONLY (no code).

---

## 1. Executive Summary and Recommended Path

### Recommended path (fastest to a real on-device test)

1. **Native SwiftUI app** with a thin, purpose-built UX for:
   - connect/auth to the existing VoiceSquad voice server
   - push-to-talk capture
   - playback of server TTS responses
   - best-effort AirPods “press/squeeze” support via media remote commands
2. **Do development on Linux**, but plan for **Mac-based build/sign/test** via:
   - a borrowed/owned Mac, OR
   - a cloud Mac (MacStadium), OR
   - CI macOS runners (GitHub Actions) once signing is set up
3. **Avoid “WKWebView wrapper first”** unless the goal is explicitly “ship something quickly that mostly behaves like today’s PWA”. A hybrid wrapper does not remove the need for Xcode/macOS and tends to create tricky audio/lifecycle integration work.

### Why

- iOS-native is the only way to get:
  - the strongest OS-level audio lifecycle control (AVAudioSession, interruptions, route changes)
  - Live Activities (ActivityKit) for lock-screen status (nice-to-have)
  - the “best possible” integration with headset/remote controls (even though raw squeeze is not exposed)
- Your existing backend already has a usable WebSocket protocol that a native app can implement with limited backend changes (with one important caveat: the current TTS format is likely not iOS-friendly).

### Key technical caveat to address early

- The current voice server TTS path uses OpenAI TTS `response_format: "opus"` and sends it as “audio/ogg” over WebSocket (`src/voice/tts.js`, `src/voice/server.js`). **iOS AVFoundation does not reliably support Ogg Opus playback.**
  - Practical implication: for native iOS, plan to switch server TTS output to **MP3 or AAC/M4A** (preferred) or introduce a native Opus decoder (not recommended for MVP).

---

## 2. Linux vs Mac Development Breakdown

### What you can do effectively from Linux

- Write Swift/SwiftUI code, networking layer, and app architecture in an editor (VS Code/Neovim/JetBrains).
- Write the shared protocol spec and keep server changes in this repo.
- Run static checks and formatting for Swift (if you standardize on SwiftFormat/SwiftLint later).
- Implement the backend changes (Node.js) and update the WebSocket contract.
- Set up CI pipelines (GitHub Actions YAML) that run on macOS runners.

### What still requires macOS (practically, always)

- **Xcode** project creation/maintenance for iOS targets (and especially for:
  - entitlements/capabilities setup
  - signing/provisioning
  - UI previews/simulator workflows
  - pushing builds to TestFlight/App Store Connect)
- **Compilation/linking against iOS SDK**, running on simulator/device, debugging.
- **Code signing** and provisioning profiles (you can automate parts, but the toolchain remains Xcode/macOS).
- **App Store submission** (Xcode or Transporter tooling is macOS-native).

### “Can we build iOS on Linux?”

In practice: **you can’t produce a shippable iOS `.ipa` entirely on Linux** because Apple’s iOS SDK tooling is tied to Xcode/macOS.

### Cross-platform frameworks: can they “build iOS from Linux”?

In practice: you can do substantial app development on Linux, but **the iOS build step still requires macOS/Xcode** (locally or in CI).

- React Native:
  - You can write JS/TS on Linux, but the iOS target uses Xcode toolchains.
- Flutter:
  - Flutter tooling is cross-platform, but iOS builds require macOS/Xcode.
- Capacitor:
  - Your web code is portable, but the iOS shell is an Xcode project; building/signing is macOS-bound.

### Cloud Mac options (practical)

You can treat macOS as a “build appliance”:

- **MacStadium** (rent a Mac mini / Mac Studio).
  - Best when you need interactive debugging (AirPods/route-change testing).
- **GitHub Actions macOS runners**
  - Best for automated builds and fast iteration once the project compiles.
  - Not great for debugging headset gestures.
- **Codemagic**
  - Best if you want a managed “CI + signing + TestFlight” experience.

### Cheapest/fastest path to get on one test device

Pick based on what “test device” means:

1. **Fastest for basic on-device testing (no TestFlight):**
   - Use *any* Mac with Xcode, plug in the iPhone, run to device.
   - This can work even without paying for the Apple Developer Program, but has limitations (provisioning, entitlements).
2. **Fastest for “install over the air” to one iPhone (TestFlight):**
   - Requires **Apple Developer Program** membership ($99/yr).
   - Use a cloud Mac or GitHub Actions to build and upload to TestFlight.

Pragmatic recommendation:
- For week-1 validation, borrow/rent a Mac for a day and run directly to your device.
- If it’s immediately clear you need push notifications / Live Activities / repeatable installs, buy the Apple Developer Program and set up TestFlight + CI early.

---

## 3. Architecture Recommendation (Practical)

### High-level architecture

**iOS App (SwiftUI)**
- WebSocket client (`URLSessionWebSocketTask`)
- Audio capture (AVAudioSession + AVAudioRecorder or AVAudioEngine)
- Audio playback (AVAudioPlayer / AVPlayer)
- Background/interrupt handling (AVAudioSession notifications)
- Remote commands (MPRemoteCommandCenter)
- Optional: APNs + ActivityKit

**Existing VoiceSquad Voice Server (Node.js)**
- Already provides:
  - `wss://.../?token=...` WebSocket
  - `/api/status`, `/api/completed-tasks`, `/api/voice-history`, `/api/speak` etc.
  - WebSocket “audio_start + binary chunks + audio_end” ingestion (`src/voice/server.js`)
  - STT via OpenAI transcriptions (`src/voice/stt.js`)
  - TTS via OpenAI speech (`src/voice/tts.js`)

### Minimal iOS app features (MVP)

1. **Connect and authenticate**
   - Use existing `token` query param model to connect to WebSocket.
   - Store token + server URL in Keychain/UserDefaults.
2. **Push-to-talk**
   - Press and hold in UI to record.
   - On press: send `{"type":"audio_start","mimeType":"audio/mp4"}`.
   - Stream binary chunks OR upload a single file as binary frames.
   - On release: send `{"type":"audio_end"}`.
3. **Receive transcription + responses**
   - Handle JSON frames:
     - `connected`
     - `transcribing`, `transcription`, `stt_error`
     - `tmux_snapshot` for a “terminal” view (optional for MVP)
     - `speak_text` (followed by a binary audio message)
   - When binary audio is received, decode/play it.
4. **AirPods “squeeze” best-effort**
   - Map headset remote actions (play/pause/next/previous) to talk state transitions.

### Data contract notes (important for native)

The current WebSocket contract relies on ordering:
- server sends `{"type":"speak_text",...}` then sends a *binary* message containing audio bytes.

On iOS, you must implement the same framing assumption:
- “next binary frame after speak_text is the audio for that speak_text”.

If you want to harden this:
- add an explicit `audio_id`, content-type, length metadata, and/or wrap audio in a JSON envelope (base64) at the cost of bandwidth.

### Audio capture choices

Option A: AVAudioRecorder (simplest)
- Configure `AVAudioSession` for record/playback.
- Record to a temporary `.m4a` (AAC) file.
- Read bytes and send over WebSocket.

Option B: AVAudioEngine (more control)
- Capture PCM buffers, optionally encode (AAC/Opus) yourself.
- More work, but enables streaming better and can reduce latency.

For MVP: AVAudioRecorder is usually the fastest path.

### Background audio session

If you want AirPods remote commands to work reliably and allow “hands-free” usage, plan for:
- `UIBackgroundModes` with `audio`
- `AVAudioSession` category likely `.playAndRecord` with options such as:
  - `.allowBluetooth` (headset mic)
  - `.defaultToSpeaker` (if no headset)
- Handling interruptions:
  - incoming calls, Siri, route changes, Bluetooth disconnects

App Review risk:
- Background audio/recording must have a clear user benefit and obvious UI state (“Recording” indicator, explicit permission prompts).

### Recommended iOS client implementation sketch (no code, but concrete APIs)

- WebSocket:
  - `URLSessionWebSocketTask` to connect to `wss://HOST/?token=...`
  - Receive loop must handle:
    - text frames (JSON)
    - binary frames (audio)
  - Send loop must send:
    - `audio_start` JSON
    - binary audio frames
    - `audio_end` JSON

- Recording:
  - `AVAudioSession` configured once; re-activated per session.
  - `AVAudioRecorder` recording to an `.m4a` file (AAC) is simplest.

- Playback:
  - Prefer server returning MP3 or AAC/M4A so playback can use AVFoundation without custom codecs.

### Push notifications + worker status updates

Two complementary channels:

- Foreground: WebSocket live updates.
- Background: APNs notifications when tasks complete or require attention.

Server-side:
- Add a device registration endpoint for APNs device tokens.
- Add event fanout to send push on completion/status-change.

Client-side:
- Request notification permission.
- Register for remote notifications, send device token to backend.
- Present push with:
  - “Task complete: …”
  - “Worker error: …”

### Live Activity (nice-to-have)

If you implement ActivityKit:
- Start a Live Activity for “current session”.
- Update it locally when app is foregrounded.
- Use ActivityKit push updates for background updates from backend (requires additional APNs configuration and a per-activity push token flow).

---

## 4. AirPods Controls (Deep Dive)

### The reality: what you can and cannot detect

- There is **no public API** that gives you raw AirPods “squeeze” gesture events as unique callbacks (e.g., single squeeze vs double squeeze vs long squeeze) independent of what iOS chooses to do with those gestures.
- What you *can* do in third-party apps is handle **high-level media remote commands** when your app is the system’s “now playing” app (or is otherwise receiving remote command events).

This means:
- You are not implementing “squeeze detection” per se.
- You are implementing “media remote command handling”, and you rely on iOS mapping AirPods gestures to those commands.

### MPRemoteCommandCenter approach (best-effort PTT)

Core idea:
- When a “voice session” is active, the app becomes a now-playing app and listens for:
  - togglePlayPause (common for a single press)
  - nextTrack (commonly double press)
  - previousTrack (commonly triple press)
- Then map those to PTT state transitions.

Suggested mapping:
- `togglePlayPause`:
  - if idle: start recording (PTT start)
  - if recording: stop recording (PTT stop)
  - if playing back: interrupt/stop playback
- `nextTrack`:
  - optional: “interrupt captain” or “switch worker”
- `previousTrack`:
  - optional: “repeat last TTS” or “reconnect”

Practical notes:
- Many apps find remote commands more reliable when they also:
  - set `MPNowPlayingInfoCenter.default().nowPlayingInfo`
  - keep an `AVAudioSession` active
  - sometimes have an active playback item (this is the uncomfortable part: iOS is optimized for media playback apps)

### Which AirPods gestures map to which commands?

There is no guaranteed, public “gesture identity” signal. What you typically see is the resulting remote command action iOS chooses to send.

Common default media mappings (varies by AirPods model and user settings):

| User action on headset | iOS-level action you may receive | Typical handler |
|---|---|---|
| Single press / single squeeze | Toggle play/pause | `togglePlayPauseCommand` (or play/pause commands) |
| Double press / double squeeze | Next track | `nextTrackCommand` |
| Triple press / triple squeeze | Previous track | `previousTrackCommand` |
| Press-and-hold | Siri / Noise control | Often not delivered to 3P apps as a distinct remote command |

Treat this as “best effort” and expect variability:
- user-customized AirPods settings can change what gestures do
- iOS may route remote commands to whichever app/session it considers “now playing”

### Concrete implementation details (conceptual; no code)

1. Enter “hands-free mode”
   - Configure and activate `AVAudioSession` (likely `.playAndRecord`).
   - Populate `MPNowPlayingInfoCenter.default().nowPlayingInfo` with a minimal dictionary:
     - title: “VoiceSquad”
     - artist: “Push-to-talk”
     - playback rate: 0 or 1 depending on whether you are “playing” a response
   - Register handlers in `MPRemoteCommandCenter.shared()`:
     - `togglePlayPauseCommand`
     - optionally `nextTrackCommand`, `previousTrackCommand`

2. Remote command handler logic
   - Treat each remote command as a state machine transition (Idle <-> Recording <-> PlayingBack).
   - Make transitions idempotent and resilient:
     - ignore “start recording” if you’re already recording
     - ignore “stop recording” if not recording

3. Keep it user-controlled
   - Provide a visible toggle “Enable headset controls”.
   - Explain limitations explicitly (you’re reacting to media commands, not reading “raw squeeze”).

### Can we distinguish squeeze vs double-squeeze vs long-press?

Not directly.

What you get is the command that the OS chose to send:
- “toggle play/pause”, “next”, “previous”, etc.

If AirPods are configured such that:
- single press maps to play/pause: you can treat that as “squeeze to talk”
- double press maps to next: you can treat that as “secondary action”

Long-press:
- commonly reserved for Siri/noise control and may never be delivered as a third-party app command.

### Making it reliable enough for VoiceSquad

Design your feature as:

- “Hands-free mode” that explicitly tells the user:
  - which AirPods setting is required (e.g., press mapped to play/pause)
  - what gestures do in this app
- A fallback UI:
  - big on-screen PTT button
  - optional: lock-screen control via Live Activity

### References / examples to study

- Apple MediaPlayer docs for `MPRemoteCommandCenter`, `MPNowPlayingInfoCenter`.
- “Now Playing” / “Now Playable” Apple guidance (for apps that want remote controls).
- Community examples that show play/pause handlers firing from headset buttons, with caveats about state and audio session.

---

## 5. Distribution Plan (TestFlight)

### What you need (minimum)

1. **Apple Developer Program membership** (required to distribute via TestFlight).
2. **App Store Connect** app record (bundle id, app name, SKU).
3. Signing assets:
   - distribution certificate
   - provisioning profile
4. An `.ipa` build uploaded to App Store Connect.

### How to get the app onto one iPhone via TestFlight (without full App Store review)

Practical flow:

1. Create the app in App Store Connect.
2. Upload a build (Xcode archive, or CI upload).
3. Add yourself as an **internal tester** and install via TestFlight.

Important nuance:
- **External** TestFlight testing triggers a “Beta App Review” step.
- **Internal** testing is typically faster and often does not require the same review loop, making it the easiest way to get a build onto one device quickly.

### CI automation (recommended once the project compiles)

Target automation:
- On `main`:
  - build and run basic checks on a macOS runner
  - archive and upload to TestFlight (manual approval gate recommended)

Tools typically used:
- `xcodebuild` for building
- `fastlane` (pilot) or Xcode Cloud/Codemagic for upload and versioning
- App Store Connect API keys for CI auth (avoid password-based auth)

Secrets management:
- Store signing keys/certs/profiles as encrypted CI secrets.
- Rotate regularly.

---

## 6. Hybrid vs Fully Native Comparison (Practical)

### Option A: Fully native (SwiftUI)

Pros:
- Cleanest control over audio lifecycle, route changes, interruptions.
- Easiest path to ActivityKit and other iOS-specific features.
- Avoids “two UIs” and WKWebView debugging.

Cons:
- You re-implement UI that currently exists in the PWA.
- Requires iOS engineering time for layout and state management.

Best when:
- AirPods/background behavior matters and you want to minimize edge-case risk.

### Option B: Hybrid shell (WKWebView / Capacitor)

Pros:
- Reuse existing PWA UI and WebSocket logic.
- Faster UI parity.

Cons (important for VoiceSquad):
- Audio capture + background behavior becomes a split-brain design:
  - JS runs in a WebView with its own lifecycle constraints.
  - native layer owns the audio session if you want background reliability.
- Still requires full iOS toolchain (Xcode) and native work for:
  - MPRemoteCommandCenter handling
  - AVAudioSession background setup
  - push notifications / ActivityKit
- WKWebView background suspension can break:
  - real-time WebSocket updates
  - long sessions

Best when:
- The core goal is “ship an App Store presence quickly” with limited native features.

### “Is hybrid good enough” for AirPods squeeze-to-talk?

Hybrid can be “good enough” only if you accept:
- AirPods gestures are still only accessible via native remote commands.
- PTT must ultimately be controlled by native code (or at least reliably bridged).

If you’re doing significant native audio + remote commands anyway, the remaining benefit of hybrid is mostly UI reuse. You pay for that reuse with complexity at the native/web boundary.

Recommendation:
- For VoiceSquad, prefer **fully native** for the MVP.
- Consider hybrid only if:
  - the web UI is a hard requirement, and
  - you’re willing to own the bridging complexity.

---

## 7. Estimated Timeline and Effort

Assumptions:
- 1 iOS engineer (primary) + 0.25-0.5 backend engineer
- existing Node voice server remains the primary STT/TTS orchestrator

### Week 0.5 to 1: Tooling + first device build

- Set up Xcode project, bundle id, signing.
- Implement WebSocket connect and a basic “connected” view.
- Get a build onto a physical iPhone (direct install or TestFlight internal).

### Week 1 to 2: MVP voice loop

- PTT UI + audio recording to m4a, send over WS with `audio_start/audio_end`.
- Playback of TTS response.
- Handle interruptions and route changes for common cases.

Blocking risk to resolve here:
- Choose/adjust server TTS format for iOS playback (MP3/AAC).

### Week 2 to 3: AirPods remote controls + reliability

- MPRemoteCommandCenter handlers.
- Now Playing metadata and session lifecycle tuning.
- Decide on a user-facing “hands-free mode” contract.

### Week 3 to 5: Push notifications and status

- APNs device token registration and server fanout.
- Status screen fed by `/api/status` and/or `status_stream_update` WS messages.

### Week 5 to 7: Live Activities (optional)

- ActivityKit UI + lifecycle.
- Backend support for liveactivity pushes and token lifecycle.

### Week 7+: Hardening

- App Review compliance, privacy strings, permission UX.
- Battery/perf tuning and rate limiting (Live Activity updates).
- Crash logging and analytics (optional).

---

## Appendix: Immediate Research-Backed Action Items

1. Decide on the **native audio playback codec**:
   - Prefer MP3 or AAC/M4A from the server for iOS.
2. Decide on a “hands-free mode contract”:
   - Document which headset gestures map to which app actions.
   - Treat it as best-effort; keep UI fallback.
3. Decide build workflow:
   - borrow/rent Mac for initial setup vs straight to cloud Mac
   - choose CI upload tool (fastlane vs Codemagic vs Xcode Cloud)

---

## Sources / Reference Links

Apple (primary):
- TestFlight overview: https://developer.apple.com/testflight/
- App Store Connect Help: Add internal testers: https://developer.apple.com/help/app-store-connect/test-a-beta-version/add-internal-testers
- ActivityKit Live Activities: https://developer.apple.com/documentation/activitykit
- ActivityKit push updates: https://developer.apple.com/documentation/activitykit/starting-and-updating-live-activities-with-activitykit-push-notifications
- AVAudioSession: https://developer.apple.com/documentation/avfaudio/avaudiosession
- MPRemoteCommandCenter: https://developer.apple.com/documentation/mediaplayer/mpremotecommandcenter
- MPNowPlayingInfoCenter: https://developer.apple.com/documentation/mediaplayer/mpnowplayinginfocenter
- AirPods controls (user-facing behavior and gesture mappings): https://support.apple.com/guide/airpods/airpods-controls-devb2c431317/web

Framework/platform requirements (useful for “Linux vs Mac” decisions):
- Swift on Linux (toolchains): https://www.swift.org/download/
- Flutter iOS setup (macOS/Xcode requirement): https://docs.flutter.dev/platform-integration/ios/setup
- Capacitor iOS build requirement (macOS/Xcode unless using a hosted build service): https://ionic.io/blog/capacitor-app-development-workflow
