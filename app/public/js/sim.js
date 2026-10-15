// Traffic model: hosts, the links between them, and packets in flight.
// Pure data and physics. No drawing and no DOM.

export const CATS = {
  web:   { label: 'Web (HTTP/HTTPS)', color: '#56B4E9' },
  dns:   { label: 'DNS',              color: '#F0E442' },
  tcp:   { label: 'Other TCP',        color: '#2FD39B' },
  udp:   { label: 'Other UDP',        color: '#FFA630' },
  icmp:  { label: 'ICMP (ping)',      color: '#FF4D6D' },
  other: { label: 'Other',            color: '#B18CFF' },
};

const MAX_PARTICLES = 1600;
const LINK_BUDGET = 40;          // max packets per second drawn on one link
const NODE_IDLE_SECONDS = 90;

export function isPrivate(ip) {
  if (ip.includes(':')) return /^(fe80|fc|fd)/i.test(ip);
  return /^(10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
}

export function isBroadcast(ip) {
  if (ip.includes(':')) return /^ff/i.test(ip);
  const first = Number(ip.split('.')[0]);
  return (first >= 224 && first <= 239) || ip.endsWith('.255');
}

function groupOf(ip) {
  if (!isPrivate(ip)) return 'internet';
  if (ip.includes(':')) return ip.split(':').slice(0, 4).join(':') + '::/64';
  return ip.split('.').slice(0, 3).join('.') + '.0/24';
}

export class Sim {
  constructor() {
    this.nodes = new Map();
    this.links = new Map();
    this.particles = [];
    this.rings = [];
    this.names = {};
    this.collapseInternet = true;
    this.paused = false;
    this.w = 1920;
    this.h = 1080;
    this.zoom = 1;
    this.scale = 1;
    this.stats = { pps: 0, bps: 0, cat: {} };
    this._acc = { t: 0, pkts: 0, bytes: 0, cat: {} };
  }

  setSize(w, h) {
    this.w = w;
    this.h = h;
    this.updateScale();
  }

  updateScale() {
    this.scale = Math.max(0.5, Math.min(this.w / 1920, this.h / 1080)) * this.zoom;
  }

  clear() {
    this.nodes.clear();
    this.links.clear();
    this.particles.length = 0;
    this.rings.length = 0;
  }

  nodeId(ip) {
    if (this.collapseInternet && !isPrivate(ip)) return 'internet';
    return ip;
  }

  displayName(node) {
    if (node.id === 'internet') return 'Internet';
    return this.names[node.id] || node.id;
  }

  getNode(id, near) {
    let n = this.nodes.get(id);
    if (n) return n;
    const g = id === 'internet' ? 'internet' : groupOf(id);
    const s = this.scale;
    let x, y;
    if (id === 'internet') {
      x = this.w / 2; y = this.h * 0.14;
    } else if (near) {
      x = near.x + (Math.random() - 0.5) * 120 * s;
      y = near.y + (Math.random() - 0.5) * 120 * s;
    } else {
      x = this.w / 2 + (Math.random() - 0.5) * this.w * 0.4;
      y = this.h * 0.6 + (Math.random() - 0.5) * this.h * 0.3;
    }
    n = { id, group: g, x, y, vx: 0, vy: 0, act: 0, bytes: 0, flash: 0, last: 0, age: 0, pinned: false, fixed: id === 'internet' };
    this.nodes.set(id, n);
    return n;
  }

  linkBetween(a, b) {
    const key = a.id < b.id ? a.id + '|' + b.id : b.id + '|' + a.id;
    let l = this.links.get(key);
    if (!l) { l = { a, b, w: 0, tokens: LINK_BUDGET }; this.links.set(key, l); }
    return l;
  }

  // One packet: {s, d, c, b} = source ip, destination ip, category, bytes
  ingest(ev) {
    if (this.paused) return;
    const cat = CATS[ev.c] ? ev.c : 'other';
    const bytes = ev.b || 60;
    this._acc.pkts++;
    this._acc.bytes += bytes;
    this._acc.cat[cat] = (this._acc.cat[cat] || 0) + 1;

    const dstBroadcast = isBroadcast(ev.d);
    const aId = this.nodeId(ev.s);
    const a = this.getNode(aId, this.nodes.get(dstBroadcast ? aId : this.nodeId(ev.d)));
    this.touch(a, bytes);

    if (dstBroadcast) {
      this.rings.push({ node: a, t: 0, color: CATS[cat].color });
      return;
    }

    const bId = this.nodeId(ev.d);
    const b = this.getNode(bId, a);
    this.touch(b, bytes);
    if (a === b) return;

    const link = this.linkBetween(a, b);
    link.w = Math.min(link.w + 1, 60);
    if (link.tokens < 1 || this.particles.length >= MAX_PARTICLES) return;
    link.tokens--;

    this.particles.push({
      a, b, cat,
      t: -Math.random() * 0.06,
      dur: 0.7 + Math.random() * 0.3,
      size: Math.max(0, Math.min(1, Math.log2(bytes / 40) / 5)),
      curve: a.id < b.id ? 1 : -1,
    });
  }

  touch(n, bytes) {
    n.act += Math.max(0.3, Math.min(1, bytes / 1500));
    n.bytes += bytes;
    n.age = 0;
  }

  step(dt) {
    dt = Math.min(dt, 0.05);
    if (this.paused) return;
    const s = this.scale;

    // decay activity, expire idle hosts
    for (const [id, n] of this.nodes) {
      n.act *= Math.exp(-dt / 8);
      n.bytes *= Math.exp(-dt / 5);
      n.flash = Math.max(0, n.flash - dt * 3);
      n.age += dt;
      if (!n.fixed && n.age > NODE_IDLE_SECONDS) this.nodes.delete(id);
    }
    for (const [key, l] of this.links) {
      l.w *= Math.exp(-dt / 10);
      l.tokens = Math.min(LINK_BUDGET, l.tokens + LINK_BUDGET * dt);
      if (l.w < 0.02 || !this.nodes.has(l.a.id) || !this.nodes.has(l.b.id)) this.links.delete(key);
    }

    this.layout(dt, s);

    // packets in flight
    for (const p of this.particles) {
      p.t += dt / p.dur;
      if (p.t >= 1 && !p.done) { p.done = true; p.b.flash = 1; }
    }
    this.particles = this.particles.filter((p) => !p.done);
    for (const r of this.rings) r.t += dt / 1.2;
    this.rings = this.rings.filter((r) => r.t < 1);

    // rolling stats
    const acc = this._acc;
    acc.t += dt;
    if (acc.t >= 0.5) {
      const cat = {};
      for (const k in acc.cat) cat[k] = acc.cat[k] / acc.t;
      this.stats = { pps: acc.pkts / acc.t, bps: (acc.bytes * 8) / acc.t, cat };
      this._acc = { t: 0, pkts: 0, bytes: 0, cat: {} };
    }
  }

  layout(dt, s) {
    const nodes = [...this.nodes.values()];
    const cx = this.w / 2, cy = this.h * 0.58;
    const pad = 0.12;

    // subnet centroids for cohesion
    const groups = new Map();
    for (const n of nodes) {
      let g = groups.get(n.group);
      if (!g) { g = { x: 0, y: 0, c: 0 }; groups.set(n.group, g); }
      g.x += n.x; g.y += n.y; g.c++;
    }
    for (const g of groups.values()) { g.x /= g.c; g.y /= g.c; }
    this.groups = groups;

    const fx = new Map(nodes.map((n) => [n, 0]));
    const fy = new Map(nodes.map((n) => [n, 0]));
    const add = (n, x, y) => { fx.set(n, fx.get(n) + x); fy.set(n, fy.get(n) + y); };

    const rep = 22000 * s * s;
    const reach = 700 * s;
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        let dx = a.x - b.x, dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 > reach * reach) continue;
        if (d2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1; }
        const d = Math.sqrt(d2);
        const f = rep / d2;
        // hosts in different subnets push apart harder so the groups stay readable
        const k = a.group === b.group ? 1 : 1.8;
        add(a, (dx / d) * f * k, (dy / d) * f * k);
        add(b, -(dx / d) * f * k, -(dy / d) * f * k);
      }
    }

    for (const l of this.links.values()) {
      if (l.w < 0.1) continue;
      const dx = l.b.x - l.a.x, dy = l.b.y - l.a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      // the Internet node sits far above the LAN, so its many links are long and soft
      const toNet = l.a.fixed || l.b.fixed;
      const rest = (toNet ? this.h * 0.4 : 180 * s);
      const k = (toNet ? 0.08 : 0.5) * Math.min(1, l.w / 6);
      const f = k * (d - rest);
      add(l.a, (dx / d) * f, (dy / d) * f);
      add(l.b, -(dx / d) * f, -(dy / d) * f);
    }

    // keep whole subnets apart so their outlines don't overlap
    const lan = [...groups.entries()].filter(([name]) => name !== 'internet');
    for (const [, g] of lan) { g.fx = 0; g.fy = 0; }
    for (let i = 0; i < lan.length; i++) {
      for (let j = i + 1; j < lan.length; j++) {
        const a = lan[i][1], b = lan[j][1];
        const dx = a.x - b.x || 0.1, dy = a.y - b.y || 0.1;
        const d = Math.hypot(dx, dy);
        const f = Math.min(120 * s, (12000 * s * s * Math.sqrt(a.c + b.c)) / d);
        a.fx += (dx / d) * f; a.fy += (dy / d) * f;
        b.fx -= (dx / d) * f; b.fy -= (dy / d) * f;
      }
    }

    for (const n of nodes) {
      const g = groups.get(n.group);
      if (g.fx) add(n, g.fx, g.fy);
      add(n, (g.x - n.x) * 0.15, (g.y - n.y) * 0.15);
      add(n, (cx - n.x) * 0.08, (cy - n.y) * 0.08);
    }

    for (const n of nodes) {
      if (n.fixed) {
        n.x += (this.w / 2 - n.x) * Math.min(1, dt * 3);
        n.y += (this.h * 0.14 - n.y) * Math.min(1, dt * 3);
        continue;
      }
      if (n.pinned) { n.vx = n.vy = 0; continue; }
      n.vx = (n.vx + fx.get(n) * dt) * Math.exp(-3.5 * dt);
      n.vy = (n.vy + fy.get(n) * dt) * Math.exp(-3.5 * dt);
      const sp = Math.hypot(n.vx, n.vy), max = 500 * s;
      if (sp > max) { n.vx *= max / sp; n.vy *= max / sp; }
      n.x += n.vx * dt;
      n.y += n.vy * dt;
      n.x = Math.max(this.w * pad, Math.min(this.w * (1 - pad), n.x));
      n.y = Math.max(this.h * 0.2, Math.min(this.h * 0.8, n.y));
    }
  }

  radius(n) {
    const base = Math.min(7 + 3 * Math.sqrt(n.act), 24) + n.flash * 2;
    return base * this.scale * (n.id === 'internet' ? 1.5 : 1);
  }
}
