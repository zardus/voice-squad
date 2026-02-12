# VoiceSquad Discord Voice Interface Research

Date: February 12, 2026

## 1. Executive Summary

Discord voice is technically feasible for VoiceSquad, but the best path is **a bridge service** (Discord bot process) that feeds the existing VoiceSquad STT/command/TTS pipeline instead of replacing the current server.

Bottom line:
- **Feasible now in Node.js** with `discord.js` + `@discordjs/voice` for join/playback and receive streams.
- **Receive audio is possible but not "officially first-class stable"** in ecosystem docs; multiple libraries flag caveats, and Discord voice protocol changes (notably **DAVE/E2EE required by March 1, 2026**) increase maintenance risk.
- **Latency can be good enough for conversational command-and-response** if turn-taking is explicit (push-to-talk or wake word + endpointing), but barge-in/full duplex assistant UX will be harder.
- **Policy/compliance is the major non-technical risk**: voice capture requires explicit user notice/consent and clear data handling.

Recommended approach:
1. Build a **Discord Voice Gateway service** (separate process) that owns Discord voice I/O.
2. Reuse existing VoiceSquad server APIs/modules for STT -> tmux command -> response TTS.
3. Start with **single designated speaker** mode, then add multi-user routing/permissions.
4. Treat Discord as an additional client channel, not a full replacement for PWA or future native app.

## 2. Detailed Findings

## 2.1 Discord Voice Bot Fundamentals

### How bots join and stay in voice channels
- Bot joins by opening a voice connection tied to guild/channel voice state updates and voice server updates (Gateway + UDP voice path).
- In `@discordjs/voice`, this is managed with `joinVoiceChannel(...)` and `VoiceConnection` lifecycle/status handling (`Signalling`, `Connecting`, `Ready`, reconnect states).
- Discord voice transport is separate from regular message events: websocket signaling + encrypted RTP/UDP media path.

Sources: Discord Voice Connections docs, Discord Gateway docs, `@discordjs/voice` API docs.[1][2][3]

### Libraries/frameworks
- Node:
  - `discord.js` + `@discordjs/voice` (most common maintained stack for JS).
  - Eris has voice support but less mainstream for receive/STT workflows.
- Python:
  - `discord.py` core explicitly does **not** support voice receive in-tree.
  - Community extension `discord-ext-voice-recv` adds receive support.
- Other ecosystems (Go/.NET/Java) exist, but examples are thinner for robust STT receive pipelines.

Sources: `discord.py` FAQ, `discord-ext-voice-recv`, `discord.js` voice docs.[4][5][3]

### Audio input vs output support
- Output (playback/TTS): widely supported and common.
- Input (receiving user speech): supported in JS and extensions, but often documented with caveats (not all use cases receive equal maintenance/testing).
- `@discordjs/voice` explicitly warns audio receive is "not documented by Discord" and has "many holes" in behavior.

Source: `@discordjs/voice` docs warning.[3]

### Latency characteristics and real-time feasibility
- Discord media transport latency is generally low enough for live conversation transport.
- Practical end-to-end latency for VoiceSquad will be dominated by:
  - speech endpoint detection
  - STT model turnaround
  - captain command execution time
  - TTS generation + stream buffering
- **Inference:** For short commands, conversational turn latency in roughly low-seconds is realistic; sub-second interactive interruption UX is unlikely without substantial streaming/partial-result work.

Sources: Discord voice protocol docs + existing VoiceSquad STT/TTS flow in `src/voice/server.js`, `src/voice/stt.js`, `src/voice/tts.js`.[1][6][7][8]

### Required permissions/intents
- OAuth scopes: `bot` (plus `applications.commands` if slash commands are used).
- Bot permissions typically needed:
  - `CONNECT`
  - `SPEAK`
  - optionally `VIEW_CHANNEL`, `USE_VAD`, `PRIORITY_SPEAKER` depending on behavior.
- Gateway intents:
  - `Guilds`
  - `GuildVoiceStates` (needed to track/join/move voice state context).

Sources: Discord permission flags docs, Discord application intents docs, discord.js intent enum docs.[9][10][11]

## 2.2 Receiving Voice Audio from Discord

### Can bots receive individual user streams?
Yes, practically yes in current ecosystem stacks.
- Discord signaling includes speaking events and SSRC/user mappings.
- In `@discordjs/voice`, receiver APIs support per-user subscriptions.

Sources: Voice opcode docs (Speaking), `@discordjs/voice` `VoiceReceiver`/related APIs.[12][13]

