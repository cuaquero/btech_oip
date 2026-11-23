import { Sim, CATS } from './sim.js';
import { Renderer } from './render.js';
import { Demo, DEMO_NAMES } from './demo.js';
import { GridView } from './grid.js';

const $ = (id) => document.getElementById(id);
const sim = new Sim();
const view = new Renderer($('stage'), sim);
const grid = new GridView(sim);
view.grid = grid;
const params = new URLSearchParams(location.search);
if (params.get('view') === 'grid') { view.mode = 'grid'; document.body.classList.add('grid'); }

// every packet feeds both views
const feed = (ev) => { sim.ingest(ev); if (!sim.paused) grid.ingest(ev); };

// A capture often delivers packets in bursts (the firewall's tcpdump can hold them
// for up to a second). Drawn as they arrive, a second of traffic would appear at once
// and then nothing. Instead each burst is spread across the time since the previous
// one, so traffic flows steadily. It adds about one burst interval of delay.
// ?smooth=0 turns this off.
const smooth = params.get('smooth') !== '0';
const pending = [];         // packets waiting for their turn: { due, p }
let lastBatchAt = 0;
let batchGap = 100;         // smoothed time between bursts, in ms

function queueBatch(list) {
  if (!smooth || list.length === 0 || pending.length > 5000) { for (const p of list) feed(p); return; }
  const now = performance.now();
  if (lastBatchAt) batchGap = 0.7 * batchGap + 0.3 * Math.min(1500, Math.max(20, now - lastBatchAt));
  lastBatchAt = now;
  const n = list.length;
  list.forEach((p, i) => pending.push({ due: now + (i / n) * batchGap, p }));
  pending.sort((a, b) => a.due - b.due);
}

function releaseDue(now) {
  while (pending.length && pending[0].due <= now) feed(pending.shift().p);
}

let mode = 'demo';          // demo | live
let liveStatus = null;      // from /api/status, null when there is no server
let demo = null;
let events = null;
let liveNames = {};

// ---- sources ---------------------------------------------------------------

function startDemo() {
  stopLive();
  sim.clear();
  grid.clear();
  grid.setNetwork('10.0.0.0/16', true);
  sim.names = { ...DEMO_NAMES };
  demo = new Demo(feed, showCaption);
  demo.crowd = view.mode === 'grid';
  mode = 'demo';
  setBadge();
}

function stopLive() {
  if (events) { events.close(); events = null; }
  pending.length = 0;
}

function startLive() {
  demo = null;
  showCaption(null);
  sim.clear();
  grid.clear();
  grid.fixedNet = false;
  grid.net = null;
  const net = params.get('net') || liveStatus?.localnet;
  if (net) grid.setNetwork(net, true);
  sim.names = { ...liveNames };
  mode = 'live';
  setBadge();
  // relative, so the page also works when another server mounts it under a path (e.g. /oip/)
  events = new EventSource('events');
  pending.length = 0;
  lastBatchAt = 0;
  events.addEventListener('packets', (e) => queueBatch(JSON.parse(e.data)));
  events.addEventListener('name', (e) => { const n = JSON.parse(e.data); if (n.name) sim.names[n.ip] = n.name; });
  events.addEventListener('status', (e) => { liveStatus = JSON.parse(e.data); setBadge(); });
  events.onerror = () => { $('mode').textContent = 'Reconnecting'; $('mode').className = 'badge'; };
}

async function init() {
  // ?demo never talks to a server, so it works on any static host and never
  // triggers a login prompt from a server that answers /api/status with a 401
  if (params.has('demo')) { startDemo(); return; }
  try {
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 1500);
    const r = await fetch('api/status', { signal: ctl.signal });
    liveStatus = await r.json();
    liveNames = liveStatus.names || {};
  } catch { liveStatus = null; }

  if (liveStatus?.live) startLive();
  else startDemo();
}

// ---- overlay ---------------------------------------------------------------

function setBadge() {
  const badge = $('mode');
  if (sim.paused) { badge.textContent = 'Paused'; badge.className = 'badge paused'; }
  else if (mode === 'live') { badge.textContent = 'Live'; badge.className = 'badge live'; }
  else { badge.textContent = 'Demo'; badge.className = 'badge'; }

  let src = '';
  if (mode === 'live') src = liveStatus?.source || '';
  else if (liveStatus?.error) src = liveStatus.error;
  $('source').textContent = (view.mode === 'grid' && grid.net ? grid.label() + (src ? ' · ' : '') : '') + src;
  $('talkers').hidden = view.mode === 'grid';
}

function setView(m) {
  view.mode = m;
  document.body.classList.toggle('grid', m === 'grid');
  if (demo) { demo.crowd = m === 'grid'; sim.clear(); grid.clear(); if (mode === 'demo') grid.setNetwork('10.0.0.0/16', true); }
  $('block').hidden = true;
  $('tip').hidden = true;
  setBadge();
}

function showCaption(s) {
  const box = $('caption');
  if (!s) { box.hidden = true; return; }
  $('caption-title').textContent = s.name;
  $('caption-text').textContent = s.caption;
  box.hidden = false;
}

const legend = $('legend');
const legendRates = {};
for (const [key, c] of Object.entries(CATS)) {
  const li = document.createElement('li');
  li.innerHTML = '<span class="dot"></span><span class="label"></span><span class="rate"></span>';
  li.querySelector('.dot').style.color = c.color;
  li.querySelector('.label').textContent = c.label;
  legend.appendChild(li);
  legendRates[key] = li;
}

function fmtBits(bps) {
  if (bps >= 1e9) return (bps / 1e9).toFixed(1) + ' Gbit/s';
  if (bps >= 1e6) return (bps / 1e6).toFixed(1) + ' Mbit/s';
  if (bps >= 1e3) return (bps / 1e3).toFixed(0) + ' kbit/s';
  return Math.round(bps) + ' bit/s';
}

