// Address-grid view: every address in one IPv4 network is a square, laid out
// along a Z-order curve so neighbouring addresses sit next to each other and
// every subnet is a solid block. Packets light the square of the local host.

import { CATS } from './sim.js';

const FADE_SECONDS = 8;
const BASE = [12, 19, 34];

export function ipToInt(ip) {
  const p = ip.split('.');
  if (p.length !== 4) return null;
  let n = 0;
  for (const o of p) {
    const v = Number(o);
    if (!(v >= 0 && v <= 255)) return null;
    n = n * 256 + v;
  }
  return n;
}

export function intToIp(n) {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

function parseCidr(s) {
  const m = /^(\d+\.\d+\.\d+\.\d+)\/(\d+)$/.exec(s || '');
  if (!m) return null;
  let prefix = Number(m[2]);
  const ip = ipToInt(m[1]);
  if (ip === null) return null;
  prefix = Math.min(24, Math.max(16, prefix)); // a /16 at most, a /24 at least
  const size = 2 ** (32 - prefix);
  return { base: Math.floor(ip / size) * size, prefix };
}

// bit-interleave: even bits of the offset give x, odd bits give y
function interleave(x, y) {
  let n = 0;
  for (let i = 0; i < 16; i++) n |= (((x >> i) & 1) << (2 * i)) | (((y >> i) & 1) << (2 * i + 1));
  return n;
}
function deinterleave(n) {
  let x = 0, y = 0;
  for (let i = 0; i < 16; i++) { x |= ((n >> (2 * i)) & 1) << i; y |= ((n >> (2 * i + 1)) & 1) << i; }
  return [x, y];
}

const CAT_RGB = {};
for (const [k, c] of Object.entries(CATS)) {
  const n = parseInt(c.color.slice(1), 16);
  CAT_RGB[k] = [(n >> 16) & 255, (n >> 8) & 255, (n >> 0) & 255].map((v) => v / 255);
}

export class GridView {
  constructor(sim) {
    this.sim = sim;
    this.net = null;          // { base, prefix }
    this.fixedNet = false;    // set from config or URL; otherwise auto-detected
    this.votes = new Map();   // private /16 -> packet count, for auto-detect
    this.hover = null;        // cell offset
    this.selected = null;     // /24 block index within the network
    this.rect = { x: 0, y: 0, size: 0 };
    this.t = 0;
    this.blockSeen = new Float64Array(256).fill(-1e9);
    this.layout = null;
  }

  setNetwork(cidr, fixed = false) {
    const net = parseCidr(cidr);
    if (!net) return false;
    this.net = net;
    this.fixedNet = fixed;
    // grid side is a power of two; an odd number of host bits gets one extra row of blocks
    const bits = 32 - net.prefix;
    this.side = 2 ** Math.ceil(bits / 2);
    this.cells = this.side * this.side;
    this.rgb = new Float32Array(this.cells * 3);
    this.bytes = new Float32Array(this.cells);
    this.seen = new Float64Array(this.cells).fill(-1e9);
    this.img = new ImageData(this.side, this.side);
    this.buf = document.createElement('canvas');
    this.buf.width = this.buf.height = this.side;
    this.bctx = this.buf.getContext('2d');
    this.blockSeen.fill(-1e9);
    this.selected = null;
    this.size = 2 ** bits;
    return true;
  }

  clear() {
    this.votes.clear();
    if (!this.fixedNet) this.net = null;
    else this.setNetwork(`${intToIp(this.net.base)}/${this.net.prefix}`, true);
  }

  label() {
    return this.net ? `${intToIp(this.net.base)}/${this.net.prefix}` : '';
  }

  ingest(ev) {
    const s = ipToInt(ev.s), d = ipToInt(ev.d);
    if (s === null && d === null) return;

    if (!this.net) {
      // pick the busiest private /16 once there is enough traffic to judge
      for (const ip of [s, d]) {
        if (ip === null) continue;
        const a = ip >>> 24, b = (ip >>> 16) & 255;
        if (a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b < 32)) {
          const key = a * 256 + b;
          this.votes.set(key, (this.votes.get(key) || 0) + 1);
        }
      }
      let best = null, n = 0;
      for (const [k, v] of this.votes) if (v > n) { best = k; n = v; }
      if (n < 40) return;
      this.setNetwork(`${best >> 8}.${best & 255}.0.0/16`);
    }

    const light = (ip) => {
      const off = ip - this.net.base;
      if (off < 0 || off >= this.size) return;
      const [x, y] = deinterleave(off);
      if (x >= this.side || y >= this.side) return;
      const i = y * this.side + x;
      const k = Math.max(0.35, Math.min(1, (ev.b || 60) / 1500));
      const c = CAT_RGB[ev.c] || CAT_RGB.other;
      for (let j = 0; j < 3; j++) this.rgb[i * 3 + j] = Math.min(1.2, this.rgb[i * 3 + j] + c[j] * k);
      this.bytes[i] += ev.b || 60;
      this.seen[i] = this.t;
      this.blockSeen[(off >> 8) & 255] = this.t;
    };
    if (s !== null) light(s);
    if (d !== null) light(d);
  }

  step(dt) {
    this.t += dt;
    if (!this.net) return;
    const f = Math.exp(-dt / FADE_SECONDS), fb = Math.exp(-dt / 5);
    const rgb = this.rgb, bytes = this.bytes;
    for (let i = 0; i < rgb.length; i++) rgb[i] *= f;
    for (let i = 0; i < bytes.length; i++) bytes[i] *= fb;
  }

  cellIp(off) { return intToIp(this.net.base + off); }

  // offset of the cell under a screen point, or null
  cellAt(px, py) {
    if (!this.net) return null;
    const { x, y, size } = this.rect;
    if (px < x || py < y || px >= x + size || py >= y + size) return null;
    const cs = size / this.side;
    const cx = Math.floor((px - x) / cs), cy = Math.floor((py - y) / cs);
    const off = interleave(cx, cy);
    return off < this.size ? off : null;
  }

  select(off) {
    this.selected = off === null ? null : off >> 8;
  }

  draw(ctx, w, h, scale) {
    ctx.fillStyle = '#070b14';
    ctx.fillRect(0, 0, w, h);

    if (!this.net) {
      ctx.fillStyle = '#9aa8c4';
      ctx.textAlign = 'center';
      ctx.font = `${22 * scale}px system-ui, sans-serif`;
      ctx.fillText('Waiting for traffic on a private network', w / 2, h / 2);
      ctx.font = `${15 * scale}px system-ui, sans-serif`;
      ctx.fillText('Set "localnet" in config.json to choose the network', w / 2, h / 2 + 30 * scale);
      return;
    }

    const avail = Math.min(w * 0.8, h * 0.72);
    // whole pixels when they fit nicely, fractional otherwise so a /16 still fills the screen
    const px = Math.max(1, avail / this.side >= 6 ? Math.floor(avail / this.side) : avail / this.side);
    const size = Math.round(px * this.side);
    const x0 = Math.round((w - size) / 2), y0 = Math.round(h * 0.12);
    this.rect = { x: x0, y: y0, size };

    // fill the pixel buffer
    const data = this.img.data, rgb = this.rgb;
    for (let i = 0, n = this.cells; i < n; i++) {
      const o = i * 4, k = i * 3;
      // soft tone-map on brightness only, so a square keeps the color of its traffic
      const r = rgb[k], g = rgb[k + 1], bl = rgb[k + 2];
      const m = Math.max(r, g, bl);
      const t = m > 1e-4 ? (1 - Math.exp(-m * 2.2)) / m : 0;
      data[o] = BASE[0] + (255 - BASE[0]) * Math.min(1, r * t);
      data[o + 1] = BASE[1] + (255 - BASE[1]) * Math.min(1, g * t);
      data[o + 2] = BASE[2] + (255 - BASE[2]) * Math.min(1, bl * t);
      data[o + 3] = 255;
    }
    this.bctx.putImageData(this.img, 0, 0);

    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.buf, x0, y0, size, size);

    // soft bloom so single active squares are visible from the back of a room
    if ('filter' in ctx) {
      ctx.save();
      ctx.filter = `blur(${Math.max(3, px * 2.6)}px)`;
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.55;
      ctx.drawImage(this.buf, x0, y0, size, size);
      ctx.restore();
    }

    // subnet blocks: each /24 is a 16x16 square
    const block = 16 * px;
    const blocksPerSide = this.side / 16;
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(150,180,230,0.16)';
    ctx.beginPath();
    for (let i = 0; i <= blocksPerSide; i++) {
      ctx.moveTo(x0 + i * block + 0.5, y0); ctx.lineTo(x0 + i * block + 0.5, y0 + size);
      ctx.moveTo(x0, y0 + i * block + 0.5); ctx.lineTo(x0 + size, y0 + i * block + 0.5);
    }
    ctx.stroke();
    ctx.strokeStyle = 'rgba(150,180,230,0.5)';
    ctx.strokeRect(x0 + 0.5, y0 + 0.5, size, size);

    // labels for blocks that have been active recently
    const roomy = block >= 60 * scale; // enough space for a label inside the block
    const showAll = block > 90 * scale;
    ctx.font = `600 ${Math.min(13 * scale, block * 0.22)}px system-ui, sans-serif`;
    ctx.textAlign = 'left';
    for (let by = 0; by < blocksPerSide; by++) {
      for (let bx = 0; bx < blocksPerSide; bx++) {
        const idx = interleave(bx, by);
        if (idx * 256 >= this.size) continue;
        const named = this.sim.names[this.blockCidr(idx)];
        const active = this.t - this.blockSeen[idx] < 30;
        if (!(named || (roomy && (showAll || active)))) continue;
        const text = named || this.blockCidr(idx).replace(/\.0\/24$/, '.x');
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(7,11,20,0.85)';
        ctx.lineJoin = 'round';
        ctx.strokeText(text, x0 + bx * block + 4, y0 + by * block + 14 * scale);
        ctx.fillStyle = active ? 'rgba(230,238,255,0.85)' : 'rgba(150,170,205,0.55)';
        ctx.fillText(text, x0 + bx * block + 4, y0 + by * block + 14 * scale);
      }
    }

    // selection and hover
    if (this.selected !== null) {
      const [bx, by] = deinterleave(this.selected);
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#ffffff';
      ctx.strokeRect(x0 + bx * block, y0 + by * block, block, block);
    }
    if (this.hover !== null) {
      const [cx, cy] = deinterleave(this.hover);
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#ffffff';
      ctx.strokeRect(x0 + cx * px - 1, y0 + cy * px - 1, px + 2, px + 2);
    }

    ctx.fillStyle = '#9aa8c4';
    ctx.textAlign = 'center';
    ctx.font = `${14 * scale}px system-ui, sans-serif`;
    ctx.fillText(`${this.label()}  ·  each square is one address, each block is a /24`, w / 2, y0 + size + 24 * scale);
  }

  blockCidr(idx) {
    return `${intToIp(this.net.base + idx * 256).replace(/\d+$/, '0')}/24`;
  }

  // details for the hover tooltip
  describe(off) {
    const ip = this.cellIp(off);
    const rate = this.bytes[this.yx(off)] / 5;
    const idle = this.t - this.seen[this.yx(off)];
    return { ip, name: this.sim.names[ip] || '', rate, idle };
  }

  yx(off) {
    const [x, y] = deinterleave(off);
    return y * this.side + x;
  }

  // busiest hosts in the selected /24
  blockSummary() {
    if (this.selected === null) return null;
    const hosts = [];
    let total = 0;
    for (let i = 0; i < 256; i++) {
      const off = this.selected * 256 + i;
      if (off >= this.size) break;
      const b = this.bytes[this.yx(off)];
      total += b;
      if (b > 30) hosts.push({ ip: this.cellIp(off), name: this.sim.names[this.cellIp(off)] || '', rate: b / 5 });
    }
    hosts.sort((a, b) => b.rate - a.rate);
    return { cidr: this.blockCidr(this.selected), name: this.sim.names[this.blockCidr(this.selected)] || '', total: total / 5, count: hosts.length, hosts: hosts.slice(0, 8) };
  }
}