### Technical receive path
- Discord voice audio arrives as encrypted RTP/UDP packets (Opus payloads).
- Libraries decrypt and expose Opus packet streams; you typically decode Opus -> PCM for STT.

Sources: Discord voice protocol docs, `@discordjs/voice` receiver docs.[1][13]

### Raw PCM/WAV extraction
- You can decode Opus to PCM in process (commonly via prism/ffmpeg/opus libs), then wrap/send to STT API.
- WAV is just PCM with headers; most STT APIs accept raw containers (wav/webm/ogg/flac/etc.), so no strict need to persist WAV files.

Sources: Voice receive docs + VoiceSquad STT accepted formats in `src/voice/stt.js`.[3][7]

### STT piping approach
- Recommended: user stream -> short speech segment buffer -> STT API call -> text command.
- VoiceSquad already has server-side transcription integration with OpenAI transcription endpoint; Discord bridge can call the same module/API.

Source: `src/voice/stt.js` and `src/voice/server.js` audio command path.[6][7]

### Speaker start/stop detection (VAD)
- Discord emits speaking-related signals; library layers also provide speaking map/events and end-behavior strategies (e.g., end after silence).
- For reliability, combine transport speaking signals with server-side silence thresholding before sending STT requests.

Sources: Discord speaking opcode docs, `@discordjs/voice` receiver API/end behavior docs.[12][13]

### Multi-user distinction
- Yes. Streams can be mapped per user via SSRC/user mapping and per-user subscriptions.
- **Design implication:** you need policy for collisions (two users speak at once) and permission model for who can command the captain.

Sources: Discord speaking + SSRC mapping docs.[12][13]

## 2.3 Sending Voice Audio to Discord

### TTS playback mechanics
- Create voice connection, create audio player/resource, stream Opus/PCM source to channel.
- `@discordjs/voice` supports resource pipeline and playback status events.

Source: `@discordjs/voice` docs/examples.[3]

### Real-time streaming vs file playback
- You can stream generated audio directly (no file required).
- For minimal latency, prefer streaming chunks/pipe from TTS response over write-then-read temp files.

Source: `@discordjs/voice` resource/player model + VoiceSquad current in-memory TTS buffers (`src/voice/tts.js`).[3][8]

### Audio formats
- Discord voice transport is Opus-centric; libraries also support PCM inputs that are encoded to Opus.
- VoiceSquad currently requests OpenAI TTS with `response_format: "opus"`, which aligns well with Discord playback flow.

Sources: Discord voice protocol docs, VoiceSquad `src/voice/tts.js`.[1][8]

### Latency (TTS -> heard in channel)
- Major components: TTS generation + queueing + Discord playback start.
- **Inference:** If TTS synthesis stays sub-second to low-seconds and playback queue is clear, perceived response delay should be acceptable for assistant turn-taking.

## 2.4 Integration Architecture for VoiceSquad

Current VoiceSquad pipeline (from code):
1. Client sends audio chunks over WebSocket.
2. `server.js` triggers `transcribe(...)`.
3. Text sent to captain via `tmux-bridge`.
4. Summary/speak events emitted back to clients and optional TTS playback.

Sources: `src/voice/server.js`, `src/voice/stt.js`, `src/voice/tts.js`, `src/voice/tmux-bridge.js`.[6][7][8][14]

### Best integration shape
- **Recommendation:** separate Discord bridge service.
- Discord bridge responsibilities:
  - bot login, guild/channel binding
  - receive per-user audio, segmenting, VAD gating
  - send audio segments to VoiceSquad server (internal API/module call)
  - receive text/TTS output and play into channel

Why separate service:
- isolates Discord protocol churn and reconnect behavior
- lets existing PWA/server continue unchanged
- easier rollback and testing

### Single-user vs multi-user
- Phase 1: single designated controller user ID.
- Phase 2: role-based allowlist + optional "floor control" (only current speaker can command).
- Multi-user requires anti-collision logic and explicit attribution in prompts ("User X said ...").

## 2.5 Hosting, Reliability, and Operational Behavior

### 24/7 runtime
- Technically yes: standard always-on bot deployment (VM/container).
- Needs health checks and process supervision; rejoin logic after gateway drops/network blips.

### Disconnect/reconnect
- Discord gateway and voice have resumable/reconnect semantics; bot should track voice state and rejoin target channel when needed.
- Implement exponential backoff + watchdog.

Sources: Discord Gateway lifecycle/resume docs, voice connection status model in `@discordjs/voice`.[2][3]

