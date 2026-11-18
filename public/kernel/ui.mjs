// Diagnostic console UI. Deliberately no <select>: every declared track is a
// first-class control showing language/role/timeline, coverage and — critically
// — whether it is merely selected or actually audible/visible.
//
// The kernel owns all media state. This layer only renders what the kernel
// confirms: a highlighted button is a request, not proof that media is live,
// so the "effective" badges come from effectiveTrack/effectiveSubtitle and
// failures stay on screen as an explicit notice.
import { PlaybackKernel, parseManifest, selectDefaultTrack, checkCombination } from './playback-kernel.mjs';

const $ = (id) => document.getElementById(id);
const video = $('video');
const audioCtx = new AudioContext();
const kernel = new PlaybackKernel({
  video,
  audioCtx,
  subtitleOverlay: $('subtitle-overlay'),
  onEvent: () => render(),
});
globalThis.__kernel = kernel; // test hook
globalThis.__kernelRules = { parseManifest, selectDefaultTrack, checkCombination };

function trackButton(track, { selected, effective, isFallback, onSelect }) {
  const btn = document.createElement('button');
  btn.className = 'track';
  if (selected) btn.classList.add('selected');
  const state = isFallback ? ['fallback', '实际发声(回退)']
    : effective ? ['effective', track.kind === 'subtitle' ? '实际显示' : '实际发声']
    : selected ? ['gap', '已选中·未生效']
    : track.coverage.covered ? ['idle', '可切换']
    : ['gap', `不可用: ${track.coverage.reason}`];
  btn.innerHTML = `
    <div><strong>${track.label}</strong> <span class="badge ${state[0]}">${state[1]}</span></div>
    <div class="meta">
      <span>lang=${track.language} · <span class="role-tag">role=${track.role}</span></span>
      <span>${track.timeline.startOffset}s–${track.timeline.end}s</span>
    </div>`;
  btn.addEventListener('click', () => onSelect(track));
  return btn;
}

function renderAudioTracks() {
  const wrap = $('tracks');
  wrap.innerHTML = '';
  for (const track of kernel.tracks) {
    wrap.appendChild(trackButton(track, {
      selected: kernel.selectedTrack?.id === track.id,
      effective: kernel.effectiveTrack?.id === track.id,
      isFallback: kernel.selectedTrack?.id !== kernel.effectiveTrack?.id
        && track.id === kernel.effectiveTrack?.id,
      // Audio-only behavior is preserved: selecting an audio row never changes
      // which subtitle is showing.
      onSelect: (t) => kernel.selectTrack(t.id),
    }));
  }
}

function renderSubtitleTracks() {
  const wrap = $('subtitle-tracks');
  wrap.innerHTML = '';
  // Off row: always available, clears only the overlay.
  const off = document.createElement('button');
  off.className = 'track';
  if (kernel.selectedSubtitle === null) off.classList.add('selected');
  const offEffective = kernel.effectiveSubtitle === null;
  off.innerHTML = `
    <div><strong>关闭字幕</strong>
      <span class="badge ${offEffective ? 'effective' : 'idle'}">${offEffective ? '当前生效' : '可切换'}</span></div>
    <div class="meta"><span>清除屏幕文字 · 音频继续播放</span></div>`;
  off.addEventListener('click', () => kernel.selectCombination({
    audioId: kernel.selectedTrack.id, subtitleId: null,
  }));
  wrap.appendChild(off);

  for (const track of kernel.subtitleTracks) {
    wrap.appendChild(trackButton(track, {
      selected: kernel.selectedSubtitle?.id === track.id,
      effective: kernel.effectiveSubtitle?.id === track.id,
      isFallback: false,
      // A subtitle click is a combination request with the currently selected
      // audio. Incompatible roles are rejected by the kernel and announced.
      onSelect: (t) => kernel.selectCombination({
        audioId: kernel.selectedTrack.id, subtitleId: t.id,
      }),
    }));
  }
}

function renderNotice() {
  const box = $('notice');
  const notice = kernel.lastNotice;
  if (!notice) {
    box.className = '';
    box.textContent = '';
    return;
  }
  box.className = `show ${notice.kind === 'combination-rejected' ? 'rejected' : ''}`;
  const prefix = {
    'combination-rejected': '组合被拒绝：',
    'subtitle-unavailable': '字幕不可用：',
    'audio-unavailable': '音频不可用：',
    'audio-fallback': '已回退：',
  }[notice.kind] ?? '';
  box.textContent = `${prefix}${notice.message}`;
}

