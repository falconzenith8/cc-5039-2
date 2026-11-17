// Sample-accurate shard scheduler on the Web Audio graph.
//
// The <video> element is the single master clock. Every audio shard is placed
// on that timeline with its manifest-declared start offset:
//
//   audioContextTimeOf(programTime t) =
//       audioCtx.currentTime + (t - video.currentTime)
//
// so a newly selected track never restarts from zero — it joins at the same
// program position the video is already showing. At most one AudioBufferSource
// is ever audible: switching stops the outgoing set before starting the
// incoming one, inside one synchronous tick.

const RESYNC_THRESHOLD = 0.12;   // |measured A/V delta| before a reschedule
const RESYNC_GRACE = 0.6;        // ignore drift on sources younger than this (seek settle)
const LEAD_TIME = 0.25;          // schedule this far ahead of the playhead
const MAX_SLEEP_MS = 250;

export class AudioScheduler {
  constructor({ audioCtx, loader, getVideoTime, getPlaying, onEvent }) {
    this.ctx = audioCtx;
    this.loader = loader;
    this.getVideoTime = getVideoTime;
    this.getPlaying = getPlaying;
    this.onEvent = onEvent ?? (() => {});
    // Public tap for diagnostics/tests: sources connect through this gain.
    this.output = audioCtx.createGain();
    this.output.gain.value = 1;
    this.output.connect(audioCtx.destination);
    this.analyser = audioCtx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.output.connect(this.analyser);
    this.active = null;            // { trackId, shards, sources: Map, generation }
    this.generation = 0;
    this.tickTimer = null;
    this.driftSamples = [];        // recent measured A/V deltas
    this.coverageGaps = new Set(); // shard starts currently uncovered, for the UI
  }
  // Swap the audible track at the current program position.
  // `track` is the track that will actually sound; callers have already applied
  // fallback policy. Preparation of the first decodable shard is awaited before
  // any graph change, so the switch can never expose two simultaneous tracks.
  async switchTrack(track, reason) {
    // Atomically supersede whatever is audible. Bumping the generation first
    // means any in-flight switch (still awaiting decode) becomes stale and can
    // never land its active set on top of a newer selection.
    const generation = ++this.generation;
    this._stopActive('replaced');
    this.coverageGaps.clear();
    this.driftSamples = []; // a new track/position starts from a clean drift baseline
    const first = this._shardAtOrAfter(track, this.getVideoTime());
    if (!first) {
      this.onEvent({ type: 'track-uncovered', trackId: track.id, at: this.getVideoTime() });
      return null;
    }
    // Prepare first while no track is active: an undecodable target must fail
    // before anything new becomes audible, and the old track was already stopped.
    await this.loader.prepare(track.id, first.shard);
    if (generation !== this.generation) return null; // a newer switch/stop won
    const active = { trackId: track.id, shards: track.shards, sources: new Map(), failed: new Set(), generation };
    this.active = active;
    this.onEvent({ type: 'track-audible', trackId: track.id, reason, at: this.getVideoTime() });
    // Schedule the first shard immediately rather than waiting up to
    // MAX_SLEEP_MS for the first tick — after a seek this avoids an audible gap
    // while the playhead is already advancing through the new position.
    await this._scheduleShard(active, first.shard, this.getVideoTime());
    this._ensureTick();
    return track;
  }

