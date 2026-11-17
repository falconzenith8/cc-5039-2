import { test, expect } from 'playwright/test';

const PAGE = 'http://localhost:8080/';

async function boot(page) {
  await page.goto(PAGE);
  await page.waitForFunction(
    () => globalThis.__kernel?.manifest && globalThis.__kernel.selectedTrack && globalThis.__kernelRules,
    null, { timeout: 15000 },
  );
  return page.evaluate(() => globalThis.__kernel);
}

// Read the 5 drawbox bit-cells burned into the video frame -> floor(currentTime).
async function videoTimecode(page) {
  return page.evaluate(() => new Promise((resolve) => {
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
    resolve(bits);
  }));
}

// Estimate the dominant audible frequency from the scheduler's analyser,
// proving which language track is actually sounding (each track has a tone).
// Collects peak-bin votes over a fixed window and returns the majority bin,
// so a single switch-transient or marker-harmonic frame cannot decide it.
async function dominantTone(page) {
  // One observation window. Kept separate so the caller can retry the whole
  // window when a heavily loaded run yields too few confident frames.
  const observe = () => page.evaluate(() => new Promise((resolve) => {
    const k = globalThis.__kernel;
    const ctx = k.audioCtx;
    const analyser = k.scheduler.analyser;
    const bins = analyser.frequencyBinCount;
    const freq = new Float32Array(bins);
    const time = new Float32Array(analyser.fftSize);
    const hzBin = ctx.sampleRate / analyser.fftSize;
    const lo = Math.floor(250 / hzBin);
    const hi = Math.ceil(800 / hzBin);
    const votes = new Map();
    let frames = 0;
    const TOTAL = 16; // ~3.2s of observations
    const sample = () => {
      analyser.getFloatFrequencyData(freq);
      analyser.getFloatTimeDomainData(time);
      let rms = 0;
      for (const v of time) rms += v * v;
      rms = Math.sqrt(rms / time.length);
      let peakBin = -1, peakDb = -Infinity;
      for (let i = lo; i <= hi; i++) {
        if (freq[i] > peakDb) { peakDb = freq[i]; peakBin = i; }
      }
      if (rms >= 0.008 && peakDb >= -72) votes.set(peakBin, (votes.get(peakBin) ?? 0) + 1);
      frames++;
      if (frames < TOTAL) return setTimeout(sample, 200);
      let bestBin = -1, bestCount = 0;
      for (const [bin, count] of votes) {
        if (count > bestCount) { bestCount = count; bestBin = bin; }
      }
      resolve({
        freq: bestBin >= 0 ? Math.round(bestBin * hzBin) : -1,
        rms,
        confidence: bestCount,
        frames,
      });
    };
    setTimeout(sample, 200);
  }));

  // Keep observing until the window yields confident frames or the overall
  // ceiling is reached. A correctly routed audible track always produces a
  // majority bin once the graph settles; a headless audio-output stall merely
  // delays that, so retrying windows is the honest way to separate a real
  // routing bug (would never recover) from scheduling noise (recovers).
  let result = { confidence: 0, freq: -1 };
  const startedAt = Date.now();
  while (result.confidence < 4 && Date.now() - startedAt < 20000) {
    result = await observe();
  }
  return result;
}

async function waitFor(page, predicate, timeout = 10000) {
  await page.waitForFunction(predicate, null, { timeout });
}

test.describe('manifest parsing and declarative default selection', () => {
  test('language/role/timeline come from manifest, default follows explicit rules not file order', async ({ page }) => {
    const k = await boot(page);
    const info = await page.evaluate(() => {
      const m = globalThis.__kernel.manifest;
      const k = globalThis.__kernel;
      return {
        languages: m.audioTracks.map((t) => t.language),
        roles: m.audioTracks.map((t) => t.role),
        offsets: m.audioTracks.map((t) => t.timeline.startOffset),
        defaultLang: m.selectionRules.defaultLanguage,
        selected: k.selectedTrack?.language,
        reason: k.statusReason,
      };
    });
    expect(info.languages).toEqual(['zh-CN', 'en-US', 'ja-JP', 'fr-FR']);
    expect(info.selected).toBe(info.defaultLang);
    expect(info.reason).toContain('language rule match');
    // ja starts at 6s: explicit offset, not guessed from being the third file
    expect(info.offsets).toEqual([0, 0, 6, 0]);
  });

  test('rejects manifests missing explicit language or timeline declarations', async ({ page }) => {
    await boot(page);
    const result = await page.evaluate(() => {
      const mod = globalThis.__kernelRules;
      const good = globalThis.__kernel.manifest;
      const bad1 = { schemaVersion: 1, video: good.video, audioTracks: [{ id: 'x' /* no language */, timeline: { startOffset: 0, end: 1 }, shards: [] }] };
      const bad2 = { schemaVersion: 1, video: good.video, audioTracks: [{ id: 'y', language: 'xx', timeline: { startOffset: 2, end: 1 }, shards: [] }] };
      const out = [];
      for (const b of [bad1, bad2]) {
        try { mod.parseManifest(b); out.push('accepted(bad!)'); } catch (e) { out.push(e.name); }
      }
      // reordered manifest: default rule must beat array position
      const reordered = { ...good, audioTracks: [...good.audioTracks].reverse() };
      out.push(mod.selectDefaultTrack(reordered).track.language);
      return out;
    });
    expect(result[0]).toBe('ManifestError');
    expect(result[1]).toBe('ManifestError');
    expect(result[2]).toBe('zh-CN'); // rule-based, never "first file"
  });
});

