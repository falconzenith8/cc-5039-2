// Combination (audio + subtitle) behavior of the multilingual kernel.
//
// Covers: same-language/different-role identity, cues crossing shard
// boundaries, a subtitle track that ends mid-program, disallowed and
// unavailable combinations, rapid-switch version consistency, the
// audio-only legacy path, the off-captions behavior, scrubber seeks, and
// delayed-decode track identity plus A/V sync.
import { test } from 'playwright/test';
import { boot, waitFor, videoTimecode, dominantTone, overlayText, delayRoute, clearRoutes, expect } from './helpers.mjs';

const combo = (page, audioId, subtitleId) =>
  page.evaluate(({ audioId, subtitleId }) =>
    globalThis.__kernel.selectCombination({ audioId, subtitleId }), { audioId, subtitleId });

test.describe('same language, different roles', () => {
  test('zh-CN main narration and zh-CN description are distinct selectable tracks, never merged by language', async ({ page }) => {
    await boot(page);
    const info = await page.evaluate(() => {
      const m = globalThis.__kernel.manifest;
      return {
        zhAudio: m.audioTracks.filter((t) => t.language === 'zh-CN').map((t) => `${t.id}:${t.role}`),
        zhSubs: m.subtitleTracks.filter((t) => t.language === 'zh-CN').map((t) => `${t.id}:${t.role}`),
      };
    });
    expect(info.zhAudio).toEqual(['zh:main', 'zh-desc:description']);
    expect(info.zhSubs).toEqual(['zh-dialogue:dialogue', 'zh-forced:forced']);

    // Both audio rows render separately with their role shown on screen.
    const rows = await page.locator('#tracks .track').allInnerTexts();
    const joined = rows.join('\n');
    expect(joined).toContain('role=main');
    expect(joined).toContain('role=description');
    expect(rows.length).toBe(5);
  });

  test('description audio actually sounds at its own tone (220Hz), distinct from the 330Hz zh main', async ({ page }) => {
    await boot(page);
    await page.click('#play');
    await waitFor(page, () => globalThis.__kernel.videoEngine.currentTime > 2);
    await combo(page, 'zh-desc', null);
    await waitFor(page, () => globalThis.__kernel.scheduler.active?.trackId === 'zh-desc'
      && globalThis.__kernel.scheduler.active.sources.size > 0);
    const tone = await dominantTone(page);
    expect(tone.confidence).toBeGreaterThan(4);
    expect(Math.abs(tone.freq - 220)).toBeLessThan(35);
    const d = await page.evaluate(() => globalThis.__kernel.describe());
    expect(d.effective.id).toBe('zh-desc');
    expect(d.effective.role).toBe('description');
  });
});

