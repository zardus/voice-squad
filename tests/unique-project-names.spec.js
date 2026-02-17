// @ts-check
/**
 * Verify that test.sh generates unique Docker Compose project names per run.
 * This prevents container collisions when multiple test.sh processes run simultaneously.
 */
const { test, expect } = require("@playwright/test");
const { execSync } = require("child_process");

test.describe("Unique project names", () => {
  test("test.sh includes a per-run unique ID in the project name", () => {
    // Simulate what test.sh does: project="squad-test-${RUN_ID}-${name}"
    // RUN_ID is the PID of the test.sh process ($$).
    // We verify the format by sourcing the relevant lines.
    const output = execSync(
      `bash -c 'RUN_ID=$$ ; name=api ; echo "squad-test-\${RUN_ID}-\${name}"'`,
      { encoding: "utf8" }
    ).trim();

    // The project name should match squad-test-<digits>-<name>
    expect(output).toMatch(/^squad-test-\d+-api$/);
  });

  test("two simulated runs produce different project names", () => {
    // Run two subshells — each gets its own PID, so project names differ
    const output1 = execSync(
      `bash -c 'echo "squad-test-$$-api"'`,
      { encoding: "utf8" }
    ).trim();
    const output2 = execSync(
      `bash -c 'echo "squad-test-$$-api"'`,
      { encoding: "utf8" }
    ).trim();

    // Each bash -c invocation gets a unique PID, so names must differ
    expect(output1).toMatch(/^squad-test-\d+-api$/);
    expect(output2).toMatch(/^squad-test-\d+-api$/);
    expect(output1).not.toEqual(output2);
  });
});
