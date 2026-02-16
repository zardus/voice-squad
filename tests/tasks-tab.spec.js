// @ts-check
const { test, expect } = require("@playwright/test");
const { TOKEN, pageUrl } = require("./helpers/config");

test.describe("Tasks tab", () => {
  test.beforeAll(() => {
    if (!TOKEN) throw new Error("Cannot discover VOICE_TOKEN");
  });

  test("tasks tab exists and is labeled Tasks", async ({ page }) => {
    await page.goto(pageUrl());
    const tab = page.locator('[data-tab="tasks"]');
    await expect(tab).toBeVisible();
    await expect(tab).toHaveText("Tasks");
  });

  test("clicking Tasks tab switches to tasks view", async ({ page }) => {
    await page.route("**/api/pending-tasks?**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ tasks: [] }),
      });
    });

    await page.route("**/api/completed-tasks?**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ tasks: [] }),
      });
    });

    await page.goto(pageUrl());
    await page.click('[data-tab="tasks"]');

    await expect(page.locator('[data-tab="tasks"]')).toHaveClass(/active/);
    await expect(page.locator("#tasks-view")).toHaveClass(/active/);
    await expect(page.locator("#terminal-view")).not.toHaveClass(/active/);
  });

  test("tasks view has Pending and Completed sections", async ({ page }) => {
    await page.route("**/api/pending-tasks?**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ tasks: [] }),
      });
    });

    await page.route("**/api/completed-tasks?**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ tasks: [] }),
      });
    });

    await page.goto(pageUrl());
    await page.click('[data-tab="tasks"]');

    await expect(page.locator("#pending-tasks-section")).toBeVisible();
    await expect(page.locator("#completed-tasks-section")).toBeVisible();
    await expect(page.locator("#pending-tasks-section .tasks-section-title")).toHaveText("Pending Tasks");
    await expect(page.locator("#completed-tasks-section .tasks-section-title")).toHaveText("Completed Tasks");
  });

  test("pending section shows pending tasks", async ({ page }) => {
    await page.route("**/api/pending-tasks?**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          tasks: [
            {
              task_name: "worker-memory-audit",
              content: "Inspect worker memory use and identify leaks.",
              created_at: "2026-02-15T10:00:00Z",
            },
          ],
        }),
      });
    });

    await page.route("**/api/completed-tasks?**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ tasks: [] }),
      });
    });

    await page.goto(pageUrl());
    await page.click('[data-tab="tasks"]');

    await expect(page.locator(".pending-task-item")).toHaveCount(1);
    await expect(page.locator(".pending-task-heading")).toContainText("worker-memory-audit");
    await expect(page.locator(".pending-task-preview")).toContainText("Inspect worker memory use");

    await page.locator(".pending-task-summary").first().click();
    await expect(page.locator(".pending-task-content")).toContainText("identify leaks");
  });

  test("completed section shows completed tasks", async ({ page }) => {
    await page.route("**/api/pending-tasks?**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ tasks: [] }),
      });
    });

    await page.route("**/api/completed-tasks?**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          tasks: [
            {
              task_name: "bridge-rewrite",
              completed_at: "2026-02-15T09:00:00Z",
              short_summary: "Refactored bridge and added tests.",
              detailed_summary: "## Done\n- Added API route",
              worker_type: "codex",
              session: "alpha",
              window: "bridge-rewrite",
            },
          ],
        }),
      });
    });

    await page.goto(pageUrl());
    await page.click('[data-tab="tasks"]');

    await expect(page.locator(".completed-task-item")).toHaveCount(1);
    await expect(page.locator(".completed-task-short")).toHaveText("Refactored bridge and added tests.");
  });

  test("refresh button re-fetches both endpoints", async ({ page }) => {
    let pendingCalls = 0;
    let completedCalls = 0;

    await page.route("**/api/pending-tasks?**", async (route) => {
      pendingCalls += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ tasks: [] }),
      });
    });

    await page.route("**/api/completed-tasks?**", async (route) => {
      completedCalls += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ tasks: [] }),
      });
    });

    await page.goto(pageUrl());
    await page.click('[data-tab="tasks"]');
    await expect.poll(() => pendingCalls).toBeGreaterThanOrEqual(1);
    await expect.poll(() => completedCalls).toBeGreaterThanOrEqual(1);

    await page.click("#refresh-tasks-btn");
    await expect.poll(() => pendingCalls).toBeGreaterThanOrEqual(2);
    await expect.poll(() => completedCalls).toBeGreaterThanOrEqual(2);
  });

  test("empty states show appropriate messages", async ({ page }) => {
    await page.route("**/api/pending-tasks?**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ tasks: [] }),
      });
    });

    await page.route("**/api/completed-tasks?**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ tasks: [] }),
      });
    });

    await page.goto(pageUrl());
    await page.click('[data-tab="tasks"]');

    await expect(page.locator("#pending-tasks-content")).toContainText("No pending tasks.");
    await expect(page.locator("#completed-tasks-content")).toContainText("No completed tasks yet.");
  });
});
