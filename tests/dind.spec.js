// @ts-check
/**
 * Docker-in-Docker smoke test — verify that `docker` works inside
 * the workspace container. Workers rely on DinD for builds and
 * container tasks; this catches regressions early.
 */
const { test, expect } = require("@playwright/test");
const { execSync } = require("child_process");

test.describe("Docker-in-Docker", () => {
  test("dockerd is running", () => {
    // Retry a few times — dockerd may still be starting
    let info;
    for (let i = 0; i < 15; i++) {
      try {
        info = execSync("sudo docker info 2>&1", {
          encoding: "utf8",
          timeout: 5000,
        });
        if (info.includes("Server Version")) break;
      } catch {
        // not ready yet
      }
      execSync("sleep 2");
    }
    expect(info).toContain("Server Version");
  });

  test("docker run hello-world succeeds", () => {
    const out = execSync("sudo docker run --rm hello-world 2>&1", {
      encoding: "utf8",
      timeout: 60000,
    });
    expect(out).toContain("Hello from Docker!");
  });

  test("docker build works", () => {
    // Build a trivial image from stdin
    const out = execSync(
      "printf 'FROM alpine\\nRUN echo dind-ok' | sudo docker build -q -",
      { encoding: "utf8", timeout: 60000 }
    );
    // docker build -q prints the image ID (sha256:...)
    expect(out.trim()).toMatch(/^sha256:[0-9a-f]+$/);
  });
});
