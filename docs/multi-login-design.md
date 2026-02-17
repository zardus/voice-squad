# Multi-login design for Claude/Codex workers

## Goal
Support concurrent workers for different projects using different Claude/Codex credentials, without cross-project credential leakage.

## Current state summary
- Worker processes run in the workspace tmux server and inherit container/user environment (`/home/ubuntu/env`) via entrypoints.
- Worker launch commands are procedural guidance in captain skill docs, not enforced by a dedicated launcher script.
- Result: all workers share the same credential sources by default.

Relevant code paths:
- `src/workspace/entrypoint.sh`
- `src/captain/entrypoint.sh`
- `src/captain/restart-captain.sh`
- `src/captain/skills/worker-starting/SKILL.md`
- `docker-compose.yml`

## Research findings

### Claude Code authentication
Observed locally (Claude Code `2.1.38`):
- `claude --help` exposes no obvious `--config-dir` flag.
- API-key auth is supported via `ANTHROPIC_API_KEY` (documented by Anthropic).
- OAuth/session data is persisted in home-scoped files, notably:
  - `~/.claude/.credentials.json` (contains token fields under `claudeAiOauth`)
  - `~/.claude.json` (contains account/profile metadata such as `oauthAccount`)
- In this environment, these files represent one active account context, not a built-in multi-account list with per-project selection.

Inference:
- Claude multi-login must be done by selecting different credential files per worker context (or per-worker API key), not by a native “profile” CLI flag.

### Codex CLI authentication
Observed locally (Codex CLI `0.98.0`):
- `codex login --help` supports `--with-api-key` (stdin) in addition to ChatGPT login.
- Auth state is stored in `~/.codex/auth.json` with fields including `auth_mode`, `tokens`, and optional `OPENAI_API_KEY`.
- Config is loaded from `~/.codex/config.toml` by default (explicit in `codex --help`).
- Binary strings and official docs indicate `CODEX_HOME` support (config/auth root override), with fallback to XDG/home conventions.

### API-key auth viability
Both CLIs support key-based auth:
- Claude: `ANTHROPIC_API_KEY`
- Codex: `OPENAI_API_KEY` (or `codex login --with-api-key`)

Strengths:
- Easiest deterministic per-worker isolation by environment.
- No interactive login orchestration needed.

Limitations:
- Does not support distinct OAuth identities unless we also isolate config/auth directories.
- Secret management burden increases (storing many keys securely).

## Voice-squad architecture implications

### Worker environment inheritance
- `workspace` and `captain` containers export API key env vars globally.
- Captain and worker commands run inside tmux panes where command environment is inherited from shell startup and current exported vars.
- Without explicit per-worker overrides, all workers share the same auth context.

### Isolation constraints
- tmux-based worker model expects many concurrent workers in one container and one UNIX user.
- Any global file swap (e.g., replacing `~/.claude`) is race-prone with concurrent workers.
- Isolation must be process-scoped (command-prefix env, dedicated directories) rather than global mutable state.

## Approach evaluation

### 1) Per-worker env vars only (API-key mode)
Mechanism:
- Prefix worker launch command with project-specific key vars.

Pros:
- Lowest complexity.
- Race-safe and fully concurrent.
- No filesystem tricks.

Cons:
- OAuth account separation not supported.
- Requires API key provisioning per project/tool.

Complexity: Low

### 2) Config directory override per worker
Mechanism:
- Codex: set `CODEX_HOME` (and optionally `XDG_CONFIG_HOME`) per worker.
- Claude: no stable official config-dir flag found; practical option is home-based isolation for Claude files.

Pros:
- Supports OAuth account separation.
- Concurrent and race-safe if per-worker directories are immutable to other workers.

Cons:
- Claude path override is indirect (via home-path behavior), not a first-class CLI switch.
- Requires profile bootstrap/login UX.

Complexity: Medium

### 3) Mount namespace / bind overlay per worker
Mechanism:
- `unshare --mount` + bind per-worker credential dirs onto `~/.claude`/`~/.codex`.

Pros:
- Keeps nominal paths unchanged.
- Can support OAuth.

Cons:
- Operationally complex, fragile, hard to debug.
- Higher blast radius and maintenance cost.

Complexity: High

### 4) Symlink swapping global dotfiles
Mechanism:
- Switch `~/.claude` / `~/.codex/auth.json` symlinks before launching each worker.

Pros:
- Simple to prototype.

Cons:
- Not concurrency-safe.
- Races can cross-contaminate active workers.

Complexity: Low to implement, high risk

### 5) One container per worker
Mechanism:
- Move worker execution out of shared tmux into isolated containers.

Pros:
- Strongest isolation.

Cons:
- Major re-architecture; conflicts with current workflow and monitoring model.

Complexity: Very high

### 6) Per-worker HOME override
Mechanism:
- Launch worker with `HOME=<profile-home>` (+ Codex `CODEX_HOME=<profile-home>/.codex`).

Pros:
- Unified solution for both OAuth and key auth.
- Concurrency-safe when each worker uses distinct profile home.

