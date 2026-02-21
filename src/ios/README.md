# VoiceSquad iOS (Hybrid WKWebView + Native Bar)

This folder contains a thin native iOS shell for VoiceSquad:

- A `WKWebView` that loads the existing VoiceSquad web UI from your server URL.
- A native SwiftUI bottom bar that replaces the web bottom bar (`#controls`) with:
  - Auto-read toggle (synced to the web UI via JS bridge)
  - Microphone button (native recording via `AVAudioSession` / `AVAudioRecorder`)
  - Text input + Send (native WebSocket `text_command`)
- AirPods / headset controls via `MPRemoteCommandCenter` (best-effort play/pause mapping) to toggle recording.
- Native TTS playback via `AVAudioPlayer` (server sends MP3 over WebSocket when `tts=mp3` is requested).

## Prerequisites

- macOS with Xcode 26+ (iOS 26 SDK or later)
- iOS 17+ (simulator or device)
- Apple Developer account for device signing/testing (required for running on device; not required for simulator builds)

## Build Locally (Mac)

1. Open `src/ios/VoiceSquad.xcodeproj` in Xcode.
2. Select the `VoiceSquad` scheme.
3. Choose an iPhone simulator (or a device) and Build/Run.

## One-Time Mac Setup (Device Builds)

To run on a physical iPhone:

1. In Xcode, select the `VoiceSquad` target.
2. Set a Development Team in Signing & Capabilities.
3. Ensure the bundle identifier is unique for your account.
4. Build and Run on device.

For TestFlight/App Store distribution, you will need proper signing/profiles and an Archive upload workflow (often via Xcode or Fastlane).

## CI (GitHub Actions)

`.github/workflows/ios-build.yml` selects Xcode 26 and verifies iOS SDK 26+ before building for iOS Simulator.

- It does not sign or produce a distributable `.ipa`.
- Simulator builds run with `CODE_SIGNING_ALLOWED=NO`.

## Server Configuration

The app needs:

- `serverBaseURL` (e.g. `https://xxxx.trycloudflare.com`)
- `token` (the VoiceSquad `VOICE_TOKEN`)

In the app:

1. Tap the gear icon.
2. Enter the base URL and token.

Notes:

- The native client connects to WebSocket using `?token=...&tts=mp3`.
- The embedded web UI may also connect separately; the native shell disables web TTS playback to avoid double audio.

## Live Activity Update Flow

- Foreground socket path: websocket text frames are decoded by `LiveActivityUpdateEventDecoder` and routed through `LiveActivityManager.updateActivity(with:)`.
- Foreground notification path: `AppDelegate.userNotificationCenter(_:willPresent:...)` also decodes/routes incoming push payloads while the app is active.
- Background notification path: `AppDelegate.application(_:didReceiveRemoteNotification:)` uses the same decode + update path.
- Remote push registration path: `LiveActivityManager` now POSTs `activityId` + `activityPushToken` to `POST /api/live-activity/register` whenever the activity token changes.
- Activity routing: updates with explicit `activity-id` now target only that activity. Unknown IDs are logged and dropped (no fallback to another activity).
- Activity stability: `LiveActivityManager.startActivityIfNeeded()` reuses the current activity ID (stored in shared defaults) instead of creating a new activity on every app activation. This keeps APNs push tokens valid for the activity lifetime.
- Update ordering: updates are now applied serially and stale timestamped events are dropped, so delayed notification payloads cannot overwrite a newer websocket summary.

Debugging tips:

- `SharedKeys.liveActivityID` tracks the activity currently targeted for updates.
- `SharedKeys.liveActivityPushToken` stores the latest push token emitted by `activity.pushTokenUpdates`.
- `LiveActivity` logs now include routing outcomes (`selected`, `unknown requested id`, `no candidates`) and update metadata (`connected`, `textChars`) for easier stale-state diagnosis.
- Invalid websocket or APNs payloads are logged and ignored, rather than partially applied.
- Use `GET /api/live-activity/registrations?token=...` to inspect currently registered iOS activity IDs/tokens (token prefix only).

## Lifecycle Constraints (iOS/ActivityKit)

- Foreground (`scenePhase == .active`): latest summary is driven by websocket (`speak_text` / `connected`) and updates Live Activity locally.
- Background / locked while app is still running: websocket may continue for a period, and `didReceiveRemoteNotification` can update Live Activity when APNs notifications are delivered.
- Terminated app: app code does not run, so local websocket/notification callbacks cannot execute. Latest-summary updates require ActivityKit APNs liveactivity pushes sent directly to the activity push token.

Backend env required for terminated-state live updates:

- `IOS_LIVE_ACTIVITY_TOPIC` (for example, `<bundle-id>.push-type.liveactivity`)
- `IOS_LIVE_ACTIVITY_TEAM_ID`
- `IOS_LIVE_ACTIVITY_KEY_ID`
- `IOS_LIVE_ACTIVITY_PRIVATE_KEY` (PEM, `\n` escaped in env is supported)
- Optional: `IOS_LIVE_ACTIVITY_ENV=sandbox|production` (default `sandbox`)

## Lock/Background Continuity Notes

- The app now applies a disconnect grace window before publishing `Disconnected` to Live Activity:
  - `active`: 2s
  - `inactive` (transitions like lock): 12s
  - `background`: 20s
- This avoids false disconnects during foreground -> background -> lock transitions where iOS briefly pauses networking.
- `WebSocketClient` now auto-reconnects with capped exponential backoff (1s -> 15s cap) and logs reconnect attempts.
- `SilentAudioPlayer` now listens for interruption/reset lifecycle notifications and restarts the silent keepalive engine automatically.
