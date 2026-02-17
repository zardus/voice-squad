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

The system runs as 4 containers (see `docker-compose.yml`): workspace (dockerd + tmux), captain (captain CLI agent), voice-server (voice pipeline), tunnel (cloudflared quick tunnel), and pane-monitor (idle worker detection). The tunnel runs in its own container so the voice server can be restarted without losing the tunnel URL.

## Project Structure

Each component lives in its own self-contained directory under `src/`, with its own `Dockerfile` and `entrypoint.sh`:

- `src/workspace/` — Docker-in-Docker workspace with dev tools (dockerd, tmux, Claude Code, Codex, nix, python, node)
- `src/captain/` — Captain agent (Claude or Codex CLI), instructions, restart/speak/switch-account scripts
- `src/voice-server/` — Voice interface server and PWA (Express + WebSocket, STT, TTS, tmux bridge, status daemon)
  - `public/` — PWA frontend (HTML, JS, CSS, manifest, icons)
- `src/tunnel/` — Cloudflared quick tunnel for external access
- `src/pane-monitor/` — Idle worker detection daemon
- `src/ios/` — iOS app (unchanged)

Each component is fully self-contained with no shared build contexts.

`docker-compose.yml` at the root orchestrates the 5 containers. Port 3000 is exposed for LAN access.

`home/` is the shared persistent volume mounted into the container at `/home/ubuntu`. It is gitignored.

## Deploying Changes

After editing source files, you **must** run the deploy script to apply changes to the live server:

```bash
./utils/update.sh                   # hot-update code + restart voice server
./utils/update.sh --restart-captain # also restart the captain agent
```

This pulls latest git, copies `src/` files to `/opt/squad/` (the installed location), and restarts the voice server. The cloudflared tunnel runs in a separate container and is unaffected by voice server restarts. The captain agent is kept alive (unless `--restart-captain` is passed).

**Key paths:**
- Source: `src/voice-server/` — server code; `src/voice-server/public/` — frontend (index.html, app.js, style.css)
- Installed (live): `/opt/squad/voice/` — the voice server runs from here, not from `src/`
- Pane monitor: `src/pane-monitor/pane-monitor.sh` → installed to `/opt/squad/pane-monitor.sh`

**Logs:**
- Deploy output: `/tmp/update.log`
- Voice server: `/tmp/voice-server.log`

## Key Architecture Details

- **Inside the container**, files are installed to `/opt/squad/`. The captain entrypoint copies instruction files to `/home/ubuntu/` with the correct filename (CLAUDE.md for claude captains, AGENTS.md for codex captains).
- **Captain runs in tmux**: The captain CLI runs in window 0 of a tmux session called `captain`.
- **Voice interface**: A phone PWA connects via WebSocket through a cloudflared quick tunnel (`*.trycloudflare.com`) running in a separate `tunnel` container. Auth is via a random token embedded in the URL (shown as a QR code at startup in the tunnel container logs). The pipeline: STT (Whisper) -> send to captain via tmux -> poll output -> summarize (Claude Sonnet) -> TTS (OpenAI) -> play on phone.
- **Environment variables**: `SQUAD_CAPTAIN` (claude|codex), `VOICE_TOKEN` (auto-generated).
- The container runs `--privileged` for Docker-in-Docker support. The Docker container itself is the sandbox boundary.
## Running Tests

**Tests run as overrides on the real compose stack** via `docker-compose.test.yml`, fully isolated from any live deployment. The test file layers on top of `docker-compose.yml` — services inherit their real images and entrypoints, with only test-specific overrides (ephemeral volumes, dummy API keys, shared PID/network namespaces).

```bash
# Run all tests (from the repo root)
./test.sh

# Run a specific test file
./test.sh api.spec.js

# Run captain E2E tests (requires real API keys in env or home/env)
TEST_CAPTAIN=1 ./test.sh captain.spec.js
```

`test.sh` builds images once, then launches each test file in its own fully isolated Docker Compose stack (separate `-p` project), so all tests run in parallel. On exit it tears down all stacks (`down -v --remove-orphans`).

**Test overrides** (see `docker-compose.test.yml`):
- All services run their **real entrypoints** with real API keys
- `./home` is swapped for an ephemeral `test-home` volume
- **test-runner** — lightweight container (Ubuntu + Node + Playwright + Chromium) that connects to services via Docker networking (`voice-server:3000`) and tmux via shared socket volumes

## Development Workflow

Follow this process for every change:

1. **Do the work.** Implement the feature, fix the bug, write tests, etc.
2. **Commit and push to a feature branch.** Never commit directly to `main`. Use a descriptive branch name (e.g. `feat/thing`, `fix/bug-name`).
3. **Open a PR against `main`** using `gh pr create`. Write a clear title and description.
4. **Wait for CI and reviews.** Poll with `gh pr checks` (for CI status) and `gh pr view --comments` (for review feedback).
5. **Address review comments.** Make the requested code changes, commit, and push to the same branch.
6. **Fix CI failures.** Read the failure logs, fix the code, commit, and push.
7. **Iterate steps 4–6** until CI is fully green and all review comments are resolved.
8. **Report that the PR is ready.** Do **not** merge — the human decides when to merge.
