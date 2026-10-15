import { Sim, CATS } from './sim.js';
import { Renderer } from './render.js';
import { Demo, DEMO_NAMES } from './demo.js';

const $ = (id) => document.getElementById(id);
const sim = new Sim();
const view = new Renderer($('stage'), sim);

let mode = 'demo';          // demo | live
let liveStatus = null;      // from /api/status, null when there is no server
let demo = null;
let events = null;
let liveNames = {};

// ---- sources ---------------------------------------------------------------

function startDemo() {
  stopLive();
  sim.clear();
  sim.names = { ...DEMO_NAMES };
  demo = new Demo((ev) => sim.ingest(ev), showCaption);
  mode = 'demo';
  setBadge();
}

function stopLive() {
  if (events) { events.close(); events = null; }
}

function startLive() {
  demo = null;
  showCaption(null);
  sim.clear();
  sim.names = { ...liveNames };
  mode = 'live';
  setBadge();
  events = new EventSource('/events');
  events.addEventListener('packets', (e) => { for (const p of JSON.parse(e.data)) sim.ingest(p); });
  events.addEventListener('name', (e) => { const n = JSON.parse(e.data); if (n.name) sim.names[n.ip] = n.name; });
  events.addEventListener('status', (e) => { liveStatus = JSON.parse(e.data); setBadge(); });
  events.onerror = () => { $('mode').textContent = 'Reconnecting'; $('mode').className = 'badge'; };
}

async function init() {
  const forceDemo = new URLSearchParams(location.search).has('demo');
  try {
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 1500);
    const r = await fetch('/api/status', { signal: ctl.signal });
    liveStatus = await r.json();
    liveNames = liveStatus.names || {};
  } catch { liveStatus = null; }

  if (liveStatus?.live && !forceDemo) startLive();
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
  $('source').textContent = src;
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
  const n = view.nodeAt(e.clientX, e.clientY);
  if (n && !n.fixed) { dragging = n; n.pinned = true; $('stage').setPointerCapture(e.pointerId); }
});
$('stage').addEventListener('pointermove', (e) => { if (dragging) { dragging.x = e.clientX; dragging.y = e.clientY; } });
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
  if (!sim.paused) {
    demo?.update(Math.min(dt, 0.05));
    sim.step(dt);
  }
  view.draw();
  hudClock += dt;
  if (hudClock > 0.25) { hudClock = 0; updateHud(); }
  requestAnimationFrame(frame);
}

// handle for debugging in the browser console
window.oip = { sim, view, get demo() { return demo; } };

init().then(() => requestAnimationFrame(frame));
