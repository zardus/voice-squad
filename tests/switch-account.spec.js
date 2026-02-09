// @ts-check
/**
 * Tests for switch-account.sh — account file creation and symlink management.
 *
 * These tests run the script in a temp HOME with stubbed binaries so they
 * don't need a live Docker container, tmux, or real CLI tools.
 */
const { test, expect } = require("@playwright/test");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const SCRIPT = path.resolve(__dirname, "../src/switch-account.sh");

test.describe("switch-account.sh", () => {
  /** @type {string} */
  let tmpHome;
  /** @type {string} */
  let stubBin;

  test.beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "switch-acct-test-"));
    fs.mkdirSync(path.join(tmpHome, "captain"), { recursive: true });

    // Create stub bin directory with no-op commands for claude/codex/tmux
    stubBin = path.join(tmpHome, ".stub-bin");
    fs.mkdirSync(stubBin);
    // claude/codex login stubs — succeed immediately
    fs.writeFileSync(path.join(stubBin, "claude"), "#!/bin/bash\nexit 0\n");
    fs.writeFileSync(path.join(stubBin, "codex"), "#!/bin/bash\nexit 0\n");
    // tmux stub — has-session fails (no live tmux), which makes the script
    // exit after login but AFTER creating the symlinks (the part we test).
    fs.writeFileSync(
      path.join(stubBin, "tmux"),
      '#!/bin/bash\nif [ "$1" = "has-session" ]; then exit 1; fi\nexit 0\n',
    );
    fs.chmodSync(path.join(stubBin, "claude"), 0o755);
    fs.chmodSync(path.join(stubBin, "codex"), 0o755);
    fs.chmodSync(path.join(stubBin, "tmux"), 0o755);
  });

  test.afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  /**
   * Run switch-account.sh with the temp HOME and stubbed PATH.
   * Returns { stdout, exitCode }. Does NOT throw on non-zero exit.
   */
  function run(args, env = {}) {
    try {
      const stdout = execSync(`bash "${SCRIPT}" ${args}`, {
        encoding: "utf8",
        timeout: 10000,
        env: {
          HOME: tmpHome,
          PATH: `${stubBin}:/usr/bin:/bin`,
          SQUAD_CAPTAIN: env.SQUAD_CAPTAIN || "claude",
          ...env,
        },
      });
      return { stdout, exitCode: 0 };
    } catch (err) {
      return { stdout: (err.stdout || "") + (err.stderr || ""), exitCode: err.status };
    }
  }

  // -----------------------------------------------------------------------
  // Argument validation
  // -----------------------------------------------------------------------

  test("exits with usage when no arguments given", () => {
    const { stdout, exitCode } = run("");
    expect(exitCode).toBe(1);
    expect(stdout).toContain("Usage:");
  });

  test("exits with usage when only tool given", () => {
    const { stdout, exitCode } = run("claude");
    expect(exitCode).toBe(1);
    expect(stdout).toContain("Usage:");
  });

  test("rejects invalid tool name", () => {
    const { stdout, exitCode } = run("gpt4 foo@bar.com");
    expect(exitCode).toBe(1);
    expect(stdout).toContain("must be 'claude' or 'codex'");
  });

  // -----------------------------------------------------------------------
  // Claude account switching
  // -----------------------------------------------------------------------

  test("creates account file and symlink for claude", () => {
    // Script will exit 1 at tmux check, but files are created before that
    run("claude test@example.com");

    const accountFile = path.join(tmpHome, "captain/accounts/claude-test@example.com");
    expect(fs.existsSync(accountFile)).toBe(true);
    expect(JSON.parse(fs.readFileSync(accountFile, "utf8"))).toEqual({});

    const symlinkPath = path.join(tmpHome, ".claude.json");
    expect(fs.lstatSync(symlinkPath).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(symlinkPath)).toBe(accountFile);
  });

  test("reuses existing claude account file", () => {
    const accountFile = path.join(tmpHome, "captain/accounts/claude-existing@test.com");
    fs.mkdirSync(path.dirname(accountFile), { recursive: true });
    const existingData = JSON.stringify({ oauthAccount: { email: "existing@test.com" } });
    fs.writeFileSync(accountFile, existingData);

    run("claude existing@test.com");

    // Account file should be unchanged (not overwritten with {})
    expect(fs.readFileSync(accountFile, "utf8")).toBe(existingData);

    // Symlink should point to it
    const symlinkPath = path.join(tmpHome, ".claude.json");
    expect(fs.lstatSync(symlinkPath).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(symlinkPath)).toBe(accountFile);
  });

  test("replaces existing claude symlink when switching accounts", () => {
    const acctDir = path.join(tmpHome, "captain/accounts");
    fs.mkdirSync(acctDir, { recursive: true });

    // Create two account files
    const acct1 = path.join(acctDir, "claude-first@test.com");
    const acct2 = path.join(acctDir, "claude-second@test.com");
    fs.writeFileSync(acct1, '{"account":"first"}');
    fs.writeFileSync(acct2, '{"account":"second"}');

    // Switch to first
    run("claude first@test.com");
    const symlinkPath = path.join(tmpHome, ".claude.json");
    expect(fs.readlinkSync(symlinkPath)).toBe(acct1);

    // Switch to second
    run("claude second@test.com");
    expect(fs.readlinkSync(symlinkPath)).toBe(acct2);
  });

  // -----------------------------------------------------------------------
  // Codex account switching
  // -----------------------------------------------------------------------

  test("creates account file and symlink for codex", () => {
    run("codex alt@example.com");

    const accountFile = path.join(tmpHome, "captain/accounts/codex-alt@example.com");
    expect(fs.existsSync(accountFile)).toBe(true);
    expect(JSON.parse(fs.readFileSync(accountFile, "utf8"))).toEqual({});

    const symlinkPath = path.join(tmpHome, ".codex/auth.json");
    expect(fs.lstatSync(symlinkPath).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(symlinkPath)).toBe(accountFile);
  });

  test("creates .codex directory if missing for codex", () => {
    const codexDir = path.join(tmpHome, ".codex");
    expect(fs.existsSync(codexDir)).toBe(false);

    run("codex new@example.com");

    expect(fs.existsSync(codexDir)).toBe(true);
    expect(fs.lstatSync(path.join(codexDir, "auth.json")).isSymbolicLink()).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Captain restart messaging
  // -----------------------------------------------------------------------

  test("reports error when tmux session not found", () => {
    const { stdout, exitCode } = run("claude test@example.com");
    // Script should fail at tmux has-session check
    expect(exitCode).toBe(1);
    expect(stdout).toContain("tmux session 'captain' not found");
  });

  test("proceeds to captain restart when tmux session exists", () => {
    // Override tmux stub to succeed for has-session and list-panes
    fs.writeFileSync(
      path.join(stubBin, "tmux"),
      [
        "#!/bin/bash",
        'case "$1" in',
        "  has-session) exit 0 ;;",
        '  list-panes) echo "12345" ;;',
        "  *) exit 0 ;;",
        "esac",
      ].join("\n"),
    );

    // Also stub ps (captain process lookup)
    fs.writeFileSync(path.join(stubBin, "ps"), "#!/bin/bash\nexit 0\n");
    fs.chmodSync(path.join(stubBin, "ps"), 0o755);

    // kill/sleep stubs
    fs.writeFileSync(path.join(stubBin, "kill"), "#!/bin/bash\nexit 1\n");
    fs.chmodSync(path.join(stubBin, "kill"), 0o755);

    const { stdout } = run("claude test@example.com");
    expect(stdout).toContain("Launching new captain");
    expect(stdout).toContain("Account switch complete");
  });
});
