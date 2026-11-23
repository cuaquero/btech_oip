// Stable aliases for network addresses, so a display can show real traffic
// patterns without showing real devices.
//
// Every address is replaced by a fake one that keeps the network's shape:
// hosts that share a real subnet share a fake subnet, a real /16 stays a /16,
// and each fake address gets a random device name. The mapping is keyed by a
// secret that never leaves the server, so aliases stay the same across restarts
// and cannot be reversed from the output.
//
//   private IPv4   a.b.c.d  ->  10.X.Y.Z      (X per /16, Y per /24, Z per host; permutations)
//   public IPv4              ->  198.18.0.0/15 (benchmarking range, never private)
//   private IPv6              ->  fdXX:...      (per /64)
//   public IPv6              ->  2001:db8:...  (documentation range)
//   multicast / broadcast    ->  unchanged

import crypto from 'node:crypto';
import fs from 'node:fs';

const ADJECTIVES = ['Amber', 'Azure', 'Bold', 'Brave', 'Bright', 'Calm', 'Clever', 'Cobalt', 'Coral', 'Cosmic',
  'Crimson', 'Daring', 'Dusty', 'Eager', 'Electric', 'Fancy', 'Fierce', 'Frosty', 'Gentle', 'Golden', 'Happy',
  'Hidden', 'Humble', 'Indigo', 'Jade', 'Jolly', 'Keen', 'Lively', 'Lucky', 'Mellow', 'Mighty', 'Misty', 'Noble',
  'Olive', 'Orange', 'Pale', 'Plucky', 'Proud', 'Quick', 'Quiet', 'Rapid', 'Rustic', 'Scarlet', 'Shiny', 'Silent',
  'Silver', 'Sleepy', 'Snowy', 'Solar', 'Spry', 'Steady', 'Sunny', 'Swift', 'Teal', 'Tidy', 'Velvet', 'Violet',
  'Vivid', 'Warm', 'Wild', 'Windy', 'Witty', 'Zesty', 'Lavender'];

const ANIMALS = ['Falcon', 'Otter', 'Badger', 'Heron', 'Lynx', 'Marmot', 'Osprey', 'Panda', 'Quail', 'Raven',
  'Sparrow', 'Tiger', 'Walrus', 'Yak', 'Zebra', 'Beaver', 'Bison', 'Cobra', 'Dolphin', 'Eagle', 'Ferret', 'Gecko',
  'Hare', 'Ibis', 'Jackal', 'Koala', 'Lemur', 'Moose', 'Newt', 'Ocelot', 'Penguin', 'Robin', 'Salmon', 'Toucan',
  'Urchin', 'Viper', 'Wombat', 'Finch', 'Condor', 'Crane', 'Dingo', 'Egret', 'Gazelle', 'Hedgehog', 'Iguana',
  'Jaguar', 'Kestrel', 'Llama', 'Manatee', 'Narwhal', 'Oriole', 'Puffin', 'Rabbit', 'Seal', 'Turtle', 'Vulture',
  'Weasel', 'Antelope', 'Bat', 'Cricket', 'Fox', 'Goose', 'Hawk', 'Mole'];

const ZONES = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Eta', 'Theta', 'Iota', 'Kappa', 'Lambda',
  'Mu', 'Nu', 'Xi', 'Omicron', 'Pi', 'Rho', 'Sigma', 'Tau', 'Upsilon', 'Phi', 'Chi', 'Psi', 'Omega'];

// Read the alias secret, creating it on first use. It must stay on the server:
// anyone who has it can recompute which alias belongs to which address.
export function loadSecret(file, override) {
  if (override) return Buffer.from(String(override), 'utf8');
  try {
    const hex = fs.readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{64}$/i.test(hex)) return Buffer.from(hex, 'hex');
  } catch { /* create below */ }
  const secret = crypto.randomBytes(32);
  fs.writeFileSync(file, secret.toString('hex') + '\n', { mode: 0o600 });
  return secret;
}

const hex = (n) => n.toString(16);

// "2001:db8::1" -> eight numbers, or null if it is not a valid IPv6 address
function expandV6(ip) {
  const clean = ip.split('%')[0];
  const halves = clean.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 0) return null;
  const parts = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  const nums = parts.map((p) => parseInt(p, 16));
  return nums.length === 8 && nums.every((n) => n >= 0 && n <= 0xffff) ? nums : null;
}

export class Aliaser {
  constructor(secret) {
    this.key = secret;
    this.perms = new Map();     // permutation tables, by label
    this.ip = new Map();        // real address -> fake address (cache)
    this.nets16 = new Map();    // real a.b -> fake second octet
    this.used16 = new Map();    // fake second octet -> real a.b
    this.names = new Map();     // fake address -> alias name
    this.nameOwner = new Map(); // alias name -> fake address
    this.zones = new Map();     // fake /24 -> zone name
    this.zoneOwner = new Map();
  }

  digest(label) {
    return crypto.createHmac('sha256', this.key).update(label).digest();
  }