test.describe('subtitles on the video timeline', () => {
  test('a cue crossing the 4s shard boundary stays rendered and matches the current position', async ({ page }) => {
    await boot(page);
    await page.click('#play');
    await combo(page, 'zh', 'zh-dialogue');
    await waitFor(page, () => globalThis.__kernel.effectiveSubtitle?.id === 'zh-dialogue');

    // Cue 3.4s–5.8s spans shards 0 and 1.
    await page.evaluate(() => globalThis.__kernel.seek(3.6));
    await page.waitForTimeout(400);
    let text = await overlayText(page);
    expect(text).toContain('灯光渐暗');
    const tcBefore = await videoTimecode(page);

    // After crossing the boundary the same cue is still on screen (deduped,
    // not cut by the shard fetch) and the timecode has advanced with video.
    await waitFor(page, () => globalThis.__kernel.videoEngine.currentTime > 4.2, null, 8000);
    text = await overlayText(page);
    expect(text).toContain('灯光渐暗');
    const tcAfter = await videoTimecode(page);
    // Same burned-in cell geometry before/after: only the low-order time bits
    // may differ (the top progress-bar cells add a constant bias to both reads).
    expect(Math.abs(tcAfter - tcBefore)).toBeLessThanOrEqual(2);

    // Cue ends at 5.8s: overlay must clear through its own end time.
    await waitFor(page, () => globalThis.__kernel.videoEngine.currentTime > 5.95, null, 10000);
    await page.waitForTimeout(350);
    text = await overlayText(page);
    expect(text.trim()).toBe('');
  });

  test('cue text shown on screen equals the manifest cue for the video clock', async ({ page }) => {
    await boot(page);
    await combo(page, 'en', 'zh-forced');
    await waitFor(page, () => globalThis.__kernel.effectiveSubtitle?.id === 'zh-forced');
    await page.evaluate(() => globalThis.__kernel.seek(10.5));
    await page.waitForTimeout(400);
    const text = await overlayText(page);
    expect(text).toContain('三，二，一');
    const event = await page.evaluate(() =>
      globalThis.__kernel.log.filter((e) => e.type === 'subtitle-cue').pop());
    expect(event.texts[0]).toContain('三，二，一');
  });

  test('subtitle track ending mid-program (en-forced ends at 16s) announces the end and clears, audio keeps playing', async ({ page }) => {
    await boot(page);
    await page.click('#play');
    await combo(page, 'en', 'en-forced');
    await waitFor(page, () => globalThis.__kernel.effectiveSubtitle?.id === 'en-forced');
    await page.evaluate(() => globalThis.__kernel.seek(14.5));
    await page.waitForTimeout(400);
    expect(await overlayText(page)).toContain('Final chapter');

    await page.evaluate(() => globalThis.__kernel.seek(17));
    await waitFor(page, () => globalThis.__kernel.videoEngine.currentTime > 16.5);
    await waitFor(page, () => globalThis.__kernel.log.some((e) =>
      e.type === 'subtitle-unavailable' || e.type === 'subtitle-uncovered'));
    const state = await page.evaluate(() => ({
      selected: globalThis.__kernel.selectedSubtitle?.id ?? null,
      effective: globalThis.__kernel.effectiveSubtitle?.id ?? null,
      notice: globalThis.__kernel.lastNotice,
      audible: globalThis.__kernel.scheduler.active?.trackId ?? null,
    }));
    expect(state.selected).toBe('en-forced');      // request remains visible
    expect(state.effective).toBeNull();            // but nothing is rendered
    expect(state.notice.kind).toBe('subtitle-unavailable');
    expect(state.audible).toBe('en');              // audio untouched
    expect((await overlayText(page)).trim()).toBe('');
  });

  test('selecting an ended subtitle after its range is rejected with an explicit on-screen notice', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => globalThis.__kernel.seek(18));
    await waitFor(page, () => globalThis.__kernel.videoEngine.currentTime > 17);
    const result = await combo(page, 'en', 'en-forced');
    expect(result.accepted).toBe(true); // request accepted, subtitle leg fails explicitly
    await waitFor(page, () => globalThis.__kernel.lastNotice?.kind === 'subtitle-unavailable');
    const notice = await page.locator('#notice').innerText();
    expect(notice).toContain('字幕');
    expect(notice).toContain('不可用');
    expect(await overlayText(page)).toBe('');
  });

  test('reaching the subtitle end during natural playback clears it via a notice without touching audio', async ({ page }) => {
    await boot(page);
    await page.click('#play');
    await combo(page, 'en', 'en-forced');
    await waitFor(page, () => globalThis.__kernel.effectiveSubtitle?.id === 'en-forced');
    // Play across the 16s end of the en-forced timeline.
    await page.evaluate(() => globalThis.__kernel.seek(15.4));
    await page.waitForTimeout(300);
    const stillLive = await page.evaluate(() => globalThis.__kernel.effectiveSubtitle?.id);
    expect(stillLive).toBe('en-forced');
    await waitFor(page, () => globalThis.__kernel.effectiveSubtitle === null
      && globalThis.__kernel.log.some((e) => e.type === 'subtitle-ended'), null, 20000);
    const state = await page.evaluate(() => ({
      selected: globalThis.__kernel.selectedSubtitle.id,
      audible: globalThis.__kernel.scheduler.active?.trackId ?? null,
      notice: globalThis.__kernel.lastNotice?.kind ?? null,
    }));
    expect(state.selected).toBe('en-forced');
    expect(state.audible).toBe('en');
    expect(state.notice).toBe('subtitle-unavailable');
    expect((await overlayText(page)).trim()).toBe('');
  });
});

test.describe('combination rules', () => {
  test('description audio + dialogue subtitles is disallowed and changes nothing, with the declared reason shown', async ({ page }) => {
    await boot(page);
    await page.click('#play');
    await waitFor(page, () => globalThis.__kernel.videoEngine.currentTime > 1);
    const before = await page.evaluate(() => ({
      audio: globalThis.__kernel.effectiveTrack.id,
      sub: globalThis.__kernel.effectiveSubtitle?.id ?? null,
      version: globalThis.__kernel.comboVersion,
    }));
    const result = await combo(page, 'zh-desc', 'zh-dialogue');
    expect(result.accepted).toBe(false);
    expect(result.reason).toContain('描述性音频');

    const after = await page.evaluate(() => ({
      audio: globalThis.__kernel.effectiveTrack.id,
      sub: globalThis.__kernel.effectiveSubtitle?.id ?? null,
      version: globalThis.__kernel.comboVersion,
      rejected: globalThis.__kernel.log.filter((e) => e.type === 'combination-rejected').length,
    }));
    expect(after).toEqual({ ...before, rejected: 1 }); // no state mutation, no version bump
    await expect(page.locator('#notice')).toHaveClass(/show rejected/);
    expect(await page.locator('#notice').innerText()).toContain('禁止');
  });

  test('description audio + forced subtitles is allowed and both become effective', async ({ page }) => {
    await boot(page);
    await page.click('#play');
    const result = await combo(page, 'zh-desc', 'zh-forced');
    expect(result.accepted).toBe(true);
    await waitFor(page, () => globalThis.__kernel.effectiveSubtitle?.id === 'zh-forced');
    const d = await page.evaluate(() => globalThis.__kernel.describe());
    expect(d.effective.id).toBe('zh-desc');
    expect(d.effectiveSubtitle.id).toBe('zh-forced');
  });

  test('dialogue subtitles are allowed with a main audio track and render the full dialogue cue', async ({ page }) => {
    await boot(page);
    const result = await combo(page, 'zh', 'zh-dialogue');
    expect(result.accepted).toBe(true);
    await page.evaluate(() => globalThis.__kernel.seek(7.5));
    await page.waitForTimeout(400);
    expect(await overlayText(page)).toContain('第一幕');
  });
});