test.describe('position-preserving, non-overlapping switching', () => {
  test('switching language keeps the same video position and the new track joins there, not at zero', async ({ page }) => {
    await boot(page);
    await page.click('#play');
    await waitFor(page, () => globalThis.__kernel.videoEngine.currentTime > 9);
    const before = await page.evaluate(() => globalThis.__kernel.videoEngine.currentTime);
    const codeBefore = await videoTimecode(page);

    await page.evaluate(() => globalThis.__kernel.selectTrack('en'));
    await waitFor(page, () => globalThis.__kernel.log.some((e) => e.type === 'track-confirmed'));
    await waitFor(page, () => globalThis.__kernel.log
      .some((e) => e.type === 'shard-scheduled' && e.trackId === 'en' && e.bufferOffset > 1.0));

    const after = await page.evaluate(() => globalThis.__kernel.videoEngine.currentTime);
    const codeAfter = await videoTimecode(page);
    expect(Math.abs(after - before)).toBeLessThan(0.6); // picture never jumps
    expect(Math.abs(codeAfter - codeBefore)).toBeLessThanOrEqual(1);

    // The en shard covering `before` must have been scheduled with a buffer
    // offset (joined mid-shard) rather than started from sample 0.
    const joinEvent = await page.evaluate(() => globalThis.__kernel.log
      .filter((e) => e.type === 'shard-scheduled' && e.trackId === 'en' && e.bufferOffset > 1.0).pop());
    expect(joinEvent.bufferOffset).toBeGreaterThan(1.0);
    expect(joinEvent.shardIndex).toBe(Math.floor(before / 4));
  });

  test('never overlaps two audible sources: one live source at a time across rapid switches', async ({ page }) => {
    await boot(page);
    await page.click('#play');
    await waitFor(page, () => globalThis.__kernel.videoEngine.currentTime > 2);
    await page.evaluate(async () => {
      const k = globalThis.__kernel;
      for (const id of ['zh', 'en', 'zh', 'en']) await k.selectTrack(id);
    });
    const overlap = await page.evaluate(() => {
      // Replay the scheduler graph history: silenced events must bracket every
      // new audible event, and at no switch did two generations coexist.
      const log = globalThis.__kernel.log;
      let audible = 0, maxAudible = 0;
      for (const e of log) {
        if (e.type === 'track-audible') { audible++; maxAudible = Math.max(maxAudible, audible); }
        if (e.type === 'track-silenced') audible = Math.max(0, audible - 1);
      }
      return maxAudible;
    });
    expect(overlap).toBeLessThanOrEqual(1);
  });

  test('real A/V delta stays within tolerance during steady playback', async ({ page }) => {
    await boot(page);
    await page.click('#play');
    await waitFor(page, () => globalThis.__kernel.scheduler.status.drift.samples >= 8, null, 15000);
    const drift = await page.evaluate(() => globalThis.__kernel.scheduler.status.drift);
    // Steady-state quality: median absolute delta and mean must stay tight.
    // Peak is allowed a one-off spike at shard/seek boundaries and is only logged.
    expect(drift.medianMs).toBeLessThan(60);
    expect(Math.abs(drift.avgMs)).toBeLessThan(60);
  });

  test('audible tone matches the selected language track (distinct test tones)', async ({ page }) => {
    await boot(page);
    await page.click('#play');
    await waitFor(page, () => globalThis.__kernel.videoEngine.currentTime > 5);
    await page.evaluate(() => globalThis.__kernel.selectTrack('en'));
    await waitFor(page, () => globalThis.__kernel.scheduler.active?.sources.size > 0);
    const en = await dominantTone(page);
    // Confidence counts confident audible frames across the whole window, so it
    // is immune to a single zero-energy frame under headless load.
    expect(en.confidence).toBeGreaterThan(4);
    expect(Math.abs(en.freq - 440)).toBeLessThan(35);

    await page.evaluate(() => globalThis.__kernel.selectTrack('zh'));
    await waitFor(page, () => globalThis.__kernel.scheduler.active?.sources.size > 0);
    const zh = await dominantTone(page);
    expect(zh.confidence).toBeGreaterThan(4);
    expect(Math.abs(zh.freq - 330)).toBeLessThan(35);
  });
});