function renderBuffers() {
  const wrap = $('buffers');
  const snapshot = kernel.loader.snapshot();
  const scheduled = new Set(kernel.scheduler.status.scheduledShards.map((i) => `${kernel.effectiveTrack?.id}#${i}`));
  wrap.innerHTML = '';
  for (const track of kernel.manifest.audioTracks) {
    const card = document.createElement('div');
    card.style.marginBottom = '12px';
    const cells = track.shards.map((shard) => {
      const state = snapshot[`${track.id}#${shard.index}`]?.status ?? 'idle';
      const cls = ['ready', 'loading', 'error'].includes(state) ? state : '';
      const sched = scheduled.has(`${track.id}#${shard.index}`) ? ' scheduled' : '';
      const label = shard.missing ? `${shard.index}✖` : `${shard.index}${state === 'ready' ? '✓' : state === 'error' ? '✖' : ''}`;
      return `<span class="cell ${cls}${sched}" title="t=${shard.start}s ${state}">${label}</span>`;
    }).join('');
    card.innerHTML = `<div style="font-size:12px;color:#9fb4d8">${track.label} (${track.language} · ${track.role})
      <span style="color:#5d6f92">offset ${track.timeline.startOffset}s</span></div>
      <div class="shard-row">${cells}</div>`;
    wrap.appendChild(card);
  }
  // Subtitle shard load state, from the SubtitleEngine's own cache.
  const subSnap = kernel.subtitleEngine.snapshot();
  const subIds = Object.keys(subSnap);
  if (subIds.length) {
    const card = document.createElement('div');
    card.style.marginBottom = '12px';
    const cells = subIds.map((key) => {
      const state = subSnap[key].status;
      const [id, index] = key.split('#');
      return `<span class="cell ${state === 'ready' ? 'ready' : state === 'error' ? 'error' : 'loading'}">${id}#${index}${state === 'ready' ? '✓' : state === 'error' ? '✖' : '…'}</span>`;
    }).join('');
    card.innerHTML = `<div style="font-size:12px;color:#9fb4d8">字幕分片缓存</div><div class="shard-row">${cells}</div>`;
    wrap.appendChild(card);
  }
}

function renderStatus() {
  const d = kernel.describe();
  const sub = d.selectedSubtitle ? `${d.selectedSubtitle.label} · ${d.selectedSubtitle.language} · ${d.selectedSubtitle.role}` : '关闭';
  const subEff = d.effectiveSubtitle ? `${d.effectiveSubtitle.label} · ${d.effectiveSubtitle.language} · ${d.effectiveSubtitle.role}`
    : d.selectedSubtitle ? '<span style="color:#ff7a90">未显示（明示）</span>' : '关闭';
  $('status').innerHTML = `
    <div class="row"><span>选中组合（请求）</span><span>${d.selected ? `${d.selected.label} · ${d.selected.language} · ${d.selected.role}` : '—'} ＋ ${sub}</span></div>
    <div class="row"><span>有效组合（实际）</span><span>${d.effective ? `${d.effective.label} · ${d.effective.language} · ${d.effective.role}` : '<span style="color:#ff7a90">静默（明示）</span>'} ＋ ${subEff}</span></div>
    <div class="row"><span>确认版本</span><span class="metric">v${d.comboVersion}</span></div>
    <div class="row"><span>原因</span><span>${d.statusReason}</span></div>
    <div class="row"><span>当前字幕文字</span><span>${d.subtitles.overlayText || '—'}</span></div>
    <div class="row"><span>调度缺口</span><span>${d.scheduler.coverageGaps.length ? d.scheduler.coverageGaps.join(', ') + 's' : '无'}</span></div>`;
  $('video-buf').textContent = d.videoBuffered.map((r) => `${r.start.toFixed(1)}–${r.end.toFixed(1)}s`).join('  ') || '—';
  $('position').textContent = `${d.position.toFixed(3)}s`;
  const drift = d.scheduler.drift;
  const el = $('drift');
  el.textContent = drift.samples
    ? `${drift.avgMs} ms / ${drift.peakMs} ms（n=${drift.samples}）`
    : '0 ms / 0 ms（采样中）';
  el.className = 'metric ' + (drift.peakMs > 120 ? 'delta-bad' : drift.peakMs > 60 ? 'delta-warn' : 'delta-good');
  const bar = $('seekbar');
  bar.max = String(kernel.manifest.duration);
  if (!dragging) bar.value = String(d.position);
}

let dragging = false;

function renderLog() {
  const box = $('log');
  const warnEvents = new Set(['fallback-needed', 'shard-gap', 'track-uncovered', 'resync',
    'subtitle-uncovered', 'subtitle-unavailable', 'subtitle-ended', 'subtitle-shard-error']);
  const errEvents = new Set(['scheduler-error', 'fallback-failed', 'combination-rejected']);
  box.innerHTML = kernel.log.slice(-120).map((e) => {
    const cls = errEvents.has(e.type) ? 'err' : warnEvents.has(e.type) ? 'warn' : '';
    return `<div class="line ${cls}">[${e.t.toFixed(2)}s] ${e.type} ${JSON.stringify(Object.fromEntries(
      Object.entries(e).filter(([k]) => !['type', 't', 'wall'].includes(k))))}</div>`;
  }).join('');
  box.scrollTop = box.scrollHeight;
}

function render() {
  if (!kernel.manifest) return;
  renderAudioTracks();
  renderSubtitleTracks();
  renderNotice();
  renderBuffers();
  renderStatus();
  renderLog();
}

$('play').addEventListener('click', () => kernel.play());
$('pause').addEventListener('click', () => kernel.pause());

// Scrubber: drag updates the label; release commits a kernel seek, after which
// the picture and the currently selected (not reselected) audio both rebuild.
const seekbar = $('seekbar');
seekbar.addEventListener('pointerdown', () => { dragging = true; });
seekbar.addEventListener('input', () => {
  $('position').textContent = `${Number(seekbar.value).toFixed(3)}s`;
});
seekbar.addEventListener('change', async () => {
  await kernel.seek(Number(seekbar.value));
  dragging = false;
  render();
});

try {
  await kernel.load('program.json');
  $('title').textContent = `${kernel.manifest.title} · 播放内核诊断台`;
  render();
  setInterval(render, 400);
} catch (err) {
  console.error('kernel boot failed', err);
  $('status').innerHTML = `<span style="color:#ff7a90">启动失败: ${err.message}</span>`;
  globalThis.__bootError = { message: err.message, stack: err.stack };
  throw err;
}
