// @ts-check
/**
 * Silent audio keep-alive mechanism tests.
 *
 * Verifies the OscillatorNode-based keep-alive that replaces the always-on mic.
 */
const { test, expect } = require("@playwright/test");
const { pageUrl } = require("./helpers/config");

/** Common init script stubs. */
function addStubs(page) {
  return page.addInitScript(() => {
    localStorage.setItem("autolisten", "true");

    // --- AudioContext observation ---
    window.__oscillatorsCreated = 0;
    window.__gainsCreated = 0;
    window.__oscConnected = false;
    window.__oscStarted = false;
    window.__oscStopped = false;
    window.__oscDisconnected = false;
    window.__lastGainValue = null;
    window.__audioContextClosed = false;

    const OrigAudioContext = window.AudioContext || window.webkitAudioContext;
    if (OrigAudioContext) {
      class ObservedAudioContext extends OrigAudioContext {
        constructor(...args) {
          super(...args);
        }
        createOscillator() {
          const osc = super.createOscillator();
          window.__oscillatorsCreated += 1;
          const origConnect = osc.connect.bind(osc);
          osc.connect = (...a) => {
            window.__oscConnected = true;
            return origConnect(...a);
          };
          const origStart = osc.start.bind(osc);
          osc.start = (...a) => {
            window.__oscStarted = true;
            return origStart(...a);
          };
          const origStop = osc.stop.bind(osc);
          osc.stop = (...a) => {
            window.__oscStopped = true;
            try { return origStop(...a); } catch {}
          };
          const origDisconnect = osc.disconnect.bind(osc);
          osc.disconnect = (...a) => {
            window.__oscDisconnected = true;
            try { return origDisconnect(...a); } catch {}
          };
          return osc;
        }
        createGain() {
          const gain = super.createGain();
          window.__gainsCreated += 1;
          try {
            const desc = Object.getOwnPropertyDescriptor(AudioParam.prototype, "value");
            if (desc && desc.set) {
              Object.defineProperty(gain.gain, "value", {
                get: () => desc.get.call(gain.gain),
                set: (v) => {
                  window.__lastGainValue = v;
                  desc.set.call(gain.gain, v);
                },
                configurable: true,
              });
            }
          } catch {}
          return gain;
        }
        close() {
          window.__audioContextClosed = true;
          return super.close();
        }
      }
      window.AudioContext = ObservedAudioContext;
      if (window.webkitAudioContext) window.webkitAudioContext = ObservedAudioContext;
    }

    // Stub getUserMedia so it doesn't throw in environments without a real mic.
    navigator.mediaDevices = navigator.mediaDevices || {};
    navigator.mediaDevices.getUserMedia = async () => {
      const track = { readyState: "live", stop() { this.readyState = "ended"; }, onended: null };
      return { getTracks: () => [track], getAudioTracks: () => [track] };
    };

    // --- Fake WebSocket ---
    class FakeWebSocket {
      static OPEN = 1;
      constructor(url) {
        this.url = url;
        this.readyState = FakeWebSocket.OPEN;
        this.bufferedAmount = 0;
        this.binaryType = "arraybuffer";
        window.__testWs = this;
        setTimeout(() => this.onopen && this.onopen(), 0);
      }
      send() {}
      close() {
        this.readyState = 3;
        if (this.onclose) this.onclose();
      }
    }
    window.WebSocket = FakeWebSocket;
  });
}

test.describe("Silent keep-alive", () => {
  test("creates oscillator on user gesture", async ({ page }) => {
    await addStubs(page);
    await page.goto(pageUrl("test-token"));
    await page.waitForFunction(() => !!window.__testWs);

    // Before gesture
    await expect.poll(async () => page.evaluate(() => window.__oscillatorsCreated)).toBe(0);

    // Trigger gesture
    await page.click("body");
    await page.waitForTimeout(100);

    // Verify oscillator was created, gain was set to 0, connected, and started
    await expect.poll(async () => page.evaluate(() => window.__oscillatorsCreated >= 1)).toBe(true);
    await expect.poll(async () => page.evaluate(() => window.__gainsCreated >= 1)).toBe(true);
    await expect.poll(async () => page.evaluate(() => window.__lastGainValue)).toBe(0);
    await expect.poll(async () => page.evaluate(() => window.__oscConnected)).toBe(true);
    await expect.poll(async () => page.evaluate(() => window.__oscStarted)).toBe(true);
  });

  test("survives across WebSocket reconnections", async ({ page }) => {
    await addStubs(page);
    await page.goto(pageUrl("test-token"));
    await page.waitForFunction(() => !!window.__testWs);

    // Start keep-alive
    await page.click("body");
    await page.waitForTimeout(100);
    await expect.poll(async () => page.evaluate(() => window.__oscStarted)).toBe(true);

    const oscCountBefore = await page.evaluate(() => window.__oscillatorsCreated);

    // Simulate socket close + reconnect
    await page.evaluate(() => {
      const ws = window.__testWs;
      ws.close();
    });
    await page.waitForTimeout(100);

    // Keep-alive should still be active (oscillator not stopped by socket close)
    const oscStopped = await page.evaluate(() => window.__oscStopped);
    expect(oscStopped).toBe(false);

    // No new oscillator should have been created (it's idempotent, still running)
    const oscCountAfter = await page.evaluate(() => window.__oscillatorsCreated);
    expect(oscCountAfter).toBe(oscCountBefore);
  });

  test("closeAudioContext stops silent keep-alive", async ({ page }) => {
    await addStubs(page);
    await page.goto(pageUrl("test-token"));
    await page.waitForFunction(() => !!window.__testWs);

    // Start keep-alive
    await page.click("body");
    await page.waitForTimeout(100);
    await expect.poll(async () => page.evaluate(() => window.__oscStarted)).toBe(true);

    // Call closeAudioContext()
    await page.evaluate(() => {
      // eslint-disable-next-line no-undef
      closeAudioContext();
    });
    await page.waitForTimeout(50);

    // Oscillator should have been stopped and disconnected
    await expect.poll(async () => page.evaluate(() => window.__oscStopped)).toBe(true);
    await expect.poll(async () => page.evaluate(() => window.__oscDisconnected)).toBe(true);
  });

  test("is idempotent (multiple calls create only one oscillator)", async ({ page }) => {
    await addStubs(page);
    await page.goto(pageUrl("test-token"));
    await page.waitForFunction(() => !!window.__testWs);

    // Call startSilentKeepAlive twice
    await page.evaluate(() => {
      // eslint-disable-next-line no-undef
      startSilentKeepAlive();
      // eslint-disable-next-line no-undef
      startSilentKeepAlive();
    });
    await page.waitForTimeout(50);

    // Only one oscillator should have been created
    const count = await page.evaluate(() => window.__oscillatorsCreated);
    expect(count).toBe(1);
  });
});