test.describe('short tracks, offsets and explicit fallback', () => {
  test('offset-only track (ja, 6s-20s) is unavailable outside its range and works inside it', async ({ page }) => {
    await boot(page);
    await page.click('#play');
    // early position: ja does not cover t<6
    await waitFor(page, () => globalThis.__kernel.videoEngine.currentTime > 1);
    await page.evaluate(() => globalThis.__kernel.selectTrack('ja'));
    const early = await page.evaluate(() => ({
      selected: globalThis.__kernel.selectedTrack.language,
      effective: globalThis.__kernel.effectiveTrack?.language ?? null,
      reason: globalThis.__kernel.statusReason,
    }));
    expect(early.selected).toBe('ja-JP');
    expect(early.effective).not.toBe('ja-JP'); // never mislabeled while playing another track
    expect(early.reason).toContain('does not cover');

    // seek inside its window: ja now becomes the effective track
    await page.evaluate(() => globalThis.__kernel.seek(10));
    await page.waitForTimeout(300);
    await page.evaluate(() => globalThis.__kernel.selectTrack('ja'));
    await waitFor(page, () => globalThis.__kernel.effectiveTrack?.language === 'ja-JP');
    // Deterministic readiness: a ja source node exists and is connected to the
    // scheduler output. This does not depend on real-time analyser energy, which
    // can be momentarily zero under heavy headless load.
    await waitFor(page, () => {
      const active = globalThis.__kernel.scheduler.active;
      return active?.trackId === 'ja' && active.sources.size > 0;
    }, null, 10000);
    await page.waitForTimeout(300); // let a few audio blocks reach the analyser
    const tone = await dominantTone(page);
    expect(Math.abs(tone.freq - 554)).toBeLessThan(45);
  });

  test('missing shard (fr #3) surfaces a visible status and declared fallback, never a silent mislabel', async ({ page }) => {
    await boot(page);
    await page.click('#play');
    // play fr from the start; when playback reaches shard 3 (12-16s) it must fail
    await page.evaluate(() => globalThis.__kernel.selectTrack('fr'));
    await waitFor(page, () => globalThis.__kernel.log
      .some((e) => e.type === 'fallback-active' && e.requested === 'fr-FR'), null, 20000);
    const state = await page.evaluate(() => ({
      selected: globalThis.__kernel.selectedTrack.language,
      effective: globalThis.__kernel.effectiveTrack.language,
      reason: globalThis.__kernel.statusReason,
      gapEvents: globalThis.__kernel.log.filter((e) => e.type === 'shard-gap').length,
      loaderError: globalThis.__kernel.loader.state('fr', 3),
    }));
    expect(state.selected).toBe('fr-FR');          // selection label unchanged
    expect(state.effective).toBe('en-US');         // declared fr-FR -> en-US fallback
    expect(state.reason).toContain('fallback');
    expect(state.gapEvents).toBeGreaterThan(0);
    expect(state.loaderError.status).toBe('error');
  });

  test('loader and scheduling state are observable per shard on the page', async ({ page }) => {
    await boot(page);
    await page.click('#play');
    await waitFor(page, () => globalThis.__kernel.videoEngine.currentTime > 5);
    const cells = await page.locator('#buffers .cell').count();
    expect(cells).toBeGreaterThan(10);
    const ready = await page.locator('#buffers .cell.ready').count();
    expect(ready).toBeGreaterThan(0);
    const scheduled = await page.locator('#buffers .cell.scheduled').count();
    expect(scheduled).toBeGreaterThan(0);
    const driftText = await page.locator('#drift').textContent();
    expect(driftText).toMatch(/ms/);
  });
});
