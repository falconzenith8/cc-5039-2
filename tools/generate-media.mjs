// Generates the demo program: sharded fMP4 video (via ffmpeg) + per-language WAV
// shards with distinct tones, speech markers, offsets, short tracks and a missing
// shard. Everything is declared explicitly in public/program.json — nothing is
// inferred from file order.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ffmpegPath from 'ffmpeg-static';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(ROOT, '..', 'public');
const MEDIA = join(PUBLIC, 'media');
const SR = 22050;
const SHARD = 4; // seconds per audio shard
const PROGRAM_DURATION = 24;

// (language, displayName, role, base tone Hz, startOffset, coverage end, missing shard)
const TRACKS = [
  { id: 'zh', language: 'zh-CN', name: '普通话解说', role: 'main',      tone: 330, offset: 0,  end: 24 },
  { id: 'en', language: 'en-US', name: 'English Narration', role: 'main', tone: 440, offset: 0, end: 24 },
  { id: 'ja', language: 'ja-JP', name: '日本語解説', role: 'secondary', tone: 554, offset: 6, end: 20 },
  { id: 'fr', language: 'fr-FR', name: 'Commentaire français', role: 'secondary', tone: 659, offset: 0, end: 24, missing: 3 },
];

function writeWav(path, samples) {
  const dataLen = samples.length * 2;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataLen, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(dataLen, 40);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  writeFileSync(path, buf);
}

// Speech marker = two short bright beeps at the given time within a shard,
// superimposed on the steady language tone. Markers happen once per shard so
// every track that covers a shard is verifiably "speaking".
function buildSamples(track, shardIndex) {
  const n = SR * SHARD;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let s = 0.12 * Math.sin(2 * Math.PI * track.tone * t);
    const inBeep = (center) => {
      const d = t - center;
      return d >= 0 && d < 0.18 ? 0.22 * Math.sin(2 * Math.PI * (track.tone * 3) * d)
        * Math.exp(-d * 6) : 0;
    };
    s += inBeep(1.2) + inBeep(1.55);
    out[i] = s;
  }
  return out;
}

function buildAudio() {
  const manifestTracks = [];
  for (const track of TRACKS) {
    const dir = join(MEDIA, `audio-${track.id}`);
    mkdirSync(dir, { recursive: true });
    const firstIndex = Math.ceil(track.offset / SHARD);
    const lastIndex = Math.ceil(track.end / SHARD) - 1;
    const shards = [];
    for (let idx = firstIndex; idx <= lastIndex; idx++) {
      const shardStart = idx * SHARD;
      const shardEnd = Math.min((idx + 1) * SHARD, track.end);
      const duration = shardEnd - shardStart;
      if (track.missing === idx) {
        // deliberately do not write the file; the shard is still declared so
        // the kernel must surface the load failure and apply its fallback rule.
        shards.push({ index: idx, url: `media/audio-${track.id}/${idx}.wav`, start: shardStart, duration, missing: true });
        continue;
      }
      const samples = buildSamples(track, idx).subarray(0, Math.round(duration * SR));
      writeWav(join(dir, `${idx}.wav`), samples);
      shards.push({ index: idx, url: `media/audio-${track.id}/${idx}.wav`, start: shardStart, duration });
    }
    manifestTracks.push({
      id: track.id,
      kind: 'audio',
      language: track.language,
      label: track.name,
      role: track.role,
      toneHz: track.tone,
      // explicit declaration — consumers must never guess language from file order
      timeline: {
        startOffset: track.offset,
        end: track.end,
        speechMarkers: shards.flatMap((sh) => sh.missing ? [] : [
          { time: sh.start + 1.2, kind: 'beep' },
          { time: sh.start + 1.55, kind: 'beep' },
        ]),
      },
      shards,
    });
  }
  return manifestTracks;
}

