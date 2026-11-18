// PlaybackKernel: facade that ties manifest rules, the MSE video engine, the
// shard loader, the sample-accurate audio scheduler and the cue-driven
// subtitle engine together.
//
// The distinction the UI must always be able to show:
//   selectedTrack / selectedSubtitle — what the user asked for
//   effectiveTrack / effectiveSubtitle — what is actually scheduled (may
//       differ only via an explicit, announced fallback; never silently)
//
// Switching is position-preserving: video keeps its currentTime, the new audio
// track is prepared while the old one stays audible, and the graph swap is a
// single synchronous stop/start with no overlap.
//
// A combination switch carries a single version token. Every async result is
// re-checked against the latest version before it can mutate state, so rapid
// consecutive requests can never leave the UI with one request's audio and
// another request's subtitles.

import {
  parseManifest, selectDefaultTrack, resolveFallback, coverageAt, checkCombination,
} from './manifest.mjs';
import { ShardLoader } from './shard-loader.mjs';
import { AudioScheduler } from './audio-scheduler.mjs';
import { VideoEngine } from './video-engine.mjs';
import { SubtitleEngine } from './subtitle-engine.mjs';

// Exposed for diagnostics/tests that need the pure manifest rules without a
// second dynamic import path.
export { parseManifest, selectDefaultTrack, resolveFallback, coverageAt, checkCombination };

export class PlaybackKernel {
  constructor({ video, audioCtx, fetchImpl, onEvent, subtitleOverlay } = {}) {
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
    this.subtitleEngine = new SubtitleEngine({
      video,
      fetchImpl: this.fetch,
      overlay: subtitleOverlay ?? null,
      onEvent: (e) => this._handleSubtitleEvent(e),
    });
    this.selectedTrack = null;
    this.effectiveTrack = null;
    this.selectedSubtitle = null; // user's choice; null means subtitles off
    this.effectiveSubtitle = null;
    this.comboVersion = 0;       // bumped on every requested combination change
    this.statusReason = '';
    this.lastNotice = null;      // { kind, message, at } explicit UI feedback
    this._switchChain = Promise.resolve(); // serializes audible-track changes
    this.log = [];
  }

