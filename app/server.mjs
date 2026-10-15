#!/usr/bin/env node
// OIP display server: serves the web page and streams packet metadata to it.
// Zero npm dependencies. Live capture uses tshark (Wireshark); without it the
// page runs its built-in demo traffic instead.
//
//   node server.mjs --list                 list capture interfaces
//   node server.mjs --iface 6              live capture on interface 6
//   node server.mjs --pcap capture.pcap    replay a capture file
//   node server.mjs                        demo only

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import dns from 'node:dns/promises';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(here, 'public');

// ---- options ---------------------------------------------------------------

function readConfig() {
  const file = path.join(here, 'config.json');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

function parseArgs(argv, cfg) {
  const o = {
    port: cfg.port ?? 8080,
    host: cfg.host ?? '127.0.0.1',
    iface: cfg.interface ?? null,
    filter: cfg.filter ?? '',
    pcap: null,
    speed: 1,
    list: false,
    localnet: cfg.localnet ?? null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--port') o.port = Number(next());
    else if (a === '--host') o.host = next();
    else if (a === '--iface' || a === '-i') o.iface = next();
    else if (a === '--filter' || a === '-f') o.filter = next();
    else if (a === '--pcap' || a === '-r') o.pcap = next();
    else if (a === '--speed') o.speed = Number(next()) || 1;
    else if (a === '--localnet') o.localnet = next();
    else if (a === '--list') o.list = true;
    else if (a === '--help' || a === '-h') { console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 11).join('\n')); process.exit(0); }
    else { console.error(`Unknown option ${a}`); process.exit(1); }
  }
  return o;
}

const cfg = readConfig();
const opts = parseArgs(process.argv.slice(2), cfg);

// ---- tshark ----------------------------------------------------------------

function findTshark() {
  const candidates = [
    cfg.tshark,
    'tshark',
    'C:\\Program Files\\Wireshark\\tshark.exe',
    'C:\\Program Files (x86)\\Wireshark\\tshark.exe',
    '/usr/bin/tshark',
    '/usr/local/bin/tshark',
    '/opt/homebrew/bin/tshark',
    '/Applications/Wireshark.app/Contents/MacOS/tshark',
  ].filter(Boolean);
  for (const c of candidates) {
    const r = spawnSync(c, ['-v'], { stdio: 'ignore' });
    if (!r.error && r.status === 0) return c;
  }
  return null;
}

const tshark = findTshark();

if (opts.list) {
  if (!tshark) { console.error('tshark not found. Install Wireshark (with Npcap on Windows).'); process.exit(1); }
  spawnSync(tshark, ['-D'], { stdio: 'inherit' });
  process.exit(0);
}

// ---- packet classification -------------------------------------------------

const FIELDS = ['frame.time_epoch', 'ip.src', 'ip.dst', 'ipv6.src', 'ipv6.dst',
  'arp.src.proto_ipv4', 'arp.dst.proto_ipv4', 'ip.proto', 'frame.len', '_ws.col.protocol'];

const WEB = /^(HTTP|HTTP2|HTTP3|TLS|SSL|QUIC|OCSP)/i;
const DNS = /^(DNS|MDNS|LLMNR|NBNS)$/i;

function classify(proto, ipProto) {
  if (WEB.test(proto)) return 'web';
  if (DNS.test(proto)) return 'dns';
  if (/^(ICMP|ICMPv6)$/i.test(proto) || ipProto === '1' || ipProto === '58') return 'icmp';
  if (ipProto === '6') return 'tcp';
  if (ipProto === '17') return 'udp';
  return 'other';
}

// tunnelled packets report several addresses ("a,b"); use the outermost
const first = (v) => (v ? v.split(',')[0] : '');

function parseLine(line) {
  const f = line.split('\t');
  const src = first(f[1]) || first(f[3]) || first(f[5]);
  const dst = first(f[2]) || first(f[4]) || first(f[6]);
  if (!src || !dst) return null;
  return {
    t: Number(f[0]),
    s: src,
    d: dst,
    c: classify(f[9] || '', first(f[7])),
    b: Number(f[8]) || 0,
  };
}

