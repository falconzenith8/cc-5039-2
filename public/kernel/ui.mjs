// Diagnostic console UI. Deliberately no <select>: every declared track is a
// first-class control showing language/role/timeline, coverage and — critically
// — whether it is merely selected or actually audible.
import { PlaybackKernel, parseManifest, selectDefaultTrack } from './playback-kernel.mjs';

const $ = (id) => document.getElementById(id);
const video = $('video');
const audioCtx = new AudioContext();
const kernel = new PlaybackKernel({
  video,
  audioCtx,
  onEvent: () => render(),
});
globalThis.__kernel = kernel; // test hook
globalThis.__kernelRules = { parseManifest, selectDefaultTrack };

function renderTracks() {
  const wrap = $('tracks');
  wrap.innerHTML = '';
  for (const track of kernel.tracks) {
    const btn = document.createElement('button');
    btn.className = 'track';
    if (kernel.selectedTrack?.id === track.id) btn.classList.add('selected');
    const isEffective = kernel.effectiveTrack?.id === track.id;
    const isFallback = kernel.selectedTrack?.id !== kernel.effectiveTrack?.id && isEffective;
    const state = isFallback ? ['fallback', '实际发声(回退)']
      : isEffective ? ['effective', '实际发声']
      : track.coverage.covered ? ['idle', '可切换']
      : ['gap', `不可用: ${track.coverage.reason}`];
    btn.innerHTML = `
      <div><strong>${track.label}</strong> <span class="badge ${state[0]}">${state[1]}</span></div>
      <div class="meta">
        <span>lang=${track.language} · role=${track.role}</span>
        <span>${track.timeline.startOffset}s–${track.timeline.end}s</span>
      </div>`;
    btn.addEventListener('click', () => kernel.selectTrack(track.id));
    wrap.appendChild(btn);
  }
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
    card.innerHTML = `<div style="font-size:12px;color:#9fb4d8">${track.label} (${track.language})
      <span style="color:#5d6f92">offset ${track.timeline.startOffset}s</span></div>
      <div class="shard-row">${cells}</div>`;
    wrap.appendChild(card);
  }
}

function renderStatus() {
  const d = kernel.describe();
  $('status').innerHTML = `
    <div class="row"><span>选中轨道</span><span>${d.selected ? `${d.selected.label} · ${d.selected.language}` : '—'}</span></div>
    <div class="row"><span>实际发声</span><span>${d.effective ? `${d.effective.label} · ${d.effective.language}` : '<span style="color:#ff7a90">静默（明示）</span>'}</span></div>
    <div class="row"><span>原因</span><span>${d.statusReason}</span></div>
    <div class="row"><span>调度缺口</span><span>${d.scheduler.coverageGaps.length ? d.scheduler.coverageGaps.join(', ') + 's' : '无'}</span></div>`;
  $('video-buf').textContent = d.videoBuffered.map((r) => `${r.start.toFixed(1)}–${r.end.toFixed(1)}s`).join('  ') || '—';
  $('position').textContent = `${d.position.toFixed(3)}s`;
  const drift = d.scheduler.drift;
  const el = $('drift');
  el.textContent = drift.samples
    ? `${drift.avgMs} ms / ${drift.peakMs} ms（n=${drift.samples}）`
    : '0 ms / 0 ms（采样中）';
  el.className = 'metric ' + (drift.peakMs > 120 ? 'delta-bad' : drift.peakMs > 60 ? 'delta-warn' : 'delta-good');
}

function renderLog() {
  const box = $('log');
  const warnEvents = new Set(['fallback-needed', 'shard-gap', 'track-uncovered', 'resync']);
  const errEvents = new Set(['scheduler-error', 'fallback-failed']);
  box.innerHTML = kernel.log.slice(-120).map((e) => {
    const cls = errEvents.has(e.type) ? 'err' : warnEvents.has(e.type) ? 'warn' : '';
    return `<div class="line ${cls}">[${e.t.toFixed(2)}s] ${e.type} ${JSON.stringify(Object.fromEntries(
      Object.entries(e).filter(([k]) => !['type', 't', 'wall'].includes(k))))}</div>`;
  }).join('');
  box.scrollTop = box.scrollHeight;
}

function render() {
  if (!kernel.manifest) return;
  renderTracks();
  renderBuffers();
  renderStatus();
  renderLog();
}

$('play').addEventListener('click', () => kernel.play());
$('pause').addEventListener('click', () => kernel.pause());

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
