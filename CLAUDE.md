# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Is

Voice Squad is a multi-agent orchestration system with a **captain/workers** model:

- The **captain** agent (Claude or Codex) runs in a dedicated tmux session and dispatches work.
- **Workers** run in tmux panes on a separate tmux server.
- A phone-friendly **voice/web UI** controls the captain over WebSocket + HTTP.

`AGENTS.md` is a symlink to this file, so these instructions apply for both Claude and Codex agent tooling in this repo.

## Build & Run

```bash
# Build and launch a squad (default captain: claude)
docker compose up --build

# Launch with codex as captain
SQUAD_CAPTAIN=codex docker compose up --build
```

Required host env vars: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`  
Optional: `GH_TOKEN`, `SQUAD_CAPTAIN`, `VOICE_TOKEN`

## Current Runtime Topology (`docker-compose.yml`)

The compose stack has **5 services**:

- `workspace` — privileged Docker-in-Docker + tmux server for worker panes (`/run/squad-sockets/workspace-tmux/default`)
- `captain` — runs Claude/Codex captain in its own tmux server (`/run/squad-sockets/captain-tmux/default`)
- `voice-server` — Express/WebSocket server, STT/TTS, status + task APIs, captain control endpoints
- `tunnel` — cloudflared quick tunnel and QR output
- `pane-monitor` — idle worker alerts + captain heartbeat nudges

Shared volumes:

- `./home -> /home/ubuntu` (persistent state, gitignored)
- `sockets` Docker volume mounted at `/run/squad-sockets` (tmux sockets + speak socket across containers)

By default, compose does **not** publish port `3000` to the host; external access is through the tunnel URL shown in tunnel logs.

## Project Structure

Each runtime component is isolated under `src/` with its own Dockerfile/build context:

- `src/workspace/` — Docker-in-Docker workspace with dev tools (dockerd, tmux, Claude Code, Codex, nix, python, node)
- `src/captain/` — Captain container entrypoint + captain instructions/skills + helper scripts (`restart-captain.sh`, `switch-account.sh`, `speak`)
- `src/voice-server/` — Voice server (Express + ws), STT/TTS integrations, tmux bridge, status daemon, PWA in `public/`
- `src/tunnel/` — Cloudflared quick tunnel for external access
- `src/pane-monitor/` — Idle worker detection daemon
- `src/ios/` — iOS client app (not part of compose runtime)

## Key Runtime Paths and State

- Captain type is persisted at `/home/ubuntu/captain/config.yml` (`type: claude|codex`)
- Voice token is shared via `/home/ubuntu/.voice-token`
- Tunnel URL is shared via `/home/ubuntu/.voice-url.txt`
- Captain task files live at:
  - `/home/ubuntu/captain/tasks/pending/*.task`
  - `/home/ubuntu/captain/tasks/archived/*.{task,summary,results,title,log}`
- Image-installed code paths:
  - Captain working tree: `/opt/squad/captain`
  - Voice server code: `/opt/squad/voice`
  - Pane monitor script: `/opt/squad/pane-monitor.sh`

## Key Architecture Details

- **Dual tmux servers**:
  - Captain server socket: `/run/squad-sockets/captain-tmux/default`
  - Worker/server socket: `/run/squad-sockets/workspace-tmux/default`
  - Voice server and pane monitor read from both via `CAPTAIN_TMUX_SOCKET` and `WORKSPACE_TMUX_SOCKET`.
- **Captain lifecycle**:
  - Captain entrypoint creates the `captain` tmux session and starts tool via `/opt/squad/restart-captain.sh`.
  - Voice UI restart endpoint (`/api/restart-captain`) updates `config.yml`, then kills entrypoint `sleep` to let compose restart captain with the new tool.
- **Voice pipeline**:
  - Browser audio -> WebSocket -> OpenAI Whisper (`stt.js`) -> tmux send-keys to `captain:0`
  - Captain uses `speak` script -> Unix socket (`/run/squad-sockets/speak.sock`) -> OpenAI TTS (`tts.js`) -> audio streamed back to connected clients
- **Status and summaries**:
  - `status-daemon.js` polls tmux panes every second only while status clients are active.
  - `/api/summary` and pending-task worker status enrichment call Anthropic Haiku (with secret scrubbing).
- **PWA tabs** currently: `Terminal`, `Screens`, `Summary`, `Tasks`, `Voice`
- **Accounts/login**:
  - Voice UI supports `claude login` / `codex auth login` via `/api/login` + `/api/login-status`
  - Captain-side account switching helper: `src/captain/switch-account.sh`
- Only the `workspace` service is privileged (for Docker-in-Docker).

## Updating a Running Stack

`utils/update.sh` no longer exists in this repo.

After editing source files, rebuild/restart via compose:

```bash
# Rebuild and restart everything
docker compose up -d --build

# Or rebuild only one service you changed
docker compose up -d --build voice-server
docker compose up -d --build captain
docker compose up -d --build pane-monitor
docker compose up -d --build tunnel
docker compose up -d --build workspace
```

Useful logs:

- `docker compose logs -f voice-server`
- `docker compose logs -f tunnel`
- `docker compose logs -f captain`

## Running Tests

Primary test entrypoint is root `./test.sh`.

It layers `docker-compose.test.yml` on top of `docker-compose.yml`, builds images once, and runs each `tests/*.spec.js` file in parallel in isolated compose projects.

```bash
# Run all tests (from the repo root)
./test.sh

# Run a specific test file
./test.sh api.spec.js

# Run captain E2E tests (requires real API keys in env or home/env)
TEST_CAPTAIN=1 ./test.sh captain.spec.js
```

Notes:

- Test stack swaps `./home` for an ephemeral `test-home` volume.
- Real service entrypoints are used; API keys default to test placeholders unless overridden.
- `test-runner` container runs Playwright and connects to `voice-server:3000` over Docker networking.

There is also `utils/test.sh`, which runs Playwright against an already-running local server on `localhost:3000` (a different workflow from isolated compose tests).

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