// ---- name lookup -----------------------------------------------------------

const names = { ...(cfg.names || {}) };
const pending = new Set();

function resolveName(ip, onName) {
  if (names[ip] !== undefined || pending.has(ip)) return;
  // only look up addresses inside the school; skip the public internet
  if (!/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)) return;
  pending.add(ip);
  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 1500));
  Promise.race([dns.reverse(ip), timeout])
    .then((list) => { names[ip] = list[0].split('.')[0]; onName(ip, names[ip]); })
    .catch(() => { names[ip] = ''; })
    .finally(() => pending.delete(ip));
}

// ---- event stream ----------------------------------------------------------

const clients = new Set();
let batch = [];
let live = false;
let liveError = null;
let sourceLabel = null;

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}

setInterval(() => {
  if (batch.length && clients.size) broadcast('packets', batch);
  batch = [];
}, 50);

function onPacket(p) {
  resolveName(p.s, (ip, n) => broadcast('name', { ip, name: n }));
  resolveName(p.d, (ip, n) => broadcast('name', { ip, name: n }));
  if (batch.length < 2000) batch.push(p);
}

function startLive() {
  if (!tshark) { liveError = 'tshark not found (install Wireshark). Showing demo traffic.'; return; }
  const args = ['-l', '-n', '-T', 'fields'];
  for (const f of FIELDS) args.push('-e', f);

  if (opts.pcap) {
    args.push('-r', opts.pcap);
    sourceLabel = path.basename(opts.pcap);
  } else if (opts.iface) {
    args.push('-i', opts.iface);
    if (opts.filter) args.push('-f', opts.filter);
    sourceLabel = `interface ${opts.iface}`;
  } else {
    liveError = 'No interface selected. Showing demo traffic.';
    return;
  }

  const child = spawn(tshark, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  live = true;

  child.stderr.on('data', (d) => {
    const s = d.toString();
    if (/permission|denied|no such device|couldn't|error/i.test(s)) {
      liveError = s.trim().split('\n')[0];
      console.error(s.trim());
    }
  });
  child.on('exit', (code) => {
    live = false;
    if (!liveError && code) liveError = `capture stopped (exit ${code})`;
    broadcast('status', status());
  });
  process.on('exit', () => child.kill());

  const rl = readline.createInterface({ input: child.stdout });
  if (opts.pcap) replay(rl); else rl.on('line', (l) => { const p = parseLine(l); if (p) onPacket(p); });
}

// pace a capture file by its own timestamps
function replay(rl) {
  const queue = [];
  let t0 = null, wall0 = null;
  rl.on('line', (l) => { const p = parseLine(l); if (p) queue.push(p); });
  const timer = setInterval(() => {
    if (!queue.length) return;
    if (t0 === null) { t0 = queue[0].t; wall0 = Date.now(); }
    const elapsed = ((Date.now() - wall0) / 1000) * opts.speed;
    while (queue.length && queue[0].t - t0 <= elapsed) onPacket(queue.shift());
  }, 20);
  timer.unref();
}

// ---- http ------------------------------------------------------------------

const status = () => ({ live, source: sourceLabel, error: liveError, localnet: opts.localnet });

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript',
  '.mjs': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');

  if (url.pathname === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ...status(), names }));
  }

  if (url.pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(`event: status\ndata: ${JSON.stringify(status())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.join(pub, rel);
  if (!file.startsWith(pub + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

startLive();

server.listen(opts.port, opts.host, () => {
  const shown = opts.host === '0.0.0.0' ? 'localhost' : opts.host;
  console.log(`OIP display: http://${shown}:${opts.port}`);
  console.log(live ? `Capturing from ${sourceLabel}` : liveError || 'Demo mode');
  if (opts.host !== '127.0.0.1' && opts.host !== 'localhost') {
    console.log('Listening on the network: anyone who can reach this port can see traffic metadata.');
  }
});