Cons:
- Side effects for tools that rely on `HOME` (git config, ssh keys, caches).
- Needs careful profile bootstrap (symlinks/copies for required dotfiles).

Complexity: Medium

## Recommended approach
Use a **hybrid staged model**:

1. **Phase 1 (minimum-risk): per-worker API-key env overrides**
- Implement project-scoped env files and launch wrappers.
- Immediate support for different project credentials with no CLI login coupling.

2. **Phase 2 (full multi-login): per-project profile homes + tool-specific config roots**
- For projects needing OAuth identities, launch workers with isolated home/profile directories.
- Set `CODEX_HOME` explicitly for codex; for Claude rely on home-scoped `~/.claude` and `~/.claude.json` in that profile.

Why this recommendation:
- Preserves current tmux architecture.
- Avoids race-prone global symlink flipping.
- Supports concurrent mixed-credential workers.
- Lets rollout start with low-risk API-key path before adding OAuth profile management.

## Proposed design details

### New credential profile structure
Under `/home/ubuntu/captain/auth/`:
- `projects/<project>/worker.env` (project-level default key env)
- `profiles/<profile>/home/` (isolated HOME for OAuth sessions)
- `profiles/<profile>/meta.json` (tool/account metadata)

Example:
- `/home/ubuntu/captain/auth/projects/voice-squad/worker.env`
- `/home/ubuntu/captain/auth/profiles/claude-work/home/.claude/...`
- `/home/ubuntu/captain/auth/profiles/codex-personal/home/.codex/...`

### Worker launch contract
Worker start command should be generated via a script, not handwritten each time:
- Inputs: `project`, `tool`, `task_file`, `auth_mode`, `profile`
- Modes:
  - `auth_mode=env`: source project env and launch tool
  - `auth_mode=profile`: set `HOME` (and `CODEX_HOME` for codex), optionally also source env

### Safety constraints
- Never mutate global `~/.claude` or `~/.codex` during worker startup.
- Never repoint shared symlinks used by running workers.
- Treat profile directories as immutable to other workers while active.

## Implementation plan (specific repo changes)

### 1) Add worker launcher script
- New file: `src/captain/launch-worker.sh`
- Responsibilities:
  - Resolve project + task file.
  - Load optional `/home/ubuntu/captain/auth/projects/<project>/worker.env`.
  - Apply profile mode env (`HOME`, `CODEX_HOME`, optional `XDG_CONFIG_HOME`).
  - Execute tool command (`claude` or `codex`) safely.

### 2) Update worker-starting skill to require launcher
- Update: `src/captain/skills/worker-starting/SKILL.md`
- Replace direct `claude ...` / `codex ...` examples with launcher usage.
- Add explicit requirement to select auth mode per project.

### 3) Add auth-management skill
- New file: `src/captain/skills/auth-profiles/SKILL.md`
- Define procedures for:
  - Creating project env credential files.
  - Creating OAuth profile homes.
  - Running login inside a specific profile context.

### 4) Update account switch script for profile-aware operation
- Update: `src/captain/switch-account.sh`
- Move from global symlink strategy to explicit target profile path.
- Keep backward-compatible fallback for legacy installations.

### 5) Optional: docs and status visibility
- Update or add docs in `docs/` to define operator workflow.
- Optional voice API additions to expose worker auth mode metadata (not secrets).

## Migration path

### Stage A: Compatible introduction
1. Add launcher + skill updates.
2. Default launcher behavior: no profile selected, current global behavior unchanged.

### Stage B: Per-project API keys
1. Create `worker.env` for selected projects.
2. Start workers with `auth_mode=env`.
3. Validate concurrent workers with different key sets.

### Stage C: OAuth profiles
1. Create profile homes.
2. Perform tool login in that profile context once.
3. Launch project workers with `auth_mode=profile` referencing profile name.
4. Keep legacy global creds as fallback for unmigrated projects.

### Stage D: Harden and deprecate legacy switching
1. De-emphasize global symlink-based switching in docs.
2. Make profile mode default for new projects.

## Risks and mitigations
- Risk: HOME override breaks git/ssh behavior.
  - Mitigation: profile bootstrap includes explicit symlinks or controlled forwarding of `.gitconfig`/`.ssh` where needed.
- Risk: credential leakage in logs or task files.
  - Mitigation: never store secrets in task files; use env files with strict permissions (`0600`).
- Risk: captain prompts bypass launcher and launch raw CLI.
  - Mitigation: skill instructions must mandate launcher; add periodic lint/check in captain instructions.

## Verification checklist for implementation
- Two concurrent projects, each with different credentials, can run workers simultaneously.
- Worker A cannot use Worker B’s OAuth/account state.
- API-key mode and OAuth profile mode both work for Claude and Codex.
- Existing single-login flow still works when no project auth config exists.

## External references
- Anthropic Claude Code CLI docs: https://docs.anthropic.com/en/docs/claude-code/cli-reference
- Anthropic Claude Code env vars: https://docs.anthropic.com/en/docs/claude-code/settings
- OpenAI Codex auth docs: https://developers.openai.com/codex/auth
- OpenAI Codex config docs: https://developers.openai.com/codex/config
