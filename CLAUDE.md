# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Is

Voice Squad is a multi-agent orchestration system with an **overseer/workers** model:

- The **overseer** agent (Codex or Claude) runs in a dedicated tmux session and monitors worker progress.
- **Workers** are created via the hub's web UI API and run as tmux windows inside per-project Docker containers.
- A phone-friendly **voice/web UI** controls the overseer over WebSocket + HTTP.

`AGENTS.md` is a symlink to this file, so these instructions apply for both Claude and Codex agent tooling in this repo.

## Build & Run

```bash
# Launch a squad (default overseer: codex)
docker compose up --build

# Launch with claude as overseer
SQUAD_OVERSEER=claude docker compose up --build
```

Required host env vars: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`
Optional: `GH_TOKEN`, `HOST_HOME_PATH`, `SQUAD_OVERSEER`, `VOICE_TOKEN`

`HOST_HOME_PATH` is the absolute host path to `./home`, needed for sibling container bind mounts. It is auto-detected from the hub's own Docker mounts if not set.

## Current Runtime Topology (`docker-compose.yml`)

The compose stack has **5 services** (workspace is build-only, replicas: 0):

- `workspace` — build-only image (replicas: 0, never runs) with dev tools (tmux, Claude Code, Codex, nix, python, node). Hub starts project containers from this image.
- `overseer` — runs Codex/Claude overseer in its own tmux server (`/run/squad/tmux/overseer/default`). No Docker access; monitors workers via tmux sockets only.
- `hub` — Express/WebSocket server, STT/TTS, status + task APIs, overseer control endpoints, project container management (Docker socket). Has the Projects tab UI for humans to create/stop projects and spawn workers.
- `tunnel` — cloudflared quick tunnel and QR output
- `pane-monitor` — idle worker alerts + overseer heartbeat nudges

Per-project containers (created at runtime by humans via the web UI):

- `squad-project-{NAME}` — each project gets its own container with socket at `/run/squad/tmux/projects/{NAME}/default`

Shared volumes:

- `./home -> /home/ubuntu` (persistent state, gitignored)
- `shared` Docker volume mounted at `/run/squad` — layout:
  - `tmux/overseer/default` — overseer tmux socket
  - `tmux/projects/{NAME}/default` — per-project tmux sockets
  - `auth/claude.json`, `auth/claude/`, `auth/codex/` — shared credentials (symlinked to `~/.claude.json`, `~/.claude/`, `~/.codex/` in all containers)
  - `speak.sock` — TTS speak socket
  - `ssh-agent.sock` — shared SSH agent (started by hub container)

By default, compose does **not** publish port `3000` to the host; external access is through the tunnel URL shown in tunnel logs.

## Project Structure

Each runtime component is isolated under `src/` with its own Dockerfile/build context:

- `src/workspace/` — Per-project workspace image with dev tools (tmux, Claude Code, Codex, nix, python, node). Creates `agents` tmux session on startup.
- `src/overseer/` — Overseer container entrypoint + overseer instructions/skills + helper scripts (`restart-overseer.sh`, `switch-account.sh`, `speak`)
- `src/hub/` — Hub server (Express + ws), STT/TTS integrations, tmux bridge, status daemon, PWA in `public/`
- `src/tunnel/` — Cloudflared quick tunnel for external access
- `src/pane-monitor/` — Idle worker detection daemon
- `src/ios/` — iOS client app (not part of compose runtime)

## Key Runtime Paths and State

- Overseer type is persisted at `/home/ubuntu/overseer/config.yml` (`type: codex|claude`)
- Voice token is shared via `/home/ubuntu/.voice-token`
- Tunnel URL is shared via `/home/ubuntu/.voice-url.txt`
- Task files live at:
  - `/home/ubuntu/tasks/pending/*.task`
  - `/home/ubuntu/tasks/archived/*.{task,summary,results,title,log}`
- Per-project directories: `/home/ubuntu/projects/{PROJECT_NAME}/`
- Image-installed code paths:
  - Overseer working tree: `/opt/squad/overseer`
  - Hub server code: `/opt/squad/hub`
  - Pane monitor script: `/opt/squad/pane-monitor.sh`

## Key Architecture Details

- **Per-project containers**:
  - Humans create/stop project containers and spawn workers via the hub's web UI. Hub manages Docker containers via `project-manager.js`.
  - Each project gets a `squad-project-{NAME}` container running the workspace image.
  - Workers are tmux windows in the project's `agents` session.
  - Overseer monitors workers via tmux sockets only (no Docker access). Overseer can read project files at `/home/ubuntu/projects/{NAME}/`.
  - Socket convention: `/run/squad/tmux/projects/{PROJECT_NAME}/default`
- **Overseer tmux server**:
  - Overseer server socket: `/run/squad/tmux/overseer/default`
  - Hub and pane monitor discover project sockets dynamically via `PROJECTS_SOCKETS_DIR`.
- **Overseer lifecycle**:
  - Overseer entrypoint creates the `overseer` tmux session and starts tool via `/opt/squad/restart-overseer.sh`.
  - `restart-overseer.sh` launches Claude with `--dangerously-skip-permissions` and Codex with `--dangerously-bypass-approvals-and-sandbox`.
  - Voice UI restart endpoint (`/api/restart-overseer`) updates `config.yml`, then kills entrypoint `sleep` to let compose restart overseer with the new tool.
- **Voice pipeline**:
  - Browser audio -> WebSocket -> OpenAI Whisper (`stt.js`) -> tmux send-keys to `overseer:0`
  - Overseer uses `speak` script -> Unix socket (`/run/squad/speak.sock`) -> OpenAI TTS (`tts.js`) -> audio streamed back to connected clients
- **Status and summaries**:
  - `status-daemon.js` polls overseer tmux + all project sockets every second only while status clients are active.
  - `/api/summary` and pending-task worker status enrichment call Anthropic Haiku (with secret scrubbing).
- **PWA tabs** currently: `Projects`, `Overseer`, `Tasks`, `Voice`
- **Accounts/login**:
  - Voice UI supports `claude login` / `codex auth login` via `/api/login` + `/api/login-status`
  - Overseer-side account switching helper: `src/overseer/switch-account.sh`

## Updating a Running Stack

After editing source files, rebuild/restart via compose:

```bash
# Rebuild and restart everything
HOST_HOME_PATH=$(pwd)/home docker compose up -d --build

# Or rebuild only one service you changed
docker compose up -d --build hub
docker compose up -d --build overseer
docker compose up -d --build pane-monitor
docker compose up -d --build tunnel

# Rebuild just the workspace image (used by project containers)
docker compose build workspace
```

Useful logs:

- `docker compose logs -f hub`
- `docker compose logs -f tunnel`
- `docker compose logs -f overseer`

## Running Tests

Primary test entrypoint is root `./test.sh`.

It layers `docker-compose.test.yml` on top of `docker-compose.yml`, builds images once, and runs each `tests/*.spec.js` file in parallel in isolated compose projects.

```bash
# Run all tests (from the repo root)
./test.sh

# Run a specific test file
./test.sh api.spec.js

# Run overseer E2E tests (requires real API keys in env or home/env)
TEST_OVERSEER=1 ./test.sh overseer.spec.js
```

Notes:

- Test stack swaps `./home` for an ephemeral `test-home` volume.
- Real service entrypoints are used; API keys default to test placeholders unless overridden.
- `test-runner` container runs Playwright and connects to `hub:3000` over Docker networking.

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
