// Fetches and decodes media shards. Each shard is an independent byte range /
// standalone WAV file; decoded AudioBuffers are cached per (trackId, index).
// A failure is recorded as a terminal error state, never silently retried as
// another language — fallback policy lives one layer up and is always visible.

export class ShardLoadError extends Error {
  constructor(url, status, message) {
    super(message ?? `shard load failed: ${url} (${status ?? 'network'})`);
    this.name = 'ShardLoadError';
    this.url = url;
    this.status = status;
  }
}

export class ShardLoader {
  constructor({ fetchImpl, decode } = {}) {
    this._fetch = fetchImpl ? fetchImpl.bind(globalThis) : globalThis.fetch.bind(globalThis);
    this._decode = decode; // (arrayBuffer) => Promise<AudioBuffer>
    this._cache = new Map(); // key -> { status, promise, buffer?, error? }
  }

  static key(trackId, shardIndex) {
    return `${trackId}#${shardIndex}`;
  }

  // Prepares a shard up to the point where it is guaranteed decodable.
  // Concurrent calls for the same shard share one in-flight promise.
  prepare(trackId, shard) {
    const key = ShardLoader.key(trackId, shard.index);
    const cached = this._cache.get(key);
    if (cached) return cached.promise;
    if (shard.missing) {
      const entry = {
        status: 'error',
        promise: Promise.reject(new ShardLoadError(shard.url, 404, 'declared missing shard')),
      };
      entry.promise = entry.promise.catch((error) => {
        this._cache.set(key, { ...entry, error });
        throw error;
      });
      this._cache.set(key, entry);
      return entry.promise;
    }
    const entry = { status: 'loading', promise: null };
    entry.promise = (async () => {
      let res;
      try {
        res = await this._fetch(shard.url);
      } catch (cause) {
        throw new ShardLoadError(shard.url, null, `network error: ${cause.message}`);
      }
      if (!res.ok) throw new ShardLoadError(shard.url, res.status);
      const bytes = await res.arrayBuffer();
      const buffer = await this._decode(bytes);
      this._cache.set(key, { status: 'ready', promise: entry.promise, buffer });
      return buffer;
    })().catch((error) => {
      this._cache.set(key, { status: 'error', promise: entry.promise, error });
      throw error;
    });
    this._cache.set(key, entry);
    return entry.promise;
  }

  state(trackId, shardIndex) {
    return this._cache.get(ShardLoader.key(trackId, shardIndex)) ?? { status: 'idle' };
  }

  snapshot() {
    const out = {};
    for (const [key, entry] of this._cache) {
      out[key] = { status: entry.status, error: entry.error?.message ?? null };
    }
    return out;
  }
}
