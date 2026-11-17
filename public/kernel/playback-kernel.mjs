// PlaybackKernel: facade that ties manifest rules, the MSE video engine, the
// shard loader and the sample-accurate audio scheduler together.
//
// The distinction the UI must always be able to show:
//   selectedTrack  — what the user asked to hear
//   effectiveTrack — what is actually scheduled (may differ only via an
//                    explicit, announced fallback; never silently)
//
// Switching is position-preserving: video keeps its currentTime, the new audio
// track is prepared while the old one stays audible, and the graph swap is a
// single synchronous stop/start with no overlap.

import { parseManifest, selectDefaultTrack, resolveFallback, coverageAt } from './manifest.mjs';
import { ShardLoader } from './shard-loader.mjs';
import { AudioScheduler } from './audio-scheduler.mjs';
import { VideoEngine } from './video-engine.mjs';

// Exposed for diagnostics/tests that need the pure manifest rules without a
// second dynamic import path.
export { parseManifest, selectDefaultTrack, resolveFallback, coverageAt };

export class PlaybackKernel {
  constructor({ video, audioCtx, fetchImpl, onEvent } = {}) {
    this.video = video;
    this.audioCtx = audioCtx;
    this.fetch = fetchImpl ? fetchImpl.bind(globalThis) : globalThis.fetch.bind(globalThis);
    this.emit = onEvent ?? (() => {});
    this.manifest = null;
    this.loader = new ShardLoader({
      fetchImpl: this.fetch,
      decode: (bytes) => this.audioCtx.decodeAudioData(bytes),
    });
    this.videoEngine = null;
    this.scheduler = new AudioScheduler({
      audioCtx: this.audioCtx,
      loader: this.loader,
      getVideoTime: () => this.videoEngine?.currentTime ?? 0,
      getPlaying: () => this.videoEngine?.playing ?? false,
      onEvent: (e) => this._handleSchedulerEvent(e),
    });
    this.selectedTrack = null;
    this.effectiveTrack = null;
    this.statusReason = '';
    this._switchChain = Promise.resolve(); // serializes audible-track changes
    this.log = [];
  }

  // Flat FIFO serialization. Jobs must NEVER call _enqueueSwitch while running
  // (that would deadlock): internal callers invoke their logic directly, and
  // only outer entry points (play/seek/selectTrack/gap handling) enqueue.
  _enqueueSwitch(job) {
    const run = this._switchChain.then(() => job());
    // Keep the chain alive even if one job rejects; surface the failure as an event.
    this._switchChain = run.catch((error) => this._record({ type: 'switch-error', error: error.message }));
    return run;
  }

  async load(url) {
    const res = await this.fetch(url);
    if (!res.ok) throw new Error(`manifest fetch failed: ${res.status}`);
    this.manifest = parseManifest(await res.json());
    this.videoEngine = new VideoEngine({
      video: this.video,
      manifest: this.manifest,
      fetchImpl: this.fetch,
      onEvent: (e) => this._record(e),
    });
    await this.videoEngine.init();
    // The manifest's own default rule is authoritative. The browser locale is
    // only consulted when the manifest declares no defaultLanguage — otherwise
    // an ambient en-US browser could silently override the program's rule.
    const { track, reason } = selectDefaultTrack(this.manifest, this.manifest.selectionRules?.defaultLanguage ? null : this._preferredLanguage());
    this._record({ type: 'default-selected', trackId: track.id, language: track.language, reason });
    this.selectedTrack = track;
    this.effectiveTrack = track;
    this.statusReason = reason;
    return this.describe();
  }

  _preferredLanguage() {
    return globalThis.navigator?.language ?? null;
  }

  get tracks() {
    return this.manifest.audioTracks.map((track) => ({
      id: track.id,
      language: track.language,
      label: track.label,
      role: track.role,
      timeline: track.timeline,
      coverage: coverageAt(track, this.videoEngine.currentTime),
    }));
  }

  async play() {
    if (this.audioCtx.state === 'suspended') await this.audioCtx.resume();
    await this._enqueueSwitch(() => this.scheduler.switchTrack(this.effectiveTrack, 'initial-play'));
    await this.videoEngine.play();
    this._record({ type: 'play', at: this.videoEngine.currentTime });
  }

  pause() {
    this.videoEngine.pause();
    this.scheduler.stop('user-pause');
    this._record({ type: 'pause', at: this.videoEngine.currentTime });
  }

