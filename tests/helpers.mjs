// Shared helpers for the combination/subtitle suites. Kept separate from the
// original kernel.spec.mjs so that suite stays focused on audio behavior.
import { expect } from 'playwright/test';

export const PAGE = 'http://localhost:8080/';

export async function boot(page) {
  await page.goto(PAGE);
  await page.waitForFunction(
    () => globalThis.__kernel?.manifest && globalThis.__kernel.selectedTrack && globalThis.__kernelRules,
    null, { timeout: 15000 },
  );
  return page.evaluate(() => globalThis.__kernel);
}

export async function waitFor(page, predicate, timeout = 15000) {
  await page.waitForFunction(predicate, null, { timeout });
}

// Read the 5 drawbox bit-cells burned into the video frame -> floor(currentTime).
export async function videoTimecode(page) {
  return page.evaluate(() => {
    const video = document.getElementById('video');
    const c = document.createElement('canvas');
    c.width = video.videoWidth; c.height = video.videoHeight;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, 0, 0);
    let bits = 0;
    for (let bit = 0; bit < 5; bit++) {
      const x = 220 + bit * 44 + 18, y = 180;
      const d = ctx.getImageData(x, y, 1, 1).data;
      if (d[2] > 150 && d[0] > 80) bits |= 1 << (4 - bit);
    }
    return bits;
  });
}

// Majority-vote dominant audible frequency from the scheduler's analyser,
// proving which language/role track is actually sounding. Retries whole
// observation windows so headless audio-output stalls cannot fail a real
// routing decision.
export async function dominantTone(page, loHz = 160, hiHz = 800) {
  const observe = () => page.evaluate(({ loHz, hiHz }) => new Promise((resolve) => {
    const k = globalThis.__kernel;
    const ctx = k.audioCtx;
    const analyser = k.scheduler.analyser;
    const bins = analyser.frequencyBinCount;
    const freq = new Float32Array(bins);
    const time = new Float32Array(analyser.fftSize);
    const hzBin = ctx.sampleRate / analyser.fftSize;
    const lo = Math.floor(loHz / hzBin);
    const hi = Math.ceil(hiHz / hzBin);
    const votes = new Map();
    let frames = 0;
    const TOTAL = 16;
    const sample = () => {
      analyser.getFloatFrequencyData(freq);
      analyser.getFloatTimeDomainData(time);
      let rms = 0;
      for (const v of time) rms += v * v;
      rms = Math.sqrt(rms / time.length);
      let peakBin = -1, peakDb = -Infinity;
      for (let i = lo; i <= hi; i++) {
        if (freq[i] > peakDb) { peakBin = i; peakDb = freq[i]; }
      }
      if (rms >= 0.008 && peakDb >= -72) votes.set(peakBin, (votes.get(peakBin) ?? 0) + 1);
      frames++;
      if (frames < TOTAL) return setTimeout(sample, 200);
      let bestBin = -1, bestCount = 0;
      for (const [bin, count] of votes) {
        if (count > bestCount) { bestCount = count; bestBin = bin; }
      }
      resolve({ freq: bestBin >= 0 ? Math.round(bestBin * hzBin) : -1, rms, confidence: bestCount, frames });
    };
    setTimeout(sample, 200);
  }), { loHz, hiHz });

  let result = { confidence: 0, freq: -1 };
  const startedAt = Date.now();
  while (result.confidence < 4 && Date.now() - startedAt < 25000) {
    result = await observe();
  }
  return result;
}

export async function overlayText(page) {
  return page.locator('#subtitle-overlay').innerText();
}

// Delay every shard fetch whose URL matches `pattern` by `ms`. Used to prove
// that slow encoding/loading of one track cannot make a newer selection render
// a stale mix of audio and captions.
export async function delayRoute(page, pattern, ms) {
  await page.route(`**/*${pattern}*`, async (route) => {
    await new Promise((r) => setTimeout(r, ms));
    await route.continue();
  });
}

export async function clearRoutes(page) {
  await page.unroute('**/*');
}

export { expect };