function fmtBytes(bps) {
  if (bps >= 1e6) return (bps / 1e6).toFixed(1) + ' MB/s';
  if (bps >= 1e3) return (bps / 1e3).toFixed(0) + ' kB/s';
  return Math.round(bps) + ' B/s';
}

function updateHud() {
  const st = sim.stats;
  $('pps').textContent = Math.round(st.pps);
  $('bps').textContent = fmtBits(st.bps);
  for (const [key, li] of Object.entries(legendRates)) {
    const r = st.cat[key] || 0;
    li.querySelector('.rate').textContent = r >= 1 ? Math.round(r) + '/s' : '';
    li.classList.toggle('quiet', r < 1);
  }

  if (view.mode === 'grid') { updateBlock(); return; }
  const top = [...sim.nodes.values()]
    .filter((n) => n.bytes > 30)
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 6);
  const list = $('talker-list');
  list.replaceChildren(...top.map((n) => {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = sim.displayName(n);
    const rate = document.createElement('span');
    rate.className = 'rate';
    rate.textContent = fmtBytes(n.bytes / 5);
    li.append(name, rate);
    return li;
  }));
}

function updateBlock() {
  const box = $('block');
  const b = grid.blockSummary();
  box.hidden = !b;
  if (!b) return;
  $('block-title').textContent = b.name ? `${b.name} (${b.cidr})` : b.cidr;
  $('block-total').textContent = `${b.count} active hosts · ${fmtBytes(b.total)}`;
  const list = $('block-list');
  list.replaceChildren(...b.hosts.map((h) => {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = h.name || h.ip;
    const rate = document.createElement('span');
    rate.className = 'rate';
    rate.textContent = fmtBytes(h.rate);
    li.append(name, rate);
    return li;
  }));
}

// ---- input -----------------------------------------------------------------

addEventListener('resize', () => view.resize());

let idleTimer;
function wake() {
  document.body.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => document.body.classList.add('idle'), 3000);
}
addEventListener('mousemove', wake);
wake();
setTimeout(() => $('hint').classList.add('gone'), 10000);

let dragging = null;
$('stage').addEventListener('pointerdown', (e) => {
  if (view.mode === 'grid') {
    const off = grid.cellAt(e.clientX, e.clientY);
    const blk = off === null ? null : off >> 8;
    grid.select(blk === grid.selected ? null : off);
    updateBlock();
    return;
  }
  const n = view.nodeAt(e.clientX, e.clientY);
  if (n && !n.fixed) { dragging = n; n.pinned = true; $('stage').setPointerCapture(e.pointerId); }
});
$('stage').addEventListener('pointermove', (e) => {
  if (view.mode === 'grid') {
    grid.hover = grid.cellAt(e.clientX, e.clientY);
    const tip = $('tip');
    if (grid.hover === null) { tip.hidden = true; return; }
    const d = grid.describe(grid.hover);
    tip.textContent = `${d.name ? d.name + '  ' : ''}${d.ip}` + (d.rate > 1 ? `  ·  ${fmtBytes(d.rate)}` : d.idle < 1e6 ? `  ·  last seen ${Math.round(d.idle)}s ago` : '');
    tip.style.left = Math.min(e.clientX + 16, innerWidth - tip.offsetWidth - 8) + 'px';
    tip.style.top = (e.clientY + 16) + 'px';
    tip.hidden = false;
    return;
  }
  if (dragging) { dragging.x = e.clientX; dragging.y = e.clientY; }
});
$('stage').addEventListener('pointerup', () => { if (dragging) { dragging.pinned = false; dragging = null; } });

addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  switch (e.key) {
    case ' ': e.preventDefault(); sim.paused = !sim.paused; setBadge(); break;
    case 'd': case 'D':
      if (mode === 'demo') { if (liveStatus?.live) startLive(); }
      else startDemo();
      break;
    case 'n': case 'N': demo?.next(); break;
    case 'g': case 'G': setView(view.mode === 'grid' ? 'graph' : 'grid'); break;
    case 'l': case 'L': view.labels = { auto: 'all', all: 'off', off: 'auto' }[view.labels]; break;
    case 'i': case 'I': sim.collapseInternet = !sim.collapseInternet; sim.clear(); break;
    case '+': case '=': sim.zoom = Math.min(2.2, sim.zoom + 0.15); sim.updateScale(); document.documentElement.style.setProperty('--u', `calc(clamp(14px, 1.15vw, 32px) * ${sim.zoom})`); break;
    case '-': case '_': sim.zoom = Math.max(0.6, sim.zoom - 0.15); sim.updateScale(); document.documentElement.style.setProperty('--u', `calc(clamp(14px, 1.15vw, 32px) * ${sim.zoom})`); break;
    case 'h': case 'H': document.body.classList.toggle('hide-hud'); break;
    case 'f': case 'F':
      if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen?.();
      break;
    case '?': case '/': $('help').hidden = !$('help').hidden; break;
    case 'Escape': $('help').hidden = true; break;
  }
});

// ---- main loop -------------------------------------------------------------

let last = performance.now();
let hudClock = 0;
function frame(now) {
  const dt = (now - last) / 1000;
  last = now;
  releaseDue(now);
  if (!sim.paused) {
    demo?.update(Math.min(dt, 0.05));
    sim.step(dt);
    grid.step(dt);
  }
  view.draw();
  hudClock += dt;
  if (hudClock > 0.25) { hudClock = 0; updateHud(); }
  requestAnimationFrame(frame);
}

// handle for debugging in the browser console
window.oip = { sim, view, grid, get demo() { return demo; }, get queued() { return pending.length; } };

init().then(() => requestAnimationFrame(frame));
