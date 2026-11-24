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
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Aliaser, loadSecret } from './alias.mjs';

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
    ssh: cfg.capture?.ssh ?? null,       // user@host running a forced tcpdump
    sshKey: cfg.capture?.key ?? null,
    publicPort: cfg.publicPort ?? null,  // second listener that only serves aliased data
    publicHost: cfg.publicHost ?? null,
    alias: false,                        // make the main listener aliased too
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
    else if (a === '--ssh') o.ssh = next();
    else if (a === '--ssh-key') o.sshKey = next();
    else if (a === '--public-port') o.publicPort = Number(next());
    else if (a === '--public-host') o.publicHost = next();
    else if (a === '--alias') o.alias = true;
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

// Two kinds of viewers. "raw" viewers get real addresses and names. "alias"
// viewers (the public listener) only ever get aliases: real values are replaced
// before anything is written to them.
const rawClients = new Set();
const aliasClients = new Set();
let batch = [];
let live = false;
let liveError = null;
let sourceLabel = null;
let replayRead = false;    // pcap replay: tshark has read the whole file

const aliaser = (opts.publicPort || opts.alias)
  ? new Aliaser(loadSecret(path.join(here, '.alias-secret'), cfg.aliasSecret))
  : null;
const aliasNames = {};     // fake address or fake /24 -> display name
const newAliasNames = [];  // names alias viewers have not been sent yet

function send(set, event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of set) res.write(msg);
}

// raw viewers only (reverse-DNS names are real)
function broadcast(event, data) { send(rawClients, event, data); }

function broadcastStatus() {
  send(rawClients, 'status', status());
  if (aliaser) send(aliasClients, 'status', aliasStatus());
}

// the alias for one address, naming the fake host and its fake /24 the first time they appear
function aliasAddr(real) {
  const fake = aliaser.map(real);
  if (/^(10\.|fd)/i.test(fake) && aliasNames[fake] === undefined) {
    aliasNames[fake] = aliaser.name(fake);
    newAliasNames.push({ ip: fake, name: aliasNames[fake] });
    if (!fake.includes(':')) {
      const net = fake.replace(/\d+$/, '0') + '/24';
      if (aliasNames[net] === undefined) {
        aliasNames[net] = aliaser.zone(net);
        newAliasNames.push({ ip: net, name: aliasNames[net] });
      }
    }
  }
  return fake;
}

setInterval(() => {
  if (batch.length) {
    if (rawClients.size) send(rawClients, 'packets', batch);
    if (aliaser) {
      // always alias, even with no viewer, so a viewer that connects later gets every name
      // t (capture time) is kept so the page can play packets back at their real rhythm
      const mapped = batch.map((p) => ({ t: p.t, s: aliasAddr(p.s), d: aliasAddr(p.d), c: p.c, b: p.b }));
      const fresh = newAliasNames.splice(0);
      if (aliasClients.size) {
        for (const n of fresh) send(aliasClients, 'name', n);
        send(aliasClients, 'packets', mapped);
      }
    }
  }
  batch = [];
}, 50);

function onPacket(p) {
  if (!opts.alias) {
    resolveName(p.s, (ip, n) => broadcast('name', { ip, name: n }));
    resolveName(p.d, (ip, n) => broadcast('name', { ip, name: n }));
  }
  if (batch.length < 2000) batch.push(p);
}

function startLive() {
  if (!tshark) { liveError = 'tshark not found (install Wireshark). Showing demo traffic.'; return; }
  const args = ['-l', '-n', '-T', 'fields'];
  for (const f of FIELDS) args.push('-e', f);

  if (opts.ssh) {
    startRemote(args);
    return;
  }

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
    if (!liveError && code) liveError = `capture stopped (exit ${code})`;
    // tshark reads a whole file almost at once; the replay below keeps the source live until it drains
    if (opts.pcap && !code) { replayRead = true; return; }
    live = false;
    broadcastStatus();
  });
  process.on('exit', () => child.kill());

  const rl = readline.createInterface({ input: child.stdout });
  if (opts.pcap) replay(rl); else rl.on('line', (l) => { const p = parseLine(l); if (p) onPacket(p); });
}