  // Flat FIFO serialization. Jobs must NEVER call _enqueueSwitch while running
  // (that would deadlock): internal callers invoke their logic directly, and
  // only outer entry points (play/seek/selectTrack/selectCombination/gap
  // handling) enqueue.
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
    // Captions start off; a selected control is never assumed loaded.
    this.selectedSubtitle = null;
    this.effectiveSubtitle = null;
    this.statusReason = reason;
    return this.describe();
  }

  _preferredLanguage() {
    return globalThis.navigator?.language ?? null;
  }

  _trackView(track) {
    return {
      id: track.id,
      kind: track.kind,
      language: track.language,
      label: track.label,
      role: track.role,
      timeline: track.timeline,
      coverage: coverageAt(track, this.videoEngine.currentTime),
    };
  }

  get tracks() {
    return this.manifest.audioTracks.map((track) => this._trackView(track));
  }

  get subtitleTracks() {
    return this.manifest.subtitleTracks.map((track) => this._trackView(track));
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
    // Captions follow the video clock directly: re-evaluate at the new
    // position. A seek never resets captions to their first cue, but a seek
    // beyond their timeline clears them with an explicit notice.
    if (this.effectiveSubtitle) {
      const coverage = coverageAt(this.effectiveSubtitle, time);
      if (!coverage.covered) {
        this.effectiveSubtitle = null;
        this.subtitleEngine.stop('seek-outside-timeline');
        this.lastNotice = {
          kind: 'subtitle-unavailable',
          message: `字幕 ${this.selectedSubtitle?.label ?? ''} 在 t=${time.toFixed(2)}s 不可用（${coverage.reason}）`,
          at: time,
        };
        this._record({ type: 'subtitle-unavailable', trackId: this.selectedSubtitle?.id ?? null, reason: coverage.reason, at: time });
      } else {
        await this.subtitleEngine.refresh('seek');
      }
    }
    this._record({ type: 'seek', time });
  }

  // User-driven audio-only switch. Original behavior preserved: subtitles are
  // not part of this request and stay exactly where they are.
  selectTrack(trackId) {
    const target = this.manifest.audioTracks.find((t) => t.id === trackId);
    if (!target) throw new Error(`unknown track ${trackId}`);
    return this._enqueueSwitch(() => this._resolveAndSwitch(target));
  }

  // Combination switch: audio track + subtitle track (null = off).
  // Rejected combinations never mutate any state; accepted ones commit under a
  // single version token that both engines validate against.
  selectCombination({ audioId, subtitleId }) {
    const audio = this.manifest.audioTracks.find((t) => t.id === audioId);
    if (!audio) throw new Error(`unknown audio track ${audioId}`);
    const subtitle = subtitleId
      ? this.manifest.subtitleTracks.find((t) => t.id === subtitleId) ?? null
      : null;
    if (subtitleId && !subtitle) throw new Error(`unknown subtitle track ${subtitleId}`);

    const policy = checkCombination(this.manifest, audio, subtitle);
    if (!policy.allowed) {
      this.lastNotice = { kind: 'combination-rejected', message: policy.reason, at: this.videoEngine.currentTime };
      this._record({
        type: 'combination-rejected',
        audioId: audio.id, audioRole: audio.role,
        subtitleId: subtitle?.id ?? null, subtitleRole: subtitle?.role ?? null,
        reason: policy.reason,
      });
      return Promise.resolve({ ...this.describe(), accepted: false, reason: policy.reason });
    }
    const version = ++this.comboVersion;
    this._record({
      type: 'combination-requested', version,
      audioId: audio.id, subtitleId: subtitle?.id ?? null, at: this.videoEngine.currentTime,
    });
    return this._enqueueSwitch(() => this._applyCombination(audio, subtitle, version));
  }

  async _applyCombination(audio, subtitle, version) {
    this.selectedTrack = audio;
    this.selectedSubtitle = subtitle;
    const stale = () => version !== this.comboVersion;
    const time = this.videoEngine.currentTime;

    const coverage = coverageAt(audio, time);
    if (!coverage.covered) {
      if (stale()) return this.describe();
      await this._applyFallback(audio, `selected track does not cover t=${time.toFixed(2)}s (${coverage.reason})`);
    } else {
      try {
        await this.loader.prepare(audio.id, coverage.shard);
        if (stale()) return this.describe();
        this.effectiveTrack = audio;
        this.statusReason = 'user combination selection';
        if (this.videoEngine.playing) await this.scheduler.switchTrack(audio, 'combo-switch');
        this._record({ type: 'track-confirmed', version, trackId: audio.id, at: time });
      } catch (error) {
        if (stale()) return this.describe();
        await this._applyFallback(audio, error.message);
      }
    }
    if (stale()) return this.describe();

    // Subtitle leg of the same confirmed version.
    if (!subtitle) {
      // Turning captions off clears the overlay only; audio is untouched.
      this.effectiveSubtitle = null;
      this.subtitleEngine.stop('combination-off');
      this.lastNotice = null;
    } else {
      const subCoverage = coverageAt(subtitle, time);
      if (!subCoverage.covered) {
        // Explicit, visible failure: clear any previous captions, keep audio.
        this.effectiveSubtitle = null;
        this.subtitleEngine.stop('subtitle-uncovered');
        this.lastNotice = {
          kind: 'subtitle-unavailable',
          message: `字幕 ${subtitle.label} 在 t=${time.toFixed(2)}s 不可用（${subCoverage.reason}）`,
          at: time,
        };
        this._record({ type: 'subtitle-unavailable', version, trackId: subtitle.id, reason: subCoverage.reason, at: time });
      } else {
        const result = await this.subtitleEngine.switchTrack(subtitle, 'combo-switch');
        if (stale()) return this.describe();
        if (!result.stale) {
          this.effectiveSubtitle = subtitle;
          this.lastNotice = null;
          this._record({ type: 'subtitle-confirmed', version, trackId: subtitle.id, at: time });
        }
      }
    }
    return { ...this.describe(), accepted: true, version };
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
      this.lastNotice = { kind: 'audio-unavailable', message: this.statusReason, at: this.videoEngine.currentTime };
      this.scheduler.stop('no-fallback');
      return this.describe();
    }
    const coverage = coverageAt(fallback, this.videoEngine.currentTime);
    if (!coverage.covered) {
      this.effectiveTrack = null;
      this.statusReason = `fallback ${fallback.language} also unavailable here (${coverage.reason})`;
      this.lastNotice = { kind: 'audio-unavailable', message: this.statusReason, at: this.videoEngine.currentTime };
      this.scheduler.stop('fallback-uncovered');
      return this.describe();
    }
    try {
      await this.loader.prepare(fallback.id, coverage.shard);
    } catch (error) {
      this.effectiveTrack = null;
      this.statusReason = `fallback ${fallback.language} failed to decode: ${error.message}`;
      this.lastNotice = { kind: 'audio-unavailable', message: this.statusReason, at: this.videoEngine.currentTime };
      this.scheduler.stop('fallback-failed');
      return this.describe();
    }
    this.effectiveTrack = fallback;
    this.statusReason = `fallback to ${fallback.language}: ${reason}`;
    this.lastNotice = { kind: 'audio-fallback', message: this.statusReason, at: this.videoEngine.currentTime };
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

  _handleSubtitleEvent(event) {
    // Natural end-of-timeline while playing (or a shard hole discovered by the
    // ticker): the selection stays visibly selected, but nothing is effective
    // and the notice explains why. Distinct from an explicit off request.
    if ((event.type === 'subtitle-ended' || event.type === 'subtitle-uncovered')
      && this.effectiveSubtitle?.id === event.trackId) {
      const label = this.selectedSubtitle?.label ?? event.trackId;
      this.effectiveSubtitle = null;
      this.lastNotice = {
        kind: 'subtitle-unavailable',
        message: `字幕 ${label} 在 t=${(event.at ?? this.videoEngine.currentTime).toFixed(2)}s 结束（${event.reason ?? 'track-ended'}）`,
        at: event.at ?? this.videoEngine.currentTime,
      };
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
        id: this.selectedTrack.id, language: this.selectedTrack.language, label: this.selectedTrack.label, role: this.selectedTrack.role,
      },
      effective: this.effectiveTrack && {
        id: this.effectiveTrack.id, language: this.effectiveTrack.language, label: this.effectiveTrack.label, role: this.effectiveTrack.role,
      },
      selectedSubtitle: this.selectedSubtitle && {
        id: this.selectedSubtitle.id, language: this.selectedSubtitle.language, label: this.selectedSubtitle.label, role: this.selectedSubtitle.role,
      },
      effectiveSubtitle: this.effectiveSubtitle && {
        id: this.effectiveSubtitle.id, language: this.effectiveSubtitle.language, label: this.effectiveSubtitle.label, role: this.effectiveSubtitle.role,
      },
      comboVersion: this.comboVersion,
      statusReason: this.statusReason,
      lastNotice: this.lastNotice,
      position: this.videoEngine.currentTime,
      playing: this.videoEngine.playing,
      scheduler: this.scheduler.status,
      subtitles: this.subtitleEngine.status,
      loader: this.loader.snapshot(),
      videoBuffered: this.videoEngine.bufferedRanges(),
      tracks: this.tracks,
      subtitleTracks: this.subtitleTracks,
    };
  }
}