test.describe('rapid switching and version consistency', () => {
  test('consecutive combination requests converge on one confirmed version: no mixed audio/subtitle pair', async ({ page }) => {
    await boot(page);
    await page.click('#play');
    await waitFor(page, () => globalThis.__kernel.videoEngine.currentTime > 2);
    const pairs = [
      ['zh', 'zh-dialogue'], ['en', 'en-forced'], ['zh-desc', 'zh-forced'],
      ['zh', null], ['en', 'zh-dialogue'],
    ];
    await page.evaluate(async (pairs) => {
      const k = globalThis.__kernel;
      for (const [audioId, subtitleId] of pairs) {
        await k.selectCombination({ audioId, subtitleId });
      }
    }, pairs);

    await waitFor(page, () => {
      const k = globalThis.__kernel;
      const d = k.describe();
      // Both legs either belong to the final requested pair or the final
      // pair's declared fallback — never a pair from an older request.
      const audioOk = d.effective?.id === 'en';
      const subOk = d.effectiveSubtitle?.id === 'zh-dialogue';
      return audioOk && subOk && k.subtitleEngine.status.activeTrackId === 'zh-dialogue';
    });
    const d = await page.evaluate(() => globalThis.__kernel.describe());
    expect(d.effective.id).toBe('en');
    expect(d.effectiveSubtitle.id).toBe('zh-dialogue');
    expect(d.selected.id).toBe('en');
    expect(d.selectedSubtitle.id).toBe('zh-dialogue');
    expect(d.comboVersion).toBe(5);
    // The overlay never shows text from a superseded subtitle track.
    const text = await overlayText(page);
    if (text.trim()) expect(text).not.toContain('[FORCED]');
  });

  test('a slow subtitle fetch cannot land stale captions over a newer selection', async ({ page }) => {
    await boot(page);
    await delayRoute(page, 'subs-zh-dialogue', 2500);
    await page.click('#play');
    // First request starts the slow fetch; the second request wins before it
    // resolves.
    await page.evaluate(() => globalThis.__kernel.selectCombination({ audioId: 'zh', subtitleId: 'zh-dialogue' }));
    await page.waitForTimeout(300);
    await page.evaluate(() => globalThis.__kernel.selectCombination({ audioId: 'en', subtitleId: 'zh-forced' }));
    await waitFor(page, () => globalThis.__kernel.effectiveSubtitle?.id === 'zh-forced');
    // Wait long enough for the deliberately delayed first fetch to resolve.
    await page.waitForTimeout(3000);
    const state = await page.evaluate(() => ({
      active: globalThis.__kernel.subtitleEngine.status.activeTrackId,
      gen: globalThis.__kernel.subtitleEngine.generation,
      rendered: globalThis.__kernel.subtitleEngine.status.renderedCues,
    }));
    expect(state.active).toBe('zh-forced');
    expect(state.rendered.join(' ')).not.toContain('对白');
    await clearRoutes(page);
  });
});