### Rate limits and connection limits
- Normal REST/gateway rate limits apply; avoid reconnect loops and burst joins.
- Discord provides session start limit information for gateway identify budgeting.

Source: Discord Get Gateway Bot docs (`session_start_limit`) + gateway rate limit guidance.[15][2]

### "Listening-only" restrictions
- No direct rule found that forbids a bot from being in voice and processing audio per se.
- But Discord developer policies require clear user permission/consent and lawful handling of collected content/data.

Source: Discord Developer Policy (consent/permission clauses).[16]

## 2.6 Privacy, Legal, and Terms Considerations

### Discord policy posture
- Discord Developer Policy requires developers to:
  - obtain necessary permissions/consent before actions on behalf of users
  - clearly disclose data collection/use/retention
  - avoid unauthorized/surprising collection

Source: Discord Developer Policy.[16]

### Legal considerations (US-centric baseline)
- Voice capture can trigger wiretap/recording consent laws.
- Federal baseline is one-party consent; some US states require all-party consent for recorded conversations.

Source: U.S. DOJ/Justice Manual on interception consent exception; legal overviews of two-party/all-party states.[17][18]

### Practical compliance requirements
- Explicit channel notice (bot intro + text disclosure).
- Consent gate before first use in a guild.
- Data minimization: transient audio buffers, short retention, clear deletion policy.
- Audit trail and configurable opt-out.

**Inference:** This is mandatory for production; technical feasibility is not the primary blocker.

## 2.7 Existing Projects and Examples

### Relevant open-source examples
- `discord-ext-voice-recv` (Python extension): demonstrates receive pipeline missing in core `discord.py`.
- `discord-speech-recognition` (Node package): shows STT command patterns and wake-word style interaction.
- Multiple bot repos demonstrate playback maturity; receive + STT tends to be custom glue with maintenance burden.

Sources: project docs/pages.[5][19]

### What appears to work
- Push-to-talk or clearly segmented turns.
- Single speaker/owner control mode.
- Playback of generated speech in same channel.

### What appears fragile
- Overlapping speakers, music/noise channels, and interruption handling.
- Library/version drift when Discord voice internals evolve.
- Long-running unattended voice sessions without robust watchdogs.

## 2.8 Comparison to Current PWA Approach

### High-level pros/cons of Discord voice
Pros:
- No custom mobile UI install flow; users already on Discord.
- Native social/multi-user context (voice channel membership, identity, roles).
- Centralized control point for squads shared across teammates.

Cons:
- More protocol complexity than browser mic capture.
- Policy/legal overhead around voice capture in group channels.
- Discord dependency risk (API/voice changes, moderation/compliance expectations).
- Harder to deliver private low-latency personal assistant experience than dedicated app.

### Versus native iOS app
- Native iOS gives strongest device integration and UX control.
- Discord gives faster distribution/community access but less control and more platform dependency.

## 3. Architecture Recommendation

Recommended target architecture:

1. **Discord Voice Bridge (new service)**
- Stack: Node.js + `discord.js` + `@discordjs/voice`.
- Responsibilities: join/rejoin, receive per-user audio, VAD/segmentation, playback.

2. **VoiceSquad Core (existing)**
- Keep `stt.js`, command dispatch (`tmux-bridge.js`), and `tts.js` as system of record.
- Expose/standardize an internal interface for `transcribeAndDispatch` and `speak`.

3. **Control Plane**
- Guild/channel allowlist, designated speaker, role checks, command prefix or wake phrase.
- Admin slash commands for join/leave/status/privacy disclosure.

4. **Safety & Compliance Layer**
- Consent handshake, disclosure message, retention config, per-guild policy settings.

5. **Observability**
- Metrics: packet loss, reconnect count, STT latency, command turnaround, TTS delay.
- Structured logs with guild/channel/user IDs (hashed where appropriate).

Rationale:
- Minimizes risk to existing PWA path.
- Keeps Discord-specific volatility contained.
- Enables phased rollout and A/B against current PWA latency/accuracy.

## 4. Implementation Roadmap (Rough Phases)

Phase 0: Validation spike (1-2 weeks)
- Standalone prototype joins one test channel, captures one allowed user, sends transcript to terminal.
- Measure end-to-end latency and transcription quality in realistic noise.
- Validate DAVE/E2EE compatibility path before March 1, 2026 requirement date.

Phase 1: MVP bridge (2-4 weeks)
- Productionized bridge service with reconnect/watchdog.
- Single-user command mode + TTS reply playback.
- Basic moderation controls and slash commands.