  // a random but repeatable permutation of 0..n-1 (seeded Fisher-Yates)
  perm(label, n) {
    const hit = this.perms.get(label);
    if (hit) return hit;
    const arr = Array.from({ length: n }, (_, i) => i);
    let block = 0, pos = 32, buf = null;
    const next = () => {
      if (pos + 4 > 32) { buf = this.digest(`${label}#${block++}`); pos = 0; }
      const v = buf.readUInt32BE(pos); pos += 4; return v;
    };
    for (let i = n - 1; i > 0; i--) {
      const j = next() % (i + 1);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    this.perms.set(label, arr);
    return arr;
  }

  // the fake second octet for a real a.b; probes on the rare collision
  net16(a, b) {
    const k = a * 256 + b;
    if (this.nets16.has(k)) return this.nets16.get(k);
    let v = this.digest(`net16:${k}`)[0];
    for (let i = 0; i < 256 && this.used16.has(v) && this.used16.get(v) !== k; i++) v = (v + 1) & 255;
    this.nets16.set(k, v);
    this.used16.set(v, k);
    return v;
  }

  map(real) {
    let out = this.ip.get(real);
    if (out === undefined) {
      if (this.ip.size > 200000) this.ip.clear(); // scans and noise must not grow memory without bound
      out = this.compute(real);
      this.ip.set(real, out);
    }
    return out;
  }

  compute(real) {
    if (real.includes(':')) return this.computeV6(real);
    const o = real.split('.').map(Number);
    if (o.length !== 4 || o.some((n) => !(n >= 0 && n <= 255))) return 'invalid';
    const [a, b, c, d] = o;
    // not real unicast hosts: nothing to hide
    if (a >= 224 || a === 0 || a === 127) return real;
    const priv = a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
    if (!priv) {
      const x = this.digest(`pub:${real}`).readUInt32BE(0);
      return `198.${18 + (x & 1)}.${(x >>> 1) & 255}.${(x >>> 9) % 255}`; // never ends in .255
    }
    const k16 = a * 256 + b;
    const y = this.perm(`p3:${k16}`, 256)[c];
    const z = d === 255 ? 255 : this.perm(`p4:${k16}.${c}`, 255)[d]; // .255 stays a broadcast
    return `10.${this.net16(a, b)}.${y}.${z}`;
  }

  computeV6(real) {
    const h = expandV6(real);
    if (!h) return 'invalid';
    if (h[0] >= 0xff00) return real; // multicast
    if (h.every((n) => n === 0)) return real;
    const priv = (h[0] & 0xffc0) === 0xfe80 || (h[0] & 0xfe00) === 0xfc00;
    const net = this.digest(`net6:${h.slice(0, 4).join(':')}`);
    const host = this.digest(`host6:${h.join(':')}`);
    const tail = [host.readUInt16BE(0), host.readUInt16BE(2), host.readUInt16BE(4), host.readUInt16BE(6)].map(hex);
    if (priv) return ['fd' + net[0].toString(16).padStart(2, '0'), hex(net.readUInt16BE(1)), hex(net.readUInt16BE(3)), '0', ...tail].join(':');
    return ['2001', 'db8', hex(net.readUInt16BE(1)), hex(net.readUInt16BE(3)), ...tail].join(':');
  }

  // "192.168.200.0/24" -> the matching fake network, so the grid's network can be named
  cidr(real) {
    const m = /^(\d+\.\d+\.\d+\.\d+)\/(\d+)$/.exec(real || '');
    if (!m) return null;
    const [a, b, c] = m[1].split('.').map(Number);
    const prefix = Number(m[2]);
    const net16 = this.net16(a, b);
    if (prefix <= 16) return `10.${net16}.0.0/16`;
    return `10.${net16}.${this.perm(`p3:${a * 256 + b}`, 256)[c]}.0/24`;
  }

  // a device-style name such as "Amber Falcon", unique among the names handed out so far
  name(fake) {
    let n = this.names.get(fake);
    if (n) return n;
    const d = this.digest(`name:${fake}`);
    const base = `${ADJECTIVES[d.readUInt16BE(0) % ADJECTIVES.length]} ${ANIMALS[d.readUInt16BE(2) % ANIMALS.length]}`;
    n = base;
    for (let i = 2; this.nameOwner.has(n); i++) n = `${base} ${i}`;
    this.names.set(fake, n);
    this.nameOwner.set(n, fake);
    return n;
  }

  // a network label such as "Zone Gamma" for a fake /24 ("10.12.34.0/24")
  zone(fakeCidr) {
    let z = this.zones.get(fakeCidr);
    if (z) return z;
    let i = this.digest(`zone:${fakeCidr}`)[0] % ZONES.length;
    for (let t = 0; t < ZONES.length && this.zoneOwner.has(ZONES[i]); t++) i = (i + 1) % ZONES.length;
    z = this.zoneOwner.has(ZONES[i]) ? `Zone ${ZONES[i]} ${this.zones.size + 1}` : `Zone ${ZONES[i]}`;
    this.zones.set(fakeCidr, z);
    this.zoneOwner.set(ZONES[i], fakeCidr);
    return z;
  }
}