function buildVideo() {
  const dir = join(MEDIA, 'video-main');
  mkdirSync(dir, { recursive: true });
  // H.264 with keyframe every second, DASH-muxed into init + numbered fMP4.
  // ffmpeg-static has no libfreetype, so the on-screen timecode is drawn with
  // drawbox only: a progress bar plus five bit-cells encoding floor(t) in binary
  // (24s program fits in 5 bits). Tests read those cells to know the video's
  // displayed time and compare it against the audio scheduler clock.
  const filters = [
    "color=c=0x101828:s=640x360:r=25",
    "drawbox=x=0:y=0:w='640*t/24':h=14:color=0x4f8cff:t=fill",
  ];
  for (let bit = 0; bit < 5; bit++) {
    const value = 1 << (4 - bit);
    const x = 220 + bit * 44;
    filters.push(
      `drawbox=x='if(gte(mod(t,32),${value}),${x},-200)':y=150:w=36:h=60:color=0x7fb0ff:t=fill`
    );
  }
  const filter = filters.join(',');
  const cmd = [
    '-y', '-f', 'lavfi', '-i', filter,
    '-t', String(PROGRAM_DURATION),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-g', '25', '-keyint_min', '25', '-sc_threshold', '0',
    '-b:v', '600k', '-preset', 'veryfast',
    '-f', 'dash', '-dash_segment_type', 'mp4', '-seg_duration', String(SHARD),
    '-init_seg_name', 'init.mp4', '-media_seg_name', '$Number$.m4s',
    join(dir, 'stream.mpd'),
  ];
  try {
    execFileSync(ffmpegPath, cmd, { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (err) {
    process.stderr.write(err.stderr?.toString() ?? String(err));
    throw err;
  }

  const mpd = readFileSync(join(dir, 'stream.mpd'), 'utf8');
  const timescale = Number(mpd.match(/timescale="(\d+)"/)?.[1] ?? 1000);
  const shards = [];
  let t = 0;
  let index = 0;
  for (const m of mpd.matchAll(/<S\b([^>]*)\/>/g)) {
    const attrs = m[1];
    const tAttr = attrs.match(/\bt="(\d+)"/);
    if (tAttr) t = Number(tAttr[1]);
    const d = Number(attrs.match(/\bd="(\d+)/)[1]);
    const repeat = Number(attrs.match(/\br="(\d+)"/)?.[1] ?? 0);
    for (let r = 0; r <= repeat; r++) {
      const duration = d / timescale;
      shards.push({ index, url: `media/video-main/${index + 1}.m4s`, start: t / timescale, duration });
      t += d;
      index++;
    }
  }
  return {
    id: 'main-video', kind: 'video', label: '舞台主画面',
    initUrl: 'media/video-main/init.mp4',
    shards,
    duration: t / timescale,
  };
}

rmSync(MEDIA, { recursive: true, force: true });
mkdirSync(MEDIA, { recursive: true });
const video = buildVideo();
const audio = buildAudio();

const manifest = {
  schemaVersion: 1,
  programId: 'stage-show-2026',
  title: '多语言演出样例节目',
  generatedAt: new Date().toISOString(),
  duration: PROGRAM_DURATION,
  timeBase: { source: 'video-element', note: 'video is the master clock; audio shards are scheduled against it' },
  selectionRules: {
    defaultLanguage: 'zh-CN',
    rolePriority: ['main', 'secondary'],
    // Explicit, declarative rule. File/array position is never used to infer
    // language, and shard file names carry no language meaning.
    order: ['track.default === true', 'track.language === rules.defaultLanguage', 'rolePriority index', 'track.id'],
    fallback: {
      'fr-FR': 'en-US',
      '*': 'zh-CN',
    },
  },
  video,
  audioTracks: audio,
};
writeFileSync(join(PUBLIC, 'program.json'), JSON.stringify(manifest, null, 2));
console.log(`generated ${video.shards.length} video shards, ${audio.length} audio tracks under ${MEDIA}`);
