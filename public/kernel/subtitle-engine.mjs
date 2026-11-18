// SubtitleEngine: cue rendering driven by the same master clock as the video.
//
// Subtitles are independent of the audible audio track: switching audio never
// touches this engine (captions stay at the same program position), and turning
// subtitles off only clears the overlay — audio keeps playing.
//
// Cue times are absolute program times on the video timeline. A cue may span a
// shard boundary: its JSON is duplicated into both shards and rendered from its
// declared start/end, so an in-flight shard fetch can never cut it short.
//
// Every async load is tagged with a generation; when the user switches again
// before an old fetch resolves, the stale payload is discarded and can never
// paint over the newer selection.

const TICK_MS = 200;

export class SubtitleEngine {
  constructor({ video, fetchImpl, overlay, onEvent } = {}) {
    this.video = video;
    this._fetch = fetchImpl ? fetchImpl.bind(globalThis) : globalThis.fetch.bind(globalThis);
    this.overlay = overlay ?? null;
    this.onEvent = onEvent ?? (() => {});
    this.generation = 0;
    this.active = null;                 // { track, generation, cache, rendered, ended }
    this.tickTimer = null;
    this.lastTime = null;
  }

  get activeTrack() {
    return this.active?.track ?? null;
  }

  get activeTrackId() {
    return this.active?.track.id ?? null;
  }

  // Make `track` the caption source at the current video position. Resolves
  // once the shard covering the current position has been loaded (or failed
  // explicitly); the returned generation lets the caller reject stale jobs.
  async switchTrack(track, reason = 'user-switch') {
    const generation = ++this.generation;
    this._teardown('replaced');
    const active = { track, generation, cache: new Map(), rendered: new Set(), ended: false, failed: new Set() };
    this.active = active;
    this.onEvent({ type: 'subtitle-track-active', trackId: track.id, language: track.language, role: track.role, reason, at: this._now() });
    await this._loadAround(active, this._now());
    if (generation !== this.generation) return { generation, stale: true };
    this._render(active);
    this._ensureTick();
    return { generation, stale: false };
  }

  // Subtitles off: clear what is on screen and go idle. Audio is unaffected.
  stop(reason = 'user-off') {
    this.generation++;
    this._teardown(reason);
  }

  // Re-evaluate immediately after a seek instead of waiting for the next tick.
  async refresh(reason = 'seek') {
    const active = this.active;
    if (!active) return;
    const time = this._now();
    const outside = time < active.track.timeline.startOffset || time >= active.track.timeline.end;
    if (outside || !this._shardAt(active.track, time)) {
      // A seek can land beyond this track's range even though it was live a
      // moment ago. Clear the overlay immediately and announce it; the kernel
      // turns this into the explicit unavailable notice.
      active.ended = true;
      this._paint([]);
      active.rendered = new Set();
      this.onEvent({ type: 'subtitle-uncovered', trackId: active.track.id, at: time,
        reason: outside ? 'outside-track-timeline' : 'no-declared-shard' });
      return;
    }
    active.ended = false;
    await this._loadAround(active, time);
    if (active !== this.active) return;
    this._render(active);
    this._ensureTick();
    this.onEvent({ type: 'subtitle-refresh', trackId: active.track.id, reason, at: this._now() });
  }

