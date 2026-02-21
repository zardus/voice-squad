// @ts-check
/**
 * Notification dedup and live activity update tests.
 *
 * Validates that:
 * - Repeated /api/speak calls with the same text are deduplicated.
 * - Different text is not deduplicated.
 * - Live activity registrations are idempotent (same activityId = replace).
 * - Live activity fanout does not duplicate pushes per unique activityId.
 */
const { test, expect } = require("@playwright/test");
const { BASE_URL, TOKEN } = require("./helpers/config");

const TEST_PREFIX = `dedup-test-${Date.now()}`;

test.describe("Notification dedup", () => {
  test.beforeAll(() => {
    if (!TOKEN) throw new Error("Cannot discover VOICE_TOKEN");
  });

  test("POST /api/speak deduplicates identical text within time window", async () => {
    const uniqueText = `dedup-same-${Date.now()}`;

    // First call — may succeed or fail at TTS, but dedup state is recorded.
    const resp1 = await fetch(`${BASE_URL}/api/speak`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: TOKEN, text: uniqueText }),
    });
    // Accept 200 (ok) or 500 (TTS synthesis error in test env without real key).
    expect([200, 500]).toContain(resp1.status);

    // Second call with identical text — should be caught by dedup.
    const resp2 = await fetch(`${BASE_URL}/api/speak`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: TOKEN, text: uniqueText }),
    });
    expect(resp2.status).toBe(200);
    const json2 = await resp2.json();
    expect(json2.ok).toBe(true);
    expect(json2.deduplicated).toBe(true);
    expect(json2.clients).toBe(0);
  });

  test("POST /api/speak allows different text immediately after", async () => {
    const textA = `dedup-a-${Date.now()}`;
    const textB = `dedup-b-${Date.now()}`;

    // First call with text A.
    await fetch(`${BASE_URL}/api/speak`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: TOKEN, text: textA }),
    });

    // Second call with different text — should NOT be deduplicated.
    const resp = await fetch(`${BASE_URL}/api/speak`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: TOKEN, text: textB }),
    });
    const json = await resp.json();
    if (resp.status === 200 && json.ok) {
      // If TTS succeeded, deduplicated should be absent or false.
      expect(json.deduplicated).toBeFalsy();
    }
    // If status is 500 (TTS error), that's acceptable — the important thing
    // is that it was NOT short-circuited by dedup.
  });

  test("POST /api/speak playbackOnly=true bypasses dedup", async () => {
    const text = `dedup-playback-${Date.now()}`;

    // First call — sets dedup state.
    await fetch(`${BASE_URL}/api/speak`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: TOKEN, text }),
    });

    // playbackOnly call with same text — should NOT be deduplicated.
    const resp = await fetch(`${BASE_URL}/api/speak`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: TOKEN, text, playbackOnly: true }),
    });
    // playbackOnly returns audio bytes (200) or TTS error (500), never dedup JSON.
    if (resp.status === 200) {
      const contentType = resp.headers.get("content-type") || "";
      expect(contentType).toContain("audio");
    }
  });
});

test.describe("Live activity registration dedup", () => {
  test.beforeAll(() => {
    if (!TOKEN) throw new Error("Cannot discover VOICE_TOKEN");
  });

  test("re-registering same activityId is idempotent", async () => {
    const activityId = `${TEST_PREFIX}-idempotent`;
    const pushToken = "aabbccdd11223344aabbccdd11223344";

    const resp1 = await fetch(`${BASE_URL}/api/live-activity/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: TOKEN, activityId, activityPushToken: pushToken }),
    });
    expect(resp1.status).toBe(200);
    const json1 = await resp1.json();
    expect(json1.ok).toBe(true);

    const resp2 = await fetch(`${BASE_URL}/api/live-activity/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: TOKEN, activityId, activityPushToken: pushToken }),
    });
    expect(resp2.status).toBe(200);
    const json2 = await resp2.json();
    expect(json2.ok).toBe(true);

    // Same activityId re-registered — total count should not increase.
    expect(json2.registered).toBe(json1.registered);
  });

  test("updating push token for same activityId replaces instead of duplicating", async () => {
    const activityId = `${TEST_PREFIX}-tokenupdate`;
    const oldToken = "1111111111111111";
    const newToken = "2222222222222222";

    // Register with old token.
    await fetch(`${BASE_URL}/api/live-activity/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: TOKEN, activityId, activityPushToken: oldToken }),
    });

    // Re-register with new token.
    const resp = await fetch(`${BASE_URL}/api/live-activity/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: TOKEN, activityId, activityPushToken: newToken }),
    });
    expect(resp.status).toBe(200);

    // Verify only one registration exists for this activityId.
    const listResp = await fetch(
      `${BASE_URL}/api/live-activity/registrations?token=${encodeURIComponent(TOKEN)}`
    );
    const listJson = await listResp.json();
    const matches = listJson.registrations.filter((r) => r.activityId === activityId);
    expect(matches).toHaveLength(1);
    // The push token should be the new one.
    expect(matches[0].pushTokenPrefix).toBe(newToken.slice(0, 12));
  });

  test("different activityIds are stored separately", async () => {
    const activityId1 = `${TEST_PREFIX}-multi-1`;
    const activityId2 = `${TEST_PREFIX}-multi-2`;
    const pushToken = "abcdef1234567890";

    await fetch(`${BASE_URL}/api/live-activity/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: TOKEN, activityId: activityId1, activityPushToken: pushToken }),
    });

    const resp = await fetch(`${BASE_URL}/api/live-activity/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: TOKEN, activityId: activityId2, activityPushToken: pushToken }),
    });
    expect(resp.status).toBe(200);

    const listResp = await fetch(
      `${BASE_URL}/api/live-activity/registrations?token=${encodeURIComponent(TOKEN)}`
    );
    const listJson = await listResp.json();
    const ours = listJson.registrations.filter((r) =>
      r.activityId === activityId1 || r.activityId === activityId2
    );
    expect(ours).toHaveLength(2);
  });
});
