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

- macOS with Xcode 15+
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

`.github/workflows/ios-build.yml` builds and runs unit tests on `macos-14` for iOS Simulator.

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