  async seek(time) {
    // Capture intent before seeking: during the seek the element briefly
    // reports paused/seeking, so reading .playing after the assignment would
    // wrongly skip rebuilding audio and leave ~2s of silence.
    const wasPlaying = this.videoEngine.playing;
    this.videoEngine.seek(time);
    if (wasPlaying && this.effectiveTrack) {
      // video.currentTime updates synchronously; rebuild the shard for the new
      // position now. switchTrack atomically supersedes the prior audible set.
      await this.scheduler.switchTrack(this.effectiveTrack, 'seek');
    }
    this._record({ type: 'seek', time });
  }

  // User-driven language switch. Position never changes; the new track is
  // prepared before the old one is silenced. Runs on the serialized switch
  // chain so it cannot interleave with play()/seek()/fallback switches.
  selectTrack(trackId) {
    const target = this.manifest.audioTracks.find((t) => t.id === trackId);
    if (!target) throw new Error(`unknown track ${trackId}`);
    return this._enqueueSwitch(() => this._resolveAndSwitch(target));
  }

  async _resolveAndSwitch(target) {
    this.selectedTrack = target;
    this._record({ type: 'track-requested', trackId: target.id, language: target.language, at: this.videoEngine.currentTime });

    const time = this.videoEngine.currentTime;
    const coverage = coverageAt(target, time);
    if (!coverage.covered) {
      return this._applyFallback(target, `selected track does not cover t=${time.toFixed(2)}s (${coverage.reason})`);
    }
    try {
      await this.loader.prepare(target.id, coverage.shard);
      this.effectiveTrack = target;
      this.statusReason = 'user selection';
      if (this.videoEngine.playing) await this.scheduler.switchTrack(target, 'user-switch');
      this._record({ type: 'track-confirmed', trackId: target.id, at: time });
      return this.describe();
    } catch (error) {
      return this._applyFallback(target, error.message);
    }
  }

  // Explicit fallback: the selected language stays visibly selected, while the
  // status line announces which language actually sounds and why.
  async _applyFallback(requested, reason) {
    const fallback = resolveFallback(this.manifest, requested.language);
    this._record({ type: 'fallback-needed', requested: requested.language, reason, fallback: fallback?.language ?? null });
    if (!fallback) {
      this.effectiveTrack = null;
      this.statusReason = `no usable audio: ${reason}`;
      this.scheduler.stop('no-fallback');
      return this.describe();
    }
    const coverage = coverageAt(fallback, this.videoEngine.currentTime);
    if (!coverage.covered) {
      this.effectiveTrack = null;
      this.statusReason = `fallback ${fallback.language} also unavailable here (${coverage.reason})`;
      this.scheduler.stop('fallback-uncovered');
      return this.describe();
    }
    try {
      await this.loader.prepare(fallback.id, coverage.shard);
    } catch (error) {
      this.effectiveTrack = null;
      this.statusReason = `fallback ${fallback.language} failed to decode: ${error.message}`;
      this.scheduler.stop('fallback-failed');
      return this.describe();
    }
    this.effectiveTrack = fallback;
    this.statusReason = `fallback to ${fallback.language}: ${reason}`;
    if (this.videoEngine.playing) await this.scheduler.switchTrack(fallback, 'declared-fallback');
    this._record({ type: 'fallback-active', requested: requested.language, effective: fallback.language, reason });
    return this.describe();
  }

  _handleSchedulerEvent(event) {
    if (event.type === 'shard-gap') {
      // A mid-playback shard failed: keep the selected language on screen, but
      // announce the gap and apply the declared fallback rather than silently
      // continuing with stale audio while still labeling the new language.
      // Enqueued so it cannot race an in-flight user switch.
      this._enqueueSwitch(() => this._applyFallback(this.selectedTrack, event.error));
    }
    this._record(event);
  }

  _record(event) {
    const entry = { ...event, t: Number(this.videoEngine?.currentTime?.toFixed(3) ?? 0), wall: Date.now() };
    this.log.push(entry);
    if (this.log.length > 300) this.log.shift();
    this.emit(entry);
  }

  describe() {
    return {
      program: { id: this.manifest.programId, title: this.manifest.title, duration: this.manifest.duration },
      selected: this.selectedTrack && {
        id: this.selectedTrack.id, language: this.selectedTrack.language, label: this.selectedTrack.label,
      },
      effective: this.effectiveTrack && {
        id: this.effectiveTrack.id, language: this.effectiveTrack.language, label: this.effectiveTrack.label,
      },
      statusReason: this.statusReason,
      position: this.videoEngine.currentTime,
      playing: this.videoEngine.playing,
      scheduler: this.scheduler.status,
      loader: this.loader.snapshot(),
      videoBuffered: this.videoEngine.bufferedRanges(),
      tracks: this.tracks,
    };
  }
}
