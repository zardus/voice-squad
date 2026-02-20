// @ts-check
/**
 * Auto Listen behavior tests.
 *
 * The app no longer pre-acquires the mic on user gestures. Instead:
 * - A silent keep-alive oscillator starts on user gesture (to keep Safari alive).
 * - getUserMedia is only called during push-to-talk (startRecording).
 * - setAutoListenEnabled no longer takes an `acquire` parameter.
 */
const { test, expect } = require("@playwright/test");
const { pageUrl } = require("./helpers/config");

/** Common init script that stubs getUserMedia, WebSocket, AudioContext, and localStorage. */
function addStubs(page, { autolisten = "true" } = {}) {
  return page.addInitScript((opts) => {
    localStorage.setItem("autolisten", opts.autolisten);

    // --- getUserMedia stub ---
    window.__gumCalls = 0;
    window.__stopCount = 0;
    window.__trackSeq = 0;
    window.__tracks = [];
    navigator.mediaDevices = navigator.mediaDevices || {};
    navigator.mediaDevices.getUserMedia = async () => {
      window.__gumCalls += 1;
      const trackId = ++window.__trackSeq;
      const track = {
        id: trackId,
        readyState: "live",
        stop() {
          window.__stopCount += 1;
          this.readyState = "ended";
          if (typeof this.onended === "function") this.onended();
        },
        onended: null,
      };
      window.__tracks.push(track);
      return { getTracks: () => [track], getAudioTracks: () => [track] };
    };

    // --- AudioContext observation ---
    window.__oscillatorsCreated = 0;
    window.__gainsCreated = 0;
    window.__oscConnected = false;
    window.__oscStarted = false;
    window.__lastGainValue = null;
    window.__audioContextState = null;

    const OrigAudioContext = window.AudioContext || window.webkitAudioContext;
    if (OrigAudioContext) {
      class ObservedAudioContext extends OrigAudioContext {
        constructor(...args) {
          super(...args);
          window.__audioContextState = this.state;
          // Track state changes
          const origClose = this.close.bind(this);
          this.close = async () => {
            const result = await origClose();
            window.__audioContextState = "closed";
            return result;
          };
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
          return osc;
        }
        createGain() {
          const gain = super.createGain();
          window.__gainsCreated += 1;
          // Observe gain.value writes via a polling approach (AudioParam is not easily proxied)
          const origGain = gain.gain;
          // Record initial value after creation
          setTimeout(() => {
            window.__lastGainValue = origGain.value;
          }, 0);
          // Intercept the value setter
          try {
            const desc = Object.getOwnPropertyDescriptor(AudioParam.prototype, "value");
            if (desc && desc.set) {
              Object.defineProperty(origGain, "value", {
                get: () => desc.get.call(origGain),
                set: (v) => {
                  window.__lastGainValue = v;
                  desc.set.call(origGain, v);
                },
                configurable: true,
              });
            }
          } catch {}
          return gain;
        }
      }
      window.AudioContext = ObservedAudioContext;
      if (window.webkitAudioContext) window.webkitAudioContext = ObservedAudioContext;
    }

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
  }, { autolisten });
}

