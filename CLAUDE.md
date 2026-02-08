# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Is

Squad is a multi-agent AI orchestration system. It runs inside a privileged Docker container and uses a **captain/workers** pattern: a captain agent (Claude or Codex) manages worker agents that run in tmux panes, communicating via a tmux MCP server.

## Build & Run

```bash
# Build Docker image and launch a squad (default captain: claude)
./run.sh

# Launch with codex as captain
./run.sh codex
```

Requires `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` environment variables on the host. SSH agent is forwarded automatically if `SSH_AUTH_SOCK` is set.

The Docker image is built from `src/Dockerfile` (Ubuntu 22.04 + Docker-in-Docker + Node.js 20 + Claude Code CLI + Codex CLI).

## Project Structure

All build/runtime files live in `src/`:

- `Dockerfile` — Container image definition
- `entrypoint.sh` — Starts dockerd, fixes permissions, calls launch-squad.sh
- `launch-squad.sh` — Configures captain type, creates tmux worker session, starts captain CLI.
- `captain-instructions.md` — Injected as CLAUDE.md/AGENTS.md for the captain agent at runtime
- `mcp-config.json` — Gives the captain access to tmux via the `tmux-mcp` npm package

`run.sh` at the root is the host-side entry point.

`home/` is the shared persistent volume mounted into the container at `/home/ubuntu`. It is gitignored.

## Key Architecture Details

- **Inside the container**, files are installed to `/opt/squad/`. `launch-squad.sh` copies instruction files to `/home/ubuntu/` with the correct filename (CLAUDE.md for claude captains, AGENTS.md for codex captains).
- **Environment variables control behavior**: `SQUAD_CAPTAIN` (claude|codex).
- The container runs `--privileged` for Docker-in-Docker support. The Docker container itself is the sandbox boundary.
- There is no formal test suite. Manual testing is done by launching a squad and verifying agent behavior.