Phase 2: Hardening (2-4 weeks)
- Multi-user arbitration rules and permissions.
- Queueing, interruption policy, backpressure controls.
- Telemetry, alerting, and failure recovery.

Phase 3: Compliance and rollout (1-2 weeks)
- Privacy notices, retention toggles, consent records.
- Runbook, incident handling, and guild onboarding docs.

Phase 4: Optional enhancements
- Wake word and speaker verification.
- Streaming partial STT for faster turn detection.
- Hybrid mode: Discord input, mobile/web output fallback.

## 5. Key Risks and Unknowns

1. **Discord voice protocol change risk**
- DAVE/E2EE transition and future changes can break receive stacks if dependencies lag.

2. **Receive-path stability risk**
- Audio receive remains less mature/documented than playback in common libraries.

3. **Compliance/legal risk**
- Group-channel voice processing creates consent and retention obligations across jurisdictions.

4. **UX risk in multi-speaker rooms**
- Cross-talk and interruptions can reduce command accuracy and user trust.

5. **Operational risk**
- Long-lived voice connections need robust reconnect logic, monitoring, and anti-thrashing.

6. **Abuse/security risk**
- Bot command injection via untrusted speakers unless identity/role gating is strict.

## 6. Comparison Table: PWA vs Native iOS vs Discord Voice

| Dimension | Current PWA | Native iOS App | Discord Voice Bot |
|---|---|---|---|
| Setup friction | Medium (open URL/install PWA) | High (build/distribute via TestFlight/App Store) | Low for Discord users (invite bot/join channel) |
| Core voice transport control | Medium (browser constraints) | High | Medium (Discord-managed transport) |
| Multi-user shared control | Low | Low-Medium | High |
| Privacy surface | User-device centric | User-device centric | Group-channel capture; highest policy burden |
| STT/TTS reuse with existing VoiceSquad | High | High | High (via bridge) |
| Offline/background robustness | Limited by browser | Best | Depends on bot hosting; user-side handled by Discord |
| Latency potential | Good | Best | Good (turn-based), variable under channel noise |
| Platform dependency risk | Browser changes | Apple platform policies | Discord API/voice changes |
| Best fit | Single-user personal control | Premium single-user product UX | Team/shared channel command interface |

## References

[1] Discord Docs: Voice Connections - https://discord.com/developers/docs/topics/voice-connections  
[2] Discord Docs: Gateway - https://discord.com/developers/docs/topics/gateway  
[3] `@discordjs/voice` API docs - https://discord.js.org/docs/packages/voice/main  
[4] `discord.py` FAQ (voice receive not supported) - https://discordpy.readthedocs.io/en/stable/faq.html#how-do-i-pass-a-coroutine-to-the-player-s-after-function  
[5] `discord-ext-voice-recv` package/docs - https://pypi.org/project/discord-ext-voice-recv/  
[6] VoiceSquad source: `src/voice/server.js`  
[7] VoiceSquad source: `src/voice/stt.js`  
[8] VoiceSquad source: `src/voice/tts.js`  
[9] Discord Docs: Permissions - https://discord.com/developers/docs/topics/permissions#permissions-bitwise-permission-flags  
[10] Discord Docs: Gateway Intents - https://discord.com/developers/docs/events/gateway#list-of-intents  
[11] discord.js `GatewayIntentBits` - https://discord.js.org/docs/packages/core/main/GatewayIntentBits:Enum  
[12] Discord Docs: Voice opcode Speaking - https://discord.com/developers/docs/topics/opcodes-and-status-codes#voice-voice-opcodes  
[13] `@discordjs/voice` receive classes (`VoiceReceiver`, `AudioReceiveStream`, `SSRCMap`) - https://discord.js.org/docs/packages/voice/main/VoiceReceiver%3AClass  
[14] VoiceSquad source: `src/voice/tmux-bridge.js`  
[15] Discord Docs: Get Gateway Bot (`session_start_limit`) - https://discord.com/developers/docs/resources/gateway#get-gateway-bot  
[16] Discord Developer Policy - https://discord.com/developers/docs/policies-and-agreements/developer-policy  
[17] U.S. DOJ Justice Manual (consent interception context) - https://www.justice.gov/archives/jm/criminal-resource-manual-1061-electronic-surveillance-one-party-consensual-monitoring  
[18] Legal overview of state consent variance (one/all-party) - https://www.justia.com/50-state-surveys/recording-phone-calls-and-conversations/  
[19] `discord-speech-recognition` (example ecosystem package) - https://www.npmjs.com/package/discord-speech-recognition
