// @ts-check
/**
 * Project management API tests — GET/POST/DELETE /api/projects.
 */
const { test, expect } = require("@playwright/test");
const { BASE_URL, TOKEN, pageUrl } = require("./helpers/config");

test.describe("Project management API", () => {
  test.beforeAll(() => {
    if (!TOKEN) throw new Error("Cannot discover VOICE_TOKEN");
  });

  // --- GET /api/projects ---

  test("GET /api/projects with valid token returns projects array", async () => {
    const resp = await fetch(
      `${BASE_URL}/api/projects?token=${encodeURIComponent(TOKEN)}`
    );
    expect(resp.status).toBe(200);
    const json = await resp.json();
    expect(json).toHaveProperty("projects");
    expect(Array.isArray(json.projects)).toBe(true);
  });

  test("GET /api/projects without token returns 401", async () => {
    const resp = await fetch(`${BASE_URL}/api/projects`);
    expect(resp.status).toBe(401);
    const json = await resp.json();
    expect(json.error).toBe("Unauthorized");
  });

  test("GET /api/projects with bad token returns 401", async () => {
    const resp = await fetch(
      `${BASE_URL}/api/projects?token=wrong-token`
    );
    expect(resp.status).toBe(401);
  });

  // --- POST /api/projects ---

  test("POST /api/projects without token returns 401", async () => {
    const resp = await fetch(`${BASE_URL}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "test-project" }),
    });
    expect(resp.status).toBe(401);
  });

  test("POST /api/projects with bad token returns 401", async () => {
    const resp = await fetch(`${BASE_URL}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "bad-token", name: "test-project" }),
    });
    expect(resp.status).toBe(401);
  });

  test("POST /api/projects with empty name returns 400", async () => {
    const resp = await fetch(`${BASE_URL}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: TOKEN, name: "" }),
    });
    expect(resp.status).toBe(400);
    const json = await resp.json();
    expect(json.error).toBeTruthy();
  });

  test("POST /api/projects with invalid name returns 400", async () => {
    const resp = await fetch(`${BASE_URL}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: TOKEN, name: "../escape" }),
    });
    expect(resp.status).toBe(400);
    const json = await resp.json();
    expect(json.error).toContain("Invalid project name");
  });

  test("POST /api/projects with missing name returns 400", async () => {
    const resp = await fetch(`${BASE_URL}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: TOKEN }),
    });
    expect(resp.status).toBe(400);
    const json = await resp.json();
    expect(json.error).toBeTruthy();
  });

  test("POST /api/projects with too-long name returns 400", async () => {
    const resp = await fetch(`${BASE_URL}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: TOKEN, name: "a".repeat(65) }),
    });
    expect(resp.status).toBe(400);
    const json = await resp.json();
    expect(json.error).toContain("too long");
  });

  // --- DELETE /api/projects/:name ---

  test("DELETE /api/projects/:name without token returns 401", async () => {
    const resp = await fetch(
      `${BASE_URL}/api/projects/test-project`,
      { method: "DELETE" }
    );
    expect(resp.status).toBe(401);
  });

  test("DELETE /api/projects/:name with bad token returns 401", async () => {
    const resp = await fetch(
      `${BASE_URL}/api/projects/test-project?token=bad-token`,
      { method: "DELETE" }
    );
    expect(resp.status).toBe(401);
  });

  test("DELETE /api/projects/:name with invalid name returns 400", async () => {
    const resp = await fetch(
      `${BASE_URL}/api/projects/..%2Fescape?token=${encodeURIComponent(TOKEN)}`,
      { method: "DELETE" }
    );
    expect(resp.status).toBe(400);
    const json = await resp.json();
    expect(json.error).toContain("Invalid project name");
  });

  test("DELETE /api/projects/:name with valid token returns result", async () => {
    // Deleting a non-existent project should still succeed (idempotent)
    const resp = await fetch(
      `${BASE_URL}/api/projects/nonexistent-test-project?token=${encodeURIComponent(TOKEN)}`,
      { method: "DELETE" }
    );
    expect(resp.status).toBe(200);
    const json = await resp.json();
    expect(json.name).toBe("nonexistent-test-project");
    expect(json.status).toBe("stopped");
  });
});

test.describe("Projects tab UI", () => {
  test.beforeAll(() => {
    if (!TOKEN) throw new Error("Cannot discover VOICE_TOKEN");
  });

  test("Projects tab exists and loads with header elements", async ({ page }) => {
    await page.goto(pageUrl());
    await page.click('[data-tab="projects"]');

    await expect(page.locator("#projects-title")).toHaveText("projects");
    await expect(page.locator("#projects-time")).toBeVisible();
    await expect(page.locator("#projects-panes")).toBeAttached();
  });

  test("Projects tab has add project button", async ({ page }) => {
    await page.goto(pageUrl());
    await page.click('[data-tab="projects"]');

    await expect(page.locator("#add-project-btn")).toBeVisible();
  });

  test("Projects tab body is scrollable", async ({ page }) => {
    await page.goto(pageUrl());
    await page.click('[data-tab="projects"]');

    const overflow = await page.locator("#projects-body").evaluate(
      (el) => getComputedStyle(el).overflowY
    );
    expect(overflow).toBe("auto");
  });

  test("Add project button opens create project modal", async ({ page }) => {
    await page.goto(pageUrl());
    await page.click('[data-tab="projects"]');

    await page.click("#add-project-btn");
    await expect(page.locator("#create-project-modal")).toBeVisible();
    await expect(page.locator("#create-project-name")).toBeVisible();
    await expect(page.locator("#create-project-submit")).toBeVisible();
  });

  test("Create project modal closes on cancel", async ({ page }) => {
    await page.goto(pageUrl());
    await page.click('[data-tab="projects"]');

    await page.click("#add-project-btn");
    await expect(page.locator("#create-project-modal")).toBeVisible();
    await page.click("#create-project-cancel");
    await expect(page.locator("#create-project-modal")).toBeHidden();
  });

  test("Create project modal closes on backdrop click", async ({ page }) => {
    await page.goto(pageUrl());
    await page.click('[data-tab="projects"]');

    await page.click("#add-project-btn");
    await expect(page.locator("#create-project-modal")).toBeVisible();
    // Click the top-left corner of the backdrop (outside the dialog)
    await page.locator("#create-project-backdrop").click({ position: { x: 5, y: 5 } });
    await expect(page.locator("#create-project-modal")).toBeHidden();
  });

  test("Create project submit sends POST /api/projects", async ({ page }) => {
    await page.route("**/api/projects", async (route, request) => {
      if (request.method() === "POST") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ name: "test-proj", status: "running" }),
        });
      } else {
        await route.continue();
      }
    });

    await page.goto(pageUrl());
    await page.click('[data-tab="projects"]');
    await page.click("#add-project-btn");

    await page.fill("#create-project-name", "test-proj");

    const [request] = await Promise.all([
      page.waitForRequest((req) =>
        req.url().includes("/api/projects") && req.method() === "POST"
      ),
      page.click("#create-project-submit"),
    ]);

    const body = request.postDataJSON();
    expect(body.token).toBe(TOKEN);
    expect(body.name).toBe("test-proj");
  });

  test("tab bar shows Projects as first tab", async ({ page }) => {
    await page.goto(pageUrl());
    const tabs = page.locator("#tab-bar .tab");
    await expect(tabs).toHaveCount(4);
    await expect(tabs.nth(0)).toHaveText("Projects");
  });
});
