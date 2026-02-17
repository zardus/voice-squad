// @ts-check
/**
 * E2E test: verify completed tasks flow through the real server and UI.
 *
 * 1. Write a .task file to pending/
 * 2. Verify it appears in the Pending Tasks section via the UI
 * 3. "Complete" it by moving .task to archived/ and writing a .summary
 * 4. Verify it disappears from Pending and appears in Completed Tasks
 * 5. Verify the summary text is displayed correctly
 */
const { test, expect } = require("@playwright/test");
const { TOKEN, pageUrl } = require("./helpers/config");
const fs = require("fs/promises");
const path = require("path");

const CAPTAIN_DIR = process.env.SQUAD_CAPTAIN_DIR || "/home/ubuntu/captain";
const TASK_DEFS_DIR = process.env.SQUAD_TASK_DEFS_DIR || path.join(CAPTAIN_DIR, "tasks");
const TASK_DEFS_PENDING_DIR = path.join(TASK_DEFS_DIR, "pending");
const TASK_DEFS_ARCHIVED_DIR = path.join(TASK_DEFS_DIR, "archived");
const TEST_TASK_NAME = `e2e-completed-test-${Date.now()}`;

test.describe("Completed tasks E2E", () => {
  test.beforeAll(async () => {
    if (!TOKEN) throw new Error("Cannot discover VOICE_TOKEN");
    await fs.mkdir(TASK_DEFS_PENDING_DIR, { recursive: true });
    await fs.mkdir(TASK_DEFS_ARCHIVED_DIR, { recursive: true });
  });

  test.afterAll(async () => {
    // Clean up test files
    const exts = [".task", ".summary", ".log", ".title", ".results"];
    for (const ext of exts) {
      await fs.unlink(path.join(TASK_DEFS_PENDING_DIR, `${TEST_TASK_NAME}${ext}`)).catch(() => {});
      await fs.unlink(path.join(TASK_DEFS_ARCHIVED_DIR, `${TEST_TASK_NAME}${ext}`)).catch(() => {});
    }
  });

  test("pending task moves to completed with summary visible in UI", async ({ page }) => {
    // Step 1: Write a .task file to pending/
    const taskContent = "Investigate memory leak in worker pool and fix it.";
    await fs.writeFile(
      path.join(TASK_DEFS_PENDING_DIR, `${TEST_TASK_NAME}.task`),
      taskContent + "\n",
      "utf8"
    );

    // Step 2: Navigate to the Tasks tab and verify it appears in Pending
    await page.goto(pageUrl());
    await page.click('[data-tab="tasks"]');

    // Wait for pending tasks to load and find our task
    await expect(page.locator("#pending-tasks-content")).not.toContainText("Loading");
    await expect(page.locator("#pending-tasks-content")).toContainText(TEST_TASK_NAME);

    // Verify the task content is accessible (expand the details)
    const pendingItem = page.locator(`.pending-task-item:has-text("${TEST_TASK_NAME}")`);
    await expect(pendingItem).toBeVisible();
    await pendingItem.locator("summary").click();
    await expect(pendingItem).toContainText("memory leak");

    // Step 3: "Complete" the task — move .task to archived/ and write .summary
    await fs.rename(
      path.join(TASK_DEFS_PENDING_DIR, `${TEST_TASK_NAME}.task`),
      path.join(TASK_DEFS_ARCHIVED_DIR, `${TEST_TASK_NAME}.task`)
    );
    const summaryText = "Fixed the memory leak by closing idle connections after 30s timeout.";
    await fs.writeFile(
      path.join(TASK_DEFS_ARCHIVED_DIR, `${TEST_TASK_NAME}.summary`),
      summaryText + "\n",
      "utf8"
    );

    // Step 4: Refresh and verify it moved from Pending to Completed
    await page.click("#refresh-tasks-btn");

    // Wait for refresh to complete
    await expect(page.locator("#refresh-tasks-btn")).toBeEnabled();

    // Verify it's gone from Pending
    await expect(page.locator("#pending-tasks-content")).not.toContainText(TEST_TASK_NAME);

    // Verify it appears in Completed
    await expect(page.locator("#completed-tasks-content")).toContainText(TEST_TASK_NAME);

    // Step 5: Verify the summary text is displayed
    const completedItem = page.locator(`.completed-task-item:has-text("${TEST_TASK_NAME}")`);
    await expect(completedItem).toBeVisible();
    await expect(completedItem).toContainText(summaryText);
  });
});
