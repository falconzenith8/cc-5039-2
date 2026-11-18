// Generates the demo program: sharded fMP4 video (via ffmpeg) + per-language WAV
// shards with distinct tones, speech markers, offsets, short tracks and a missing
// shard. Everything is declared explicitly in public/program.json — nothing is
// inferred from file order.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ffmpegStatic from 'ffmpeg-static';

// Allow an externally provided ffmpeg (e.g. a Linux static build when the
// npm package's bundled binary targets another platform).
const ffmpegPath = process.env.FFMPEG_PATH || ffmpegStatic;

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
  // Same language (zh-CN) as the main narration but a different role: selection
  // must key on (language, role), never merge by language name alone.
  { id: 'zh-desc', language: 'zh-CN', name: '普通话描述性音频', role: 'description', tone: 220, offset: 0, end: 24 },
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

// Subtitle shards are standalone JSON files on the same 4s program grid as the
// audio shards. Each cue carries absolute program start/end times, so a cue is
// rendered from the video clock and survives crossing a shard boundary: the
// SubtitleEngine keeps an active cue until its own declared end, even when the
// next shard has not been fetched yet.
const SUBTITLE_TRACKS = [
  {
    id: 'zh-dialogue', language: 'zh-CN', name: '普通话完整对白', role: 'dialogue', offset: 0, end: 24,
    cues: [
      { start: 1.0, end: 3.6, text: '【对白】欢迎来到今晚的演出' },
      // Deliberately crosses the 4s shard boundary.
      { start: 3.4, end: 5.8, text: '【对白】灯光渐暗，序曲响起' },
      { start: 7.2, end: 9.9, text: '【对白】第一幕：城市清晨' },
      { start: 11.1, end: 13.8, text: '【对白】舞者从舞台左侧入场' },
      { start: 15.2, end: 17.9, text: '【对白】合唱段落即将开始' },
      { start: 19.1, end: 21.7, text: '【对白】灯光转向蓝色' },
      { start: 22.0, end: 23.8, text: '【对白】感谢观看，晚安' },
    ],
  },
  {
    id: 'zh-forced', language: 'zh-CN', name: '普通话强制字幕', role: 'forced', offset: 0, end: 24,
    cues: [
      { start: 2.0, end: 4.2, text: '【强制】(外语歌词) 夜未央' },
      { start: 10.0, end: 12.4, text: '【强制】(画外音) 三，二，一' },
      { start: 18.0, end: 20.4, text: '【强制】(字幕) 终章' },
    ],
  },
  {
    // Ends early (16s): at later positions the UI must show it as unavailable
    // and selecting it must produce an explicit notice, not a stale caption.
    id: 'en-forced', language: 'en-US', name: 'English Forced Captions', role: 'forced', offset: 0, end: 16,
    cues: [
      { start: 2.0, end: 4.2, text: '[FORCED] (foreign lyrics) Endless Night' },
      { start: 10.0, end: 12.4, text: '[FORCED] (voice-over) Three, two, one' },
      { start: 14.0, end: 15.8, text: '[FORCED] Final chapter begins' },
    ],
  },
];

function buildSubtitles() {
  const manifestTracks = [];
  for (const track of SUBTITLE_TRACKS) {
    const dir = join(MEDIA, `subs-${track.id}`);
    mkdirSync(dir, { recursive: true });
    const firstIndex = Math.ceil(track.offset / SHARD);
    const lastIndex = Math.ceil(track.end / SHARD) - 1;
    const shards = [];
    for (let idx = firstIndex; idx <= lastIndex; idx++) {
      const shardStart = idx * SHARD;
      const shardEnd = Math.min((idx + 1) * SHARD, track.end);
      const cues = track.cues
        .filter((c) => c.start < shardEnd && c.end > shardStart)
        .map((c) => ({ start: c.start, end: c.end, text: c.text }));
      const url = `media/subs-${track.id}/${idx}.json`;
      writeFileSync(join(dir, `${idx}.json`), JSON.stringify({ shardIndex: idx, cues }, null, 2));
      shards.push({ index: idx, url, start: shardStart, duration: shardEnd - shardStart });
    }
    manifestTracks.push({
      id: track.id,
      kind: 'subtitle',
      language: track.language,
      label: track.name,
      role: track.role,
      timeline: { startOffset: track.offset, end: track.end },
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
const subtitles = buildSubtitles();

const manifest = {
  schemaVersion: 1,
  programId: 'stage-show-2026',
  title: '多语言演出样例节目',
  generatedAt: new Date().toISOString(),
  duration: PROGRAM_DURATION,
  timeBase: { source: 'video-element', note: 'video is the master clock; audio shards and subtitle cues are scheduled against it' },
  selectionRules: {
    defaultLanguage: 'zh-CN',
    defaultAudioTrack: 'zh',
    defaultSubtitleTrack: null,
    rolePriority: ['main', 'secondary', 'description'],
    // Explicit, declarative rule. File/array position is never used to infer
    // language, and shard file names carry no language meaning.
    order: ['track.default === true', 'track.language === rules.defaultLanguage', 'rolePriority index', 'track.id'],
    fallback: {
      'fr-FR': 'en-US',
      '*': 'zh-CN',
    },
  },
  // Role-level compatibility, independent of language: descriptive audio already
  // narrates the scene, so full dialogue captions duplicate it. Forced captions
  // remain allowed because they only translate on-screen text/lyrics.
  combinationRules: {
    disallowed: [
      { audioRole: 'description', subtitleRole: 'dialogue', reason: '描述性音频已包含场景解说，禁止与完整对白字幕同时启用' },
    ],
  },
  video,
  audioTracks: audio,
  subtitleTracks: subtitles,
};
writeFileSync(join(PUBLIC, 'program.json'), JSON.stringify(manifest, null, 2));
console.log(`generated ${video.shards.length} video shards, ${audio.length} audio tracks, ${subtitles.length} subtitle tracks under ${MEDIA}`);
