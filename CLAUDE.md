# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Is

Voice Squad is a multi-agent orchestration system with a **captain/workers** model:

- The **captain** agent (Claude or Codex) runs in a dedicated tmux session and dispatches work.
- **Workers** run as tmux windows inside per-project Docker containers.
- A phone-friendly **voice/web UI** controls the captain over WebSocket + HTTP.

`AGENTS.md` is a symlink to this file, so these instructions apply for both Claude and Codex agent tooling in this repo.

## Build & Run

```bash
# Build all images (workspace must be built before first run)
docker compose build
docker compose --profile build build

# Launch a squad (default captain: claude)
HOST_HOME_PATH=$(pwd)/home docker compose up

# Launch with codex as captain
SQUAD_CAPTAIN=codex HOST_HOME_PATH=$(pwd)/home docker compose up --build
```

Required host env vars: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `HOST_HOME_PATH`
Optional: `GH_TOKEN`, `SQUAD_CAPTAIN`, `VOICE_TOKEN`

`HOST_HOME_PATH` must be the absolute host path to `./home`. It is required because the voice-server creates sibling Docker containers with bind mounts to the host filesystem.

## Current Runtime Topology (`docker-compose.yml`)

The compose stack has **5 services** (workspace is build-only):

- `workspace` — build-only image (profiles: ["build"]) with dev tools (tmux, Claude Code, Codex, nix, python, node). Voice-server starts project containers from this image.
- `captain` — runs Claude/Codex captain in its own tmux server (`/run/squad-sockets/captain-tmux/default`). No Docker access; interacts with workers via tmux sockets only.
- `voice-server` — Express/WebSocket server, STT/TTS, status + task APIs, captain control endpoints, project container management (Docker socket). Has the Projects tab UI for humans to create/stop projects.
- `tunnel` — cloudflared quick tunnel and QR output
- `pane-monitor` — idle worker alerts + captain heartbeat nudges

Per-project containers (created at runtime by humans via the web UI):

- `squad-project-{NAME}` — each project gets its own container with socket at `/run/squad-sockets/projects/{NAME}/default`

Shared volumes:

- `./home -> /home/ubuntu` (persistent state, gitignored)
- `sockets` Docker volume mounted at `/run/squad-sockets` (tmux sockets + speak socket across containers)

By default, compose does **not** publish port `3000` to the host; external access is through the tunnel URL shown in tunnel logs.

## Project Structure

Each runtime component is isolated under `src/` with its own Dockerfile/build context:

- `src/workspace/` — Per-project workspace image with dev tools (tmux, Claude Code, Codex, nix, python, node). Creates `agents` tmux session on startup.
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
- Per-project directories: `/home/ubuntu/projects/{PROJECT_NAME}/`
- Image-installed code paths:
  - Captain working tree: `/opt/squad/captain`
  - Voice server code: `/opt/squad/voice`
  - Pane monitor script: `/opt/squad/pane-monitor.sh`

## Key Architecture Details

- **Per-project containers**:
  - Humans create/stop project containers via the web UI Projects tab. Voice-server manages Docker containers via `project-manager.js`.
  - Each project gets a `squad-project-{NAME}` container running the workspace image.
  - Workers are tmux windows in the project's `agents` session.
  - Captain interacts with workers via tmux sockets only (no Docker access). Captain can read project files at `/home/ubuntu/projects/{NAME}/`.
  - Socket convention: `/run/squad-sockets/projects/{PROJECT_NAME}/default`
- **Captain tmux server**:
  - Captain server socket: `/run/squad-sockets/captain-tmux/default`
  - Voice server and pane monitor discover project sockets dynamically via `PROJECTS_SOCKETS_DIR`.
- **Captain lifecycle**:
  - Captain entrypoint creates the `captain` tmux session and starts tool via `/opt/squad/restart-captain.sh`.
  - `restart-captain.sh` launches Claude with `--dangerously-skip-permissions` and Codex with `--dangerously-bypass-approvals-and-sandbox`.
  - Voice UI restart endpoint (`/api/restart-captain`) updates `config.yml`, then kills entrypoint `sleep` to let compose restart captain with the new tool.
- **Voice pipeline**:
  - Browser audio -> WebSocket -> OpenAI Whisper (`stt.js`) -> tmux send-keys to `captain:0`
  - Captain uses `speak` script -> Unix socket (`/run/squad-sockets/speak.sock`) -> OpenAI TTS (`tts.js`) -> audio streamed back to connected clients
- **Status and summaries**:
  - `status-daemon.js` polls captain tmux + all project sockets every second only while status clients are active.
  - `/api/summary` and pending-task worker status enrichment call Anthropic Haiku (with secret scrubbing).
- **PWA tabs** currently: `Terminal`, `Projects`, `Summary`, `Tasks`, `Voice`
- **Accounts/login**:
  - Voice UI supports `claude login` / `codex auth login` via `/api/login` + `/api/login-status`
  - Captain-side account switching helper: `src/captain/switch-account.sh`

## Updating a Running Stack

After editing source files, rebuild/restart via compose:

```bash
# Rebuild and restart everything
HOST_HOME_PATH=$(pwd)/home docker compose up -d --build

# Or rebuild only one service you changed
docker compose up -d --build voice-server
docker compose up -d --build captain
docker compose up -d --build pane-monitor
docker compose up -d --build tunnel

# Rebuild workspace image (used by project containers)
docker compose --profile build build workspace
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