test.describe('legacy audio-only path and captions off', () => {
  test('selectTrack keeps its original behavior: audio changes, subtitles stay on the same track and position', async ({ page }) => {
    await boot(page);
    await combo(page, 'zh', 'zh-dialogue');
    await waitFor(page, () => globalThis.__kernel.effectiveSubtitle?.id === 'zh-dialogue');
    await page.evaluate(() => globalThis.__kernel.seek(7.5));
    await page.waitForTimeout(400);
    expect(await overlayText(page)).toContain('第一幕');
    const subGen = await page.evaluate(() => globalThis.__kernel.subtitleEngine.generation);

    await page.evaluate(() => globalThis.__kernel.selectTrack('en'));
    await waitFor(page, () => globalThis.__kernel.effectiveTrack.id === 'en');
    await page.waitForTimeout(300);
    // Captions untouched by the audio-only switch: same engine generation,
    // same cue, same program position.
    const state = await page.evaluate(() => ({
      sub: globalThis.__kernel.effectiveSubtitle.id,
      gen: globalThis.__kernel.subtitleEngine.generation,
    }));
    expect(state.sub).toBe('zh-dialogue');
    expect(state.gen).toBe(subGen);
    expect(await overlayText(page)).toContain('第一幕');
  });

  test('turning subtitles off clears the overlay immediately while the audio keeps sounding', async ({ page }) => {
    await boot(page);
    await page.click('#play');
    await combo(page, 'zh', 'zh-dialogue');
    await page.evaluate(() => globalThis.__kernel.seek(7.5));
    await waitFor(page, () => (document.getElementById('subtitle-overlay').textContent.trim().length > 0));
    await combo(page, 'zh', null);
    await waitFor(page, () => globalThis.__kernel.effectiveSubtitle === null);
    expect((await overlayText(page)).trim()).toBe('');
    const audible = await page.evaluate(() => ({
      track: globalThis.__kernel.scheduler.active?.trackId ?? null,
      sources: globalThis.__kernel.scheduler.active?.sources.size ?? 0,
    }));
    expect(audible.track).toBe('zh');
    expect(audible.sources).toBeGreaterThan(0);
    const tone = await dominantTone(page);
    expect(tone.confidence).toBeGreaterThan(4);
    expect(Math.abs(tone.freq - 330)).toBeLessThan(35);
  });
});

test.describe('scrubber seek driven by the standalone kernel', () => {
  test('dragging the progress bar rebuilds picture, audio and captions at the new program position', async ({ page }) => {
    await boot(page);
    await page.click('#play');
    await combo(page, 'en', 'zh-dialogue');
    await waitFor(page, () => globalThis.__kernel.videoEngine.playing
      && globalThis.__kernel.scheduler.active?.sources.size > 0);

    const bar = page.locator('#seekbar');
    await bar.evaluate((el) => { el.value = '11.5'; el.dispatchEvent(new Event('change', { bubbles: true })); });
    await waitFor(page, () => Math.abs(globalThis.__kernel.videoEngine.currentTime - 11.5) < 1.0);
    await waitFor(page, () => globalThis.__kernel.log.some(
      (e) => e.type === 'shard-scheduled' && e.trackId === 'en' && e.t >= 10.5 && e.bufferOffset > 1.0));

    const tc = await videoTimecode(page);
    expect(tc).toBeGreaterThanOrEqual(11);
    const d = await page.evaluate(() => globalThis.__kernel.describe());
    expect(d.effective.id).toBe('en');
    expect(d.effectiveSubtitle.id).toBe('zh-dialogue');
    const join = await page.evaluate(() =>
      globalThis.__kernel.log
        .filter((e) => e.type === 'shard-scheduled' && e.trackId === 'en' && e.t >= 10.5)
        .pop());
    expect(join).toBeTruthy();
    expect(join.bufferOffset).toBeGreaterThan(1.0);
    await page.waitForTimeout(300);
    expect(await overlayText(page)).toContain('舞者');
  });
});

test.describe('delayed decode: track identity and A/V sync', () => {
  test('with a slow en decode, the confirmed en track still sounds as 440Hz and stays in A/V sync', async ({ page }) => {
    await boot(page);
    await delayRoute(page, 'audio-en', 1500);
    await page.click('#play');
    await waitFor(page, () => globalThis.__kernel.videoEngine.currentTime > 2);
    const t0 = await page.evaluate(() => globalThis.__kernel.videoEngine.currentTime);
    await combo(page, 'en', 'zh-forced');
    await waitFor(page, () => globalThis.__kernel.scheduler.active?.trackId === 'en'
      && globalThis.__kernel.scheduler.active.sources.size > 0, null, 20000);
    const t1 = await page.evaluate(() => globalThis.__kernel.videoEngine.currentTime);
    expect(Math.abs(t1 - t0)).toBeLessThan(1.5); // switch never resets the picture

    const tone = await dominantTone(page);
    expect(tone.confidence).toBeGreaterThan(4);
    expect(Math.abs(tone.freq - 440)).toBeLessThan(35);

    await waitFor(page, () => globalThis.__kernel.scheduler.status.drift.samples >= 6, null, 20000);
    const drift = await page.evaluate(() => globalThis.__kernel.scheduler.status.drift);
    expect(drift.medianMs).toBeLessThan(80);
    expect(Math.abs(drift.avgMs)).toBeLessThan(80);
    // Subtitle leg of the same confirmed version is live regardless of audio delay.
    const subId = await page.evaluate(() => globalThis.__kernel.effectiveSubtitle?.id);
    expect(subId).toBe('zh-forced');
    await clearRoutes(page);
  });
});
