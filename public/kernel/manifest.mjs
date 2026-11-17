// Manifest parsing, validation and declarative default-track selection.
// Language/role/track identity come only from manifest fields; array position
// and shard file names are never used to infer a language.

export class ManifestError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ManifestError';
  }
}

export function parseManifest(raw) {
  const m = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!m || m.schemaVersion !== 1) throw new ManifestError('unsupported or missing schemaVersion');
  if (!Array.isArray(m.audioTracks) || m.audioTracks.length === 0) {
    throw new ManifestError('manifest must declare at least one audio track');
  }
  if (!m.video?.initUrl || !Array.isArray(m.video.shards) || m.video.shards.length === 0) {
    throw new ManifestError('manifest must declare a sharded video track');
  }
  const seenLanguages = new Set();
  for (const track of m.audioTracks) {
    if (!track.id || !track.language) {
      throw new ManifestError(`audio track missing id/language: ${JSON.stringify(track)}`);
    }
    if (seenLanguages.has(track.language)) {
      throw new ManifestError(`duplicate language ${track.language}; language must be unambiguous`);
    }
    seenLanguages.add(track.language);
    if (!track.timeline || typeof track.timeline.startOffset !== 'number' || typeof track.timeline.end !== 'number') {
      throw new ManifestError(`track ${track.id} must declare explicit timeline startOffset/end`);
    }
    if (track.timeline.end <= track.timeline.startOffset) {
      throw new ManifestError(`track ${track.id} has empty timeline`);
    }
    if (!Array.isArray(track.shards) || track.shards.length === 0) {
      throw new ManifestError(`track ${track.id} declares no shards`);
    }
    for (const shard of track.shards) {
      if (typeof shard.start !== 'number' || typeof shard.duration !== 'number') {
        throw new ManifestError(`track ${track.id} shard missing explicit start/duration`);
      }
    }
  }
  return m;
}

// Explicit, documented precedence (mirrors selectionRules.order in the manifest):
//   1. track.default === true
//   2. exact match against rules.defaultLanguage
//   3. rolePriority order
//   4. stable track.id tiebreak
// Shard/array index is intentionally absent from this list.
export function selectDefaultTrack(manifest, preferredLanguage = null) {
  const rules = manifest.selectionRules ?? {};
  const rolePriority = rules.rolePriority ?? ['main', 'secondary'];
  const rank = (track) => {
    if (track.default === true) return 0;
    const wantLang = preferredLanguage ?? rules.defaultLanguage;
    if (wantLang && track.language === wantLang) return 1;
    const roleIdx = rolePriority.indexOf(track.role);
    return 2 + (roleIdx === -1 ? rolePriority.length : roleIdx);
  };
  const sorted = [...manifest.audioTracks].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    return a.id.localeCompare(b.id);
  });
  return { track: sorted[0], reason: describeReason(sorted[0], preferredLanguage ?? rules.defaultLanguage) };
}

function describeReason(track, wantLang) {
  if (track.default === true) return 'explicit default flag';
  if (wantLang && track.language === wantLang) return `language rule match (${wantLang})`;
  return `role priority (${track.role}) then id tiebreak`;
}

// Resolve the declarative fallback chain for a failed/missing track.
// Returns null when no usable fallback exists (the UI must then show silence).
export function resolveFallback(manifest, failedLanguage) {
  const fallback = manifest.selectionRules?.fallback ?? {};
  const visited = new Set([failedLanguage]);
  let current = failedLanguage;
  while (true) {
    const next = fallback[current] ?? fallback['*'];
    if (!next || visited.has(next)) return null;
    visited.add(next);
    const track = manifest.audioTracks.find((t) => t.language === next);
    if (track) return track;
    current = next;
  }
}

// Does a track cover the given program time with a declared, present shard?
export function coverageAt(track, time) {
  const { startOffset, end } = track.timeline;
  if (time < startOffset || time >= end) return { covered: false, reason: 'outside-track-timeline' };
  const shard = track.shards.find((s) => time >= s.start && time < s.start + s.duration);
  if (!shard) return { covered: false, reason: 'no-declared-shard' };
  if (shard.missing) return { covered: false, reason: 'declared-missing-shard', shard };
  return { covered: true, shard };
}