  stop(reason = 'stopped') {
    this.generation++;
    this._stopActive(reason);
    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
      this.tickTimer = null;
    }
  }

  _stopActive(reason) {
    if (!this.active) return;
    for (const entry of this.active.sources.values()) {
      try { entry.src.onended = null; entry.src.stop(); } catch { /* already stopped */ }
    }
    this.onEvent({ type: 'track-silenced', trackId: this.active.trackId, reason });
    this.active = null;
    this.coverageGaps.clear();
  }

  _shardAtOrAfter(track, time) {
    const { startOffset, end } = track.timeline;
    if (time >= end || time < startOffset - 0.001) return null;
    const shard = track.shards
      .filter((s) => s.start + s.duration > time)
      .sort((a, b) => a.start - b.start)[0];
    return shard ? { shard } : null;
  }

  _ensureTick() {
    if (this.tickTimer) return;
    const tick = () => {
      this.tickTimer = null;
      if (!this.active) return;
      try {
        this._tick();
      } catch (err) {
        this.onEvent({ type: 'scheduler-error', error: err.message });
      }
      if (this.active) {
        this.tickTimer = setTimeout(tick, MAX_SLEEP_MS);
      }
    };
    this.tickTimer = setTimeout(tick, 0);
  }

  async _tick() {
    const active = this.active;
    if (!active) return;
    const now = this.ctx.currentTime;
    const videoTime = this.getVideoTime();
    // Drift is meaningful only while actually sounding.
    if (this.getPlaying()) this._measureDrift(active, now, videoTime);
    // Prefetch/decode work runs regardless of instantaneous playing state so a
    // transient clock stall under load cannot defer failure detection or leave
    // an about-to-be-needed shard undecoded.
    const horizon = (this.getPlaying() ? videoTime : this._lastVideoTime ?? videoTime)
      + LEAD_TIME + MAX_SLEEP_MS / 1000;
    this._lastVideoTime = videoTime;
    // Every shard overlapping [now, horizon) that is neither playing nor already
    // known-bad is considered. Including the currently-playing shard means a
    // missing/failed shard is detected the moment playback reaches it even if
    // preparation lost the race with the playhead, instead of being skipped.
    const due = active.shards
      .filter((s) => s.start < horizon && s.start + s.duration > videoTime)
      .filter((s) => !active.sources.has(s.index) && !active.failed.has(s.index));

    for (const shard of due) {
      // A shard-gap may trigger a declared fallback, which bumps the
      // generation: stop scheduling the superseded track immediately so two
      // languages can never become audible together.
      if (active.generation !== this.generation || active !== this.active) return;
      await this._scheduleShard(active, shard, videoTime);
    }
    if (active === this.active) await this._prefetchNext(active, videoTime);
  }

  // Decode upcoming shards well ahead of time. A missing/failing shard is
  // therefore discovered before playback reaches it, so the fallback decision
  // is deterministic rather than racing the playhead.
  async _prefetchNext(active, videoTime) {
    const PREFETCH_AHEAD = 2; // shards
    const upcoming = active.shards
      .filter((s) => s.start >= videoTime && !active.failed.has(s.index) && !active.sources.has(s.index))
      .sort((a, b) => a.start - b.start)
      .slice(0, PREFETCH_AHEAD);
    for (const next of upcoming) {
      if (active !== this.active) return;
      try {
        await this.loader.prepare(active.trackId, next);
      } catch (error) {
        if (active !== this.active || active.failed.has(next.index)) return;
        active.failed.add(next.index);
        this.coverageGaps.add(next.start);
        this.onEvent({ type: 'shard-gap', trackId: active.trackId, shardIndex: next.index, error: error.message });
        return;
      }
    }
  }

  async _scheduleShard(active, shard, videoTime) {
    const key = shard.index;
    let buffer;
    try {
      buffer = await this.loader.prepare(active.trackId, shard);
    } catch (error) {
      if (active !== this.active) return;
      active.failed.add(shard.index);
      this.coverageGaps.add(shard.start);
      this.onEvent({ type: 'shard-gap', trackId: active.trackId, shardIndex: shard.index, error: error.message });
      return; // explicit gap: silence here, never another language behind the UI's back
    }
    if (active !== this.active || active.sources.has(key)) return;

    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    const gain = this.ctx.createGain();
    gain.gain.value = 1;
    src.connect(gain).connect(this.output);

    // Clock mapping. The video is master: program time `p` corresponds to
    //   ctxTime(p) = audioCtx.currentTime + (p - video.currentTime)
    // After a seek the video clock can jump while the audio clock cannot, so
    // ctxTime(shard.start) may already be in the past. Then start the source NOW
    // and skip the elapsed head via a buffer offset — never clamp a future-program
    // shard to start now (it would render the wrong material and end instantly).
    const videoNow = this.getVideoTime();
    const idealCtxTime = this.ctx.currentTime + (shard.start - videoNow);
    const offsetIntoBuffer = Math.max(0, videoNow - shard.start);
    const startInPast = idealCtxTime <= this.ctx.currentTime;
    const startTime = startInPast ? this.ctx.currentTime : idealCtxTime;
    src.start(startTime, offsetIntoBuffer);
    active.sources.set(key, {
      src,
      startTime,
      // Program time this source renders at `startTime` (includes any head skip).
      programAnchor: shard.start + offsetIntoBuffer,
      bornAt: this.ctx.currentTime,
    });
    this.coverageGaps.delete(shard.start);
    src.onended = () => {
      if (this.active === active) active.sources.delete(key);
    };
    const avDeltaAtSchedule = startInPast ? 0 : startTime - idealCtxTime;
    this._recordDrift(avDeltaAtSchedule);
    this.onEvent({
      type: 'shard-scheduled',
      trackId: active.trackId,
      shardIndex: key,
      ctxTime: startTime,
      bufferOffset: offsetIntoBuffer,
      avDeltaAtSchedule,
    });
  }

  _recordDrift(delta) {
    if (!Number.isFinite(delta)) return;
    this.driftSamples.push(delta);
    if (this.driftSamples.length > 24) this.driftSamples.shift();
    if (Math.abs(delta) > RESYNC_THRESHOLD && this.active) {
      this.onEvent({ type: 'resync', trackId: this.active.trackId, delta });
      this._reschedule(this.active);
    }
  }

  // Real A/V delta during playback. For a live source started at context time
  // `startTime`, the program time it is rendering right now is:
  //   programAnchor + (audioCtx.currentTime - startTime)
  // while the master clock renders `videoTime`. Their difference is the actual
  // audible A/V offset, independent of when the source was scheduled.
  _measureDrift(active, now, videoTime) {
    for (const entry of active.sources.values()) {
      // Grace period after a (re)build: the video clock can still be settling
      // after a seek, so a freshly created source must not be torn out as
      // "out of sync" before it has had a chance to play.
      if (now - entry.bornAt < RESYNC_GRACE) continue;
      const audioProgramTime = entry.programAnchor + (now - entry.startTime);
      const delta = audioProgramTime - videoTime; // >0 audio ahead, <0 behind
      this._recordDrift(delta);
    }
  }

  _reschedule(active) {
    for (const entry of active.sources.values()) {
      try { entry.src.onended = null; entry.src.stop(); } catch { /* noop */ }
    }
    active.sources.clear();
  }

  get status() {
    const drift = this.driftSamples;
    const avg = drift.length ? drift.reduce((a, b) => a + b, 0) / drift.length : 0;
    const peak = drift.length ? Math.max(...drift.map(Math.abs)) : 0;
    // Median over the recent window: steady-state sync quality. Peak can spike
    // once at a seek/switch boundary and must not be mistaken for steady drift.
    const sorted = drift.length ? [...drift].map(Math.abs).sort((a, b) => a - b) : [0];
    const median = sorted[Math.floor(sorted.length / 2)];
    return {
      activeTrackId: this.active?.trackId ?? null,
      scheduledShards: this.active ? [...this.active.sources.keys()] : [],
      coverageGaps: [...this.coverageGaps],
      drift: {
        avgMs: Math.round(avg * 1000),
        peakMs: Math.round(peak * 1000),
        medianMs: Math.round(median * 1000),
        samples: drift.length,
      },
    };
  }
}