  _teardown(reason) {
    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.active) {
      this.onEvent({ type: 'subtitle-cleared', trackId: this.active.track.id, reason, at: this._now() });
      this.active = null;
    }
    this._paint([]);
  }

  _now() {
    return this.video?.currentTime ?? 0;
  }

  _shardAt(track, time) {
    return track.shards.find((s) => time >= s.start && time < s.start + s.duration) ?? null;
  }

  // Fetch the shard covering `time` (and prefetch the next one). Missing shard
  // declarations fail here too, so the kernel can announce them explicitly.
  async _loadAround(active, time) {
    const { track } = active;
    if (time < track.timeline.startOffset || time >= track.timeline.end) {
      if (!active.ended) {
        active.ended = true;
        this.onEvent({ type: 'subtitle-uncovered', trackId: track.id, at: time,
          reason: 'outside-track-timeline' });
      }
      return;
    }
    const shard = this._shardAt(track, time);
    if (!shard) {
      if (!active.ended) {
        active.ended = true;
        this.onEvent({ type: 'subtitle-uncovered', trackId: track.id, at: time, reason: 'no-declared-shard' });
      }
      return;
    }
    await this._prepare(active, shard);
    const next = track.shards.find((s) => s.index === shard.index + 1);
    if (next && active === this.active) await this._prepare(active, next);
  }

  async _prepare(active, shard) {
    const key = shard.index;
    const cached = active.cache.get(key);
    if (cached) return cached.promise;
    if (shard.missing) {
      const error = new Error('declared missing shard');
      const promise = Promise.reject(error);
      promise.catch(() => {}); // surfaced via the event below; avoid an unhandled rejection
      active.cache.set(key, { status: 'error', promise, cues: [] });
      active.failed.add(key);
      this.onEvent({ type: 'subtitle-shard-error', trackId: active.track.id, shardIndex: key, error: error.message });
      return;
    }
    const entry = { status: 'loading', promise: null, cues: [] };
    entry.promise = (async () => {
      let res;
      try {
        res = await this._fetch(shard.url);
      } catch (cause) {
        throw new Error(`network error: ${cause.message}`);
      }
      if (!res.ok) throw new Error(`subtitle shard ${shard.url} failed: ${res.status}`);
      const data = await res.json();
      if (!Array.isArray(data.cues)) throw new Error('subtitle shard has no cues array');
      return data.cues;
    })().then((cues) => {
      entry.status = 'ready';
      entry.cues = cues;
      return cues;
    }).catch((error) => {
      entry.status = 'error';
      active.failed.add(key);
      if (active === this.active) {
        this.onEvent({ type: 'subtitle-shard-error', trackId: active.track.id, shardIndex: key, error: error.message });
      }
      throw error;
    });
    active.cache.set(key, entry);
    try {
      await entry.promise;
    } catch {
      /* surfaced via event; callers continue with whatever other shards loaded */
    }
  }

  _ensureTick() {
    if (this.tickTimer || !this.active) return;
    const tick = async () => {
      this.tickTimer = null;
      const active = this.active;
      if (!active) return;
      try {
        const time = this._now();
        const crossed = this.lastTime !== null && Math.abs(time - this.lastTime) > 1.5;
        this.lastTime = time;
        if (crossed) await this._loadAround(active, time);
        else if (time >= active.track.timeline.startOffset && time < active.track.timeline.end) {
          // Keep the upcoming shard warm while the playhead advances normally.
          const shard = this._shardAt(active.track, time);
          const next = shard && active.track.shards.find((s) => s.index === shard.index + 1);
          if (next) await this._prepare(active, next);
        }
        if (active !== this.active) return;
        this._render(active);
      } catch (err) {
        this.onEvent({ type: 'subtitle-engine-error', error: err.message });
      }
      if (this.active) this.tickTimer = setTimeout(tick, TICK_MS);
    };
    this.tickTimer = setTimeout(tick, TICK_MS);
  }

  // Compute the cues active at the current program time from every loaded
  // shard, deduping cue objects duplicated across a shard boundary. Identity
  // is the object itself: two distinct cues may legitimately share a start.
  _render(active) {
    const time = this._now();
    const seen = new Set();
    const cues = [];
    for (const entry of active.cache.values()) {
      if (entry.status !== 'ready') continue;
      for (const cue of entry.cues) {
        if (time >= cue.start && time < cue.end && !seen.has(cue)) {
          seen.add(cue);
          cues.push(cue);
        }
      }
    }
    cues.sort((a, b) => a.start - b.start);
    const keys = new Set(cues.map((c) => `${c.start}|${c.text}`));
    const changed = keys.size !== active.rendered.size
      || [...keys].some((k) => !active.rendered.has(k));
    active.rendered = keys;
    if (changed) {
      this._paint(cues);
      this.onEvent({ type: 'subtitle-cue', trackId: active.track.id, at: time,
        texts: cues.map((c) => c.text) });
    }
    const pastEnd = time >= active.track.timeline.end;
    if (pastEnd && !active.ended) {
      active.ended = true;
      this.onEvent({ type: 'subtitle-ended', trackId: active.track.id, at: time, end: active.track.timeline.end });
    }
  }

  _paint(cues) {
    if (!this.overlay) return;
    this.overlay.textContent = '';
    for (const cue of cues) {
      const line = document.createElement('div');
      line.className = 'subtitle-line';
      line.textContent = cue.text;
      this.overlay.appendChild(line);
    }
  }

  snapshot() {
    const out = {};
    const active = this.active;
    if (!active) return out;
    for (const [index, entry] of active.cache) {
      out[`${active.track.id}#${index}`] = { status: entry.status, error: entry.status === 'error' ? 'load failed' : null };
    }
    return out;
  }

  get status() {
    const active = this.active;
    return {
      activeTrackId: active?.track.id ?? null,
      role: active?.track.role ?? null,
      ended: active?.ended ?? false,
      renderedCues: active ? [...active.rendered] : [],
      loadedShards: active ? [...active.cache.entries()].filter(([, e]) => e.status === 'ready').map(([i]) => i) : [],
      failedShards: active ? [...active.failed] : [],
      overlayText: this.overlay ? this.overlay.textContent.trim() : '',
      generation: this.generation,
    };
  }
}
