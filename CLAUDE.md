# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Is

Squad is a multi-agent AI orchestration system. It runs inside a privileged Docker container and uses a **captain/workers** pattern: a captain agent (Claude or Codex) manages worker agents that run in tmux panes via raw tmux commands. It includes a voice interface (PWA) for controlling the captain from a phone.

## Build & Run

```bash
# Build and launch a squad (default captain: claude)
docker compose up --build

# Launch with codex as captain
SQUAD_CAPTAIN=codex docker compose up --build
```

Requires `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` environment variables on the host. Optional: `GH_TOKEN`. A `VOICE_TOKEN` is auto-generated if not provided.

The system runs as 3 containers (see `docker-compose.yml`): workspace (captain + tmux), voice-server (voice pipeline + cloudflared tunnel), and pane-monitor (idle worker detection).

## Project Structure

All build/runtime files live in `src/`:

- `Dockerfile` — Container image definition
- `entrypoint.sh` — Starts dockerd, fixes permissions, calls launch-squad.sh
- `launch-squad.sh` — Creates captain tmux session (window 0: captain CLI, window 1: voice server + cloudflared), generates auth token, displays QR code
- `captain-instructions.md` — Injected as CLAUDE.md/AGENTS.md for the captain agent at runtime

`src/voice/` — Voice interface server and PWA:

- `server.js` — Express HTTP + WebSocket server, orchestrates the voice pipeline
- `tmux-bridge.js` — Sends commands to captain via `tmux send-keys`, polls output via `capture-pane` with done detection (3s stable + prompt pattern, 120s hard timeout)
- `stt.js` — OpenAI Whisper API (audio buffer -> text)
- `tts.js` — OpenAI TTS API (text -> mp3)
- `summarize.js` — Claude API (raw terminal output -> voice-friendly 1-3 sentence summary)
- `show-qr.js` — Renders voice URL as terminal QR code for phone scanning
- `public/` — PWA frontend (HTML, JS, CSS, manifest, service worker, icons)

`docker-compose.yml` at the root orchestrates the 3 containers. Port 3000 is exposed for LAN access.

`home/` is the shared persistent volume mounted into the container at `/home/ubuntu`. It is gitignored.

## Deploying Changes

After editing source files, you **must** run the deploy script to apply changes to the live server:

```bash
./utils/update.sh                   # hot-update code + restart voice server
./utils/update.sh --restart-captain # also restart the captain agent
```

This pulls latest git, copies `src/` files to `/opt/squad/` (the installed location), and restarts the voice server. The cloudflared tunnel and captain agent are kept alive (unless `--restart-captain` is passed).

**Key paths:**
- Source: `src/voice/` — server code; `src/voice/public/` — frontend (index.html, app.js, style.css)
- Installed (live): `/opt/squad/voice/` — the voice server runs from here, not from `src/`
- Pane monitor: `src/pane-monitor.sh` → installed to `/opt/squad/pane-monitor.sh`

**Logs:**
- Deploy output: `/tmp/update.log`
- Voice server: `/tmp/voice-server.log`

## Key Architecture Details

- **Inside the container**, files are installed to `/opt/squad/`. `launch-squad.sh` copies instruction files to `/home/ubuntu/` with the correct filename (CLAUDE.md for claude captains, AGENTS.md for codex captains).
- **Captain runs in tmux**: The captain CLI runs in window 0 of a tmux session called `captain`. The voice server and cloudflared tunnel run in window 1 (`voice`). Switch between them with `Ctrl-b n`.
- **Voice interface**: A phone PWA connects via WebSocket through a cloudflared quick tunnel (`*.trycloudflare.com`). Auth is via a random token embedded in the URL (shown as a QR code at startup in the voice tmux window). The pipeline: STT (Whisper) -> send to captain via tmux -> poll output -> summarize (Claude Sonnet) -> TTS (OpenAI) -> play on phone.
- **Environment variables**: `SQUAD_CAPTAIN` (claude|codex), `VOICE_TOKEN` (auto-generated).
- The container runs `--privileged` for Docker-in-Docker support. The Docker container itself is the sandbox boundary.
## Running Tests

**Tests run in a separate Docker Compose stack** (`docker-compose.test.yml`), fully isolated from any live squad deployment. The test stack reuses the real workspace, voice-server, and pane-monitor images alongside a lightweight test-runner container (Playwright + Chromium).

```bash
# Run all tests (from the repo root)
./test.sh

# Run a specific test file
./test.sh api.spec.js
```

`test.sh` uses `docker compose -p voice-squad-test` to namespace containers, networks, and volumes away from production. On exit it tears everything down (`down -v --remove-orphans`).

**Test architecture** (see `docker-compose.test.yml`):
- **workspace** — real image, entrypoint overridden to just start tmux (no agents, no dockerd)
- **voice-server** — real image + real entrypoint with dummy API keys
- **pane-monitor** — real image + real entrypoint
- **test-runner** — lightweight: Ubuntu + Node + Playwright + Chromium + tmux client

All services share the workspace PID/network namespace so `localhost:3000`, `pgrep`, and `tmux` commands work transparently from the test-runner.
