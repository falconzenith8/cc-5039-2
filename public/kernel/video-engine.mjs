// MSE video engine: feeds the manifest's init segment and numbered fMP4 shards
// into a SourceBuffer in program order. The video element is the master clock;
// language switching never touches this engine, so the picture position is
// preserved across audio-track changes.

export class VideoEngine {
  constructor({ video, manifest, fetchImpl, onEvent }) {
    this.video = video;
    this.manifest = manifest;
    this.fetch = fetchImpl ? fetchImpl.bind(globalThis) : globalThis.fetch.bind(globalThis);
    this.onEvent = onEvent ?? (() => {});
    this.mediaSource = null;
    this.sourceBuffer = null;
    this.queue = [];
    this.started = false;
    this.bufferedShardIndexes = new Set();
  }

  async init() {
    if (!('MediaSource' in globalThis)) throw new Error('MSE unsupported');
    const mime = 'video/mp4; codecs="avc1.64001e"';
    if (!MediaSource.isTypeSupported(mime)) throw new Error(`MIME unsupported: ${mime}`);
    this.mediaSource = new MediaSource();
    this.video.src = URL.createObjectURL(this.mediaSource);
    await new Promise((resolve, reject) => {
      this.mediaSource.addEventListener('sourceopen', resolve, { once: true });
      this.mediaSource.addEventListener('sourceopenerror', reject, { once: true });
    });
    this.sourceBuffer = this.mediaSource.addSourceBuffer(mime);
    this.sourceBuffer.mode = 'sequence';
    this.sourceBuffer.addEventListener('updateend', () => this._pump());

    const initRes = await this.fetch(this.manifest.video.initUrl);
    if (!initRes.ok) throw new Error(`init segment failed: ${initRes.status}`);
    this.queue.push(await initRes.arrayBuffer());
    for (const shard of this.manifest.video.shards) {
      const res = await this.fetch(shard.url);
      if (!res.ok) throw new Error(`video shard ${shard.index} failed: ${res.status}`);
      this.queue.push({ shard, bytes: await res.arrayBuffer() });
    }
    this._pump();
  }

  _pump() {
    if (!this.sourceBuffer || this.sourceBuffer.updating || this.queue.length === 0) return;
    const item = this.queue.shift();
    const bytes = item instanceof ArrayBuffer ? item : item.bytes;
    this.sourceBuffer.appendBuffer(bytes);
    if (!(item instanceof ArrayBuffer)) {
      this.bufferedShardIndexes.add(item.shard.index);
      this.onEvent({ type: 'video-shard-buffered', shardIndex: item.shard.index });
    } else {
      this.onEvent({ type: 'video-init-buffered' });
    }
  }

  async play() {
    if (!this.started) {
      this.started = true;
      await this._waitForBuffered(0.1);
    }
    await this.video.play();
  }

  pause() {
    this.video.pause();
  }

  seek(time) {
    this.video.currentTime = time;
  }

  get currentTime() {
    return this.video.currentTime;
  }

  get playing() {
    return !this.video.paused && !this.video.ended && this.video.readyState >= 3;
  }

  bufferedRanges() {
    const ranges = this.video.buffered;
    const out = [];
    for (let i = 0; i < ranges.length; i++) {
      out.push({ start: ranges.start(i), end: ranges.end(i) });
    }
    return out;
  }

  _waitForBuffered(seconds) {
    return new Promise((resolve) => {
      const check = () => {
        if (this.video.buffered.length && this.video.buffered.end(0) >= seconds) return resolve();
        this.video.addEventListener('progress', check, { once: true });
        setTimeout(check, 50);
      };
      check();
    });
  }
}