test.describe("Auto Listen", () => {
  test("mic is NOT pre-acquired on user gesture", async ({ page }) => {
    if (process.env.PW_PAGE_DEBUG) {
      page.on("console", (msg) => console.log(`[browser:${msg.type()}] ${msg.text()}`));
      page.on("pageerror", (err) => console.log(`[pageerror] ${err && err.stack ? err.stack : String(err)}`));
    }

    await addStubs(page, { autolisten: "true" });

    await page.goto(pageUrl("test-token"));
    await page.waitForFunction(() => !!window.__testWs);

    // No mic acquired yet
    await expect.poll(async () => page.evaluate(() => window.__gumCalls)).toBe(0);

    // Perform a user gesture (click on body)
    await page.click("body");
    await page.waitForTimeout(100);

    // getUserMedia should still NOT have been called
    await expect.poll(async () => page.evaluate(() => window.__gumCalls)).toBe(0);

    // But AudioContext should have been created (for the silent keep-alive)
    await expect.poll(async () => page.evaluate(() => window.__audioContextState !== null)).toBe(true);
  });

  test("silent keep-alive starts on user gesture", async ({ page }) => {
    if (process.env.PW_PAGE_DEBUG) {
      page.on("console", (msg) => console.log(`[browser:${msg.type()}] ${msg.text()}`));
      page.on("pageerror", (err) => console.log(`[pageerror] ${err && err.stack ? err.stack : String(err)}`));
    }

    await addStubs(page, { autolisten: "true" });

    await page.goto(pageUrl("test-token"));
    await page.waitForFunction(() => !!window.__testWs);

    // Before gesture: no oscillator or gain created
    await expect.poll(async () => page.evaluate(() => window.__oscillatorsCreated)).toBe(0);
    await expect.poll(async () => page.evaluate(() => window.__gainsCreated)).toBe(0);

    // Perform a user gesture
    await page.click("body");
    await page.waitForTimeout(100);

    // startSilentKeepAlive should have created an OscillatorNode and a GainNode.
    // Note: the app also uses createOscillator/createGain for chimes/dings, but
    // startSilentKeepAlive is the first call triggered by a plain click on body.
    // We check that at least one oscillator and one gain were created.
    await expect.poll(async () => page.evaluate(() => window.__oscillatorsCreated >= 1)).toBe(true);
    await expect.poll(async () => page.evaluate(() => window.__gainsCreated >= 1)).toBe(true);

    // Gain value should be 0 (silent)
    await expect.poll(async () => page.evaluate(() => window.__lastGainValue)).toBe(0);

    // Oscillator should have been connected and started
    await expect.poll(async () => page.evaluate(() => window.__oscConnected)).toBe(true);
    await expect.poll(async () => page.evaluate(() => window.__oscStarted)).toBe(true);
  });

  test("push-to-talk acquires mic on demand", async ({ page }) => {
    if (process.env.PW_PAGE_DEBUG) {
      page.on("console", (msg) => console.log(`[browser:${msg.type()}] ${msg.text()}`));
      page.on("pageerror", (err) => console.log(`[pageerror] ${err && err.stack ? err.stack : String(err)}`));
    }

    await addStubs(page, { autolisten: "true" });

    await page.goto(pageUrl("test-token"));
    await page.waitForFunction(() => !!window.__testWs);

    // No mic acquired yet
    await expect.poll(async () => page.evaluate(() => window.__gumCalls)).toBe(0);

    // Simulate push-to-talk: mousedown on #mic-btn
    const micBtn = page.locator("#mic-btn");
    await micBtn.dispatchEvent("mousedown");
    await page.waitForTimeout(200);

    // getUserMedia should now have been called
    await expect.poll(async () => page.evaluate(() => window.__gumCalls)).toBe(1);

    // Simulate release: mouseup on #mic-btn
    await micBtn.dispatchEvent("mouseup");

    // After release + delay, mic tracks should be stopped
    // stopRecording calls stopMicStream after a 500ms delay
    await page.waitForTimeout(700);
    await expect.poll(async () => page.evaluate(() => window.__stopCount >= 1)).toBe(true);
  });

  test("re-press within release window does not stop newly acquired mic stream", async ({ page }) => {
    if (process.env.PW_PAGE_DEBUG) {
      page.on("console", (msg) => console.log(`[browser:${msg.type()}] ${msg.text()}`));
      page.on("pageerror", (err) => console.log(`[pageerror] ${err && err.stack ? err.stack : String(err)}`));
    }

    await addStubs(page, { autolisten: "true" });

    await page.goto(pageUrl("test-token"));
    await page.waitForFunction(() => !!window.__testWs);

    const micBtn = page.locator("#mic-btn");

    // First hold: acquire mic stream #1.
    await micBtn.dispatchEvent("mousedown");
    await page.waitForTimeout(200);
    await expect.poll(async () => page.evaluate(() => window.__gumCalls)).toBe(1);

    // Release schedules a 500ms delayed mic release.
    await micBtn.dispatchEvent("mouseup");

    // Simulate stream #1 ending before the next hold so startRecording reacquires.
    await page.evaluate(() => {
      const firstTrack = window.__tracks[0];
      if (!firstTrack) return;
      firstTrack.readyState = "ended";
      if (typeof firstTrack.onended === "function") firstTrack.onended();
    });

    // Re-press within the 500ms release window; this should acquire stream #2.
    await page.waitForTimeout(100);
    await micBtn.dispatchEvent("mousedown");
    await page.waitForTimeout(200);
    await expect.poll(async () => page.evaluate(() => window.__gumCalls)).toBe(2);

    // Wait until after the first release timer would have fired.
    await page.waitForTimeout(300);
    await expect.poll(async () =>
      page.evaluate(() => {
        const latestTrack = window.__tracks[window.__tracks.length - 1];
        return !!latestTrack && latestTrack.readyState === "live";
      })
    ).toBe(true);
    await expect.poll(async () => page.evaluate(() => window.__stopCount)).toBe(0);

    // Final release should stop the current stream after the delayed release window.
    await micBtn.dispatchEvent("mouseup");
    await page.waitForTimeout(700);
    await expect.poll(async () => page.evaluate(() => window.__stopCount >= 1)).toBe(true);
  });

  test("autolisten OFF disables push-to-talk", async ({ page }) => {
    if (process.env.PW_PAGE_DEBUG) {
      page.on("console", (msg) => console.log(`[browser:${msg.type()}] ${msg.text()}`));
      page.on("pageerror", (err) => console.log(`[pageerror] ${err && err.stack ? err.stack : String(err)}`));
    }

    await addStubs(page, { autolisten: "false" });

    await page.goto(pageUrl("test-token"));
    await page.waitForFunction(() => !!window.__testWs);

    // No mic acquired
    await expect.poll(async () => page.evaluate(() => window.__gumCalls)).toBe(0);

    // Simulate push-to-talk: mousedown on #mic-btn
    const micBtn = page.locator("#mic-btn");
    await micBtn.dispatchEvent("mousedown");
    await page.waitForTimeout(200);

    // getUserMedia should NOT have been called because autolisten is OFF
    await expect.poll(async () => page.evaluate(() => window.__gumCalls)).toBe(0);
  });

  test("autolisten OFF does NOT stop silent keep-alive", async ({ page }) => {
    if (process.env.PW_PAGE_DEBUG) {
      page.on("console", (msg) => console.log(`[browser:${msg.type()}] ${msg.text()}`));
      page.on("pageerror", (err) => console.log(`[pageerror] ${err && err.stack ? err.stack : String(err)}`));
    }

    await addStubs(page, { autolisten: "true" });

    await page.goto(pageUrl("test-token"));
    await page.waitForFunction(() => !!window.__testWs);

    // Trigger user gesture to start the silent keep-alive
    await page.click("body");
    await page.waitForTimeout(100);

    // Verify keep-alive started (oscillator created)
    await expect.poll(async () => page.evaluate(() => window.__oscillatorsCreated >= 1)).toBe(true);

    // AudioContext should be running (not closed)
    await expect.poll(async () =>
      page.evaluate(() => {
        const state = window.__audioContextState;
        return state === "running" || state === "suspended";
      })
    ).toBe(true);

    // Toggle autolisten OFF
    await page.evaluate(() => {
      // eslint-disable-next-line no-undef
      setAutoListenEnabled(false);
    });
    await page.waitForTimeout(100);

    // AudioContext should still be active (not closed) — keep-alive is independent of autolisten
    const state = await page.evaluate(() => window.__audioContextState);
    expect(state).not.toBe("closed");
  });
});