// Capture on another machine (e.g. a firewall) over SSH. The remote end is
// expected to run a single forced tcpdump that writes a pcap stream to stdout;
// tshark here reads that stream from stdin.
function startRemote(baseArgs) {
  const host = opts.ssh.split('@').pop();
  const key = opts.sshKey && opts.sshKey.replace(/^~/, os.homedir());
  // the capture's own SSH session crosses the monitored link; keep it out of the display
  const hide = /^\d+\.\d+\.\d+\.\d+$/.test(host) ? ['-Y', `not (tcp.port == 22 and ip.addr == ${host})`] : [];
  // `-i -` reads a live pcap stream from stdin (`-r -` waits for end of file on Linux)
  const tsArgs = [...baseArgs, ...hide, '-i', '-'];
  sourceLabel = `${opts.ssh} (SSH capture)`;

  let fails = 0;
  const connect = () => {
    let gotData = false;
    let lastErr = '';
    const sshArgs = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15',
      '-o', 'ServerAliveCountMax=3', '-o', 'PreferredAuthentications=publickey'];
    if (key) sshArgs.push('-i', key, '-o', 'IdentitiesOnly=yes');
    sshArgs.push(opts.ssh, 'capture');

    const ssh = spawn('ssh', sshArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    const ts = spawn(tshark, tsArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
    ssh.stdout.pipe(ts.stdin);
    ts.stdin.on('error', () => {});
    live = true;
    liveError = null;
    broadcastStatus();

    ssh.stderr.on('data', (d) => {
      const line = d.toString().trim().split('\n').pop();
      if (line && !/^tcpdump: (listening|verbose)/.test(line)) lastErr = line;
    });
    readline.createInterface({ input: ts.stdout }).on('line', (l) => {
      const p = parseLine(l);
      if (p) { gotData = true; onPacket(p); }
    });
    ts.stderr.on('data', (d) => {
      const line = d.toString().trim().split('\n').pop();
      if (line && !/^Capturing on/.test(line)) lastErr = `tshark: ${line}`;
    });
    // if the parser dies the stream is useless, so drop the connection and start over
    ts.on('exit', () => ssh.kill());

    ssh.on('exit', (code) => {
      ts.kill();
      live = false;
      const authFailed = /permission denied|host key verification|no matching|too many authentication/i.test(lastErr);
      fails = gotData ? 0 : fails + 1;
      // a refused key is never retried: repeated failed logins can trigger a remote lockout
      if (authFailed) {
        liveError = `SSH capture stopped: ${lastErr}. Not retrying; fix it and restart.`;
        console.error(liveError);
        broadcastStatus();
        return;
      }
      // anything else (network down, remote reboot) retries with a growing delay, capped at 5 minutes
      const delay = Math.min(300, 5 * 2 ** fails);
      liveError = `SSH capture lost (${lastErr || 'exit ' + code}). Retrying in ${delay}s.`;
      console.error(liveError);
      broadcastStatus();
      setTimeout(connect, delay * 1000);
    });
    process.on('exit', () => { ssh.kill(); ts.kill(); });
  };
  connect();
}

// pace a capture file by its own timestamps
function replay(rl) {
  const queue = [];
  let t0 = null, wall0 = null;
  rl.on('line', (l) => { const p = parseLine(l); if (p) queue.push(p); });
  const timer = setInterval(() => {
    if (!queue.length) {
      // everything read and played: the replay is over
      if (replayRead) { live = false; broadcastStatus(); clearInterval(timer); }
      return;
    }
    if (t0 === null) { t0 = queue[0].t; wall0 = Date.now(); }
    const elapsed = ((Date.now() - wall0) / 1000) * opts.speed;
    while (queue.length && queue[0].t - t0 <= elapsed) {
      const p = queue.shift();
      p.t = Date.now() / 1000; // the file's timestamps are old; the replay's own clock is what viewers should see
      onPacket(p);
    }
  }, 20);
  timer.unref();
}

// ---- http ------------------------------------------------------------------

const status = () => ({ live, source: sourceLabel, error: liveError, localnet: opts.localnet });

// what an alias viewer may know: no addresses, hostnames, interface, user or error text
const aliasStatus = () => ({
  live,
  source: live ? 'Live capture' : null,
  error: liveError ? 'Live capture is not available' : null,
  localnet: opts.localnet ? aliaser.cidr(opts.localnet) : null,
});

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript',
  '.mjs': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
};

function makeHandler(aliased) {
  return (req, res) => {
    const url = new URL(req.url, 'http://x');

    if (url.pathname === '/api/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(aliased ? { ...aliasStatus(), names: aliasNames } : { ...status(), names }));
    }

    if (url.pathname === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(`event: status\ndata: ${JSON.stringify(aliased ? aliasStatus() : status())}\n\n`);
      if (aliased) {
        for (const [ip, name] of Object.entries(aliasNames)) res.write(`event: name\ndata: ${JSON.stringify({ ip, name })}\n\n`);
      }
      const set = aliased ? aliasClients : rawClients;
      set.add(res);
      req.on('close', () => set.delete(res));
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
  };
}

startLive();

if (opts.publicPort && opts.publicPort === opts.port) {
  console.error('publicPort must differ from port');
  process.exit(1);
}

const shown = (h) => (h === '0.0.0.0' ? 'localhost' : h);
const isLocal = (h) => h === '127.0.0.1' || h === 'localhost';

http.createServer(makeHandler(opts.alias)).listen(opts.port, opts.host, () => {
  console.log(`OIP display${opts.alias ? ' (aliased)' : ''}: http://${shown(opts.host)}:${opts.port}`);
  console.log(live ? `Capturing from ${sourceLabel}` : liveError || 'Demo mode');
  if (!isLocal(opts.host)) {
    console.log(opts.alias
      ? 'Listening on the network. Only aliased data is served.'
      : 'Listening on the network: anyone who can reach this port can see traffic metadata.');
  }
});

if (opts.publicPort) {
  const host = opts.publicHost ?? opts.host;
  http.createServer(makeHandler(true)).listen(opts.publicPort, host, () => {
    console.log(`OIP public display (aliased only): http://${shown(host)}:${opts.publicPort}`);
    console.log('Real addresses and names never leave this process on that port.');
  });
}
