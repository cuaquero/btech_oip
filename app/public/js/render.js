// Canvas drawing for the traffic model.

import { CATS } from './sim.js';

const BG = '#070b14';
const GROUP_COLORS = ['#3FB8AF', '#8E7CC3', '#E0A458', '#5C9DE0', '#D16BA5', '#7FB069'];

function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function glowSprite(hex) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const [r, gr, b] = rgb(hex);
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, '#ffffff');
  grad.addColorStop(0.18, `rgb(${r},${gr},${b})`);
  grad.addColorStop(0.5, `rgba(${r},${gr},${b},0.35)`);
  grad.addColorStop(1, `rgba(${r},${gr},${b},0)`);
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return c;
}

export class Renderer {
  constructor(canvas, sim) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.sim = sim;
    this.labels = 'auto'; // auto | all | off
    this.sprites = {};
    for (const k in CATS) this.sprites[k] = glowSprite(CATS[k].color);
    this.groupColor = new Map();
    this.resize();
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = window.innerWidth, h = window.innerHeight;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.dpr = dpr;
    this.sim.setSize(w, h);
  }

  colorForGroup(g) {
    if (g === 'internet') return '#9FB3D1';
    if (!this.groupColor.has(g)) this.groupColor.set(g, GROUP_COLORS[this.groupColor.size % GROUP_COLORS.length]);
    return this.groupColor.get(g);
  }

  position(p, t) {
    const a = p.a, b = p.b;
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const dx = b.x - a.x, dy = b.y - a.y;
    const off = 0.09 * p.curve;
    const cx = mx - dy * off, cy = my + dx * off;
    const u = 1 - t;
    return [u * u * a.x + 2 * u * t * cx + t * t * b.x, u * u * a.y + 2 * u * t * cy + t * t * b.y];
  }

  draw() {
    const { ctx, sim } = this;
    const s = sim.scale;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, sim.w, sim.h);
    const vg = ctx.createRadialGradient(sim.w / 2, sim.h * 0.55, 0, sim.w / 2, sim.h * 0.55, Math.max(sim.w, sim.h) * 0.7);
    vg.addColorStop(0, 'rgba(40,60,110,0.22)');
    vg.addColorStop(1, 'rgba(7,11,20,0)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, sim.w, sim.h);

    this.drawGroups(ctx, s);
    this.drawLinks(ctx, s);
    this.drawParticles(ctx, s);
    this.drawRings(ctx, s);
    this.drawNodes(ctx, s);
  }

  drawGroups(ctx, s) {
    if (!this.sim.groups) return;
    for (const [name, g] of this.sim.groups) {
      if (name === 'internet' || g.c < 2) continue;
      let r = 0;
      for (const n of this.sim.nodes.values()) {
        if (n.group === name) r = Math.max(r, Math.hypot(n.x - g.x, n.y - g.y));
      }
      r += 55 * s;
      const col = this.colorForGroup(name);
      const [cr, cg, cb] = rgb(col);
      const grad = ctx.createRadialGradient(g.x, g.y, r * 0.2, g.x, g.y, r);
      grad.addColorStop(0, `rgba(${cr},${cg},${cb},0.10)`);
      grad.addColorStop(1, `rgba(${cr},${cg},${cb},0.02)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(g.x, g.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.setLineDash([6 * s, 8 * s]);
      ctx.strokeStyle = `rgba(${cr},${cg},${cb},0.28)`;
      ctx.lineWidth = 1.2 * s;
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.font = `600 ${15 * s}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillStyle = `rgba(${cr},${cg},${cb},0.75)`;
      ctx.fillText(this.sim.names[name] || name, g.x, g.y - r - 8 * s);
    }
  }

  drawLinks(ctx, s) {
    ctx.lineWidth = 1.2 * s;
    for (const l of this.sim.links.values()) {
      const a = Math.min(0.28, 0.04 + l.w * 0.03);
      ctx.strokeStyle = `rgba(150,180,230,${a})`;
      ctx.beginPath();
      ctx.moveTo(l.a.x, l.a.y);
      ctx.lineTo(l.b.x, l.b.y);
      ctx.stroke();
    }
  }

  drawParticles(ctx, s) {
    ctx.globalCompositeOperation = 'lighter';
    for (const p of this.sim.particles) {
      if (p.t < 0) continue;
      const sprite = this.sprites[p.cat];
      const head = (9 + 12 * p.size) * s;
      const e = p.t < 0.5 ? 2 * p.t * p.t : 1 - 2 * (1 - p.t) * (1 - p.t); // ease in/out
      for (let i = 0; i < 6; i++) {
        const te = Math.max(0, e - i * 0.028);
        const [x, y] = this.position(p, te);
        const k = 1 - i / 6;
        ctx.globalAlpha = 0.9 * k * k;
        const sz = head * (0.55 + 0.45 * k);
        ctx.drawImage(sprite, x - sz, y - sz, sz * 2, sz * 2);
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  drawRings(ctx, s) {
    ctx.lineWidth = 2 * s;
    for (const r of this.sim.rings) {
      const [cr, cg, cb] = rgb(r.color);
      ctx.strokeStyle = `rgba(${cr},${cg},${cb},${0.6 * (1 - r.t)})`;
      ctx.beginPath();
      ctx.arc(r.node.x, r.node.y, this.sim.radius(r.node) + r.t * 120 * s, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  drawNodes(ctx, s) {
    const sim = this.sim;
    const nodes = [...sim.nodes.values()];
    const top = new Set([...nodes].sort((a, b) => b.bytes - a.bytes).slice(0, 12));

    for (const n of nodes) {
      const r = sim.radius(n);
      const col = this.colorForGroup(n.group);
      const [cr, cg, cb] = rgb(col);
      const fade = Math.max(0, Math.min(1, (90 - n.age) / 20));
      ctx.globalAlpha = fade;

      const halo = ctx.createRadialGradient(n.x, n.y, r * 0.5, n.x, n.y, r * 2.6);
      halo.addColorStop(0, `rgba(${cr},${cg},${cb},${0.25 + 0.35 * n.flash})`);
      halo.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(n.x, n.y, r * 2.6, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = n.flash > 0.01 ? `rgb(${Math.round(18 + 120 * n.flash)},${Math.round(26 + 130 * n.flash)},${Math.round(44 + 140 * n.flash)})` : '#121a2c';
      ctx.strokeStyle = col;
      ctx.lineWidth = 2.5 * s;
      ctx.beginPath();
      ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      const named = sim.names[n.id] || n.id === 'internet';
      const show = this.labels === 'all' || (this.labels === 'auto' && (named || top.has(n)));
      if (show) {
        const text = sim.displayName(n);
        ctx.font = `${named ? 600 : 500} ${16 * s}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.lineJoin = 'round';
        ctx.lineWidth = 5 * s;
        ctx.strokeStyle = 'rgba(7,11,20,0.9)';
        ctx.strokeText(text, n.x, n.y + r + 20 * s);
        ctx.fillStyle = named ? '#f2f6ff' : '#aab6cf';
        ctx.fillText(text, n.x, n.y + r + 20 * s);
      }
    }
    ctx.globalAlpha = 1;
  }

  nodeAt(x, y) {
    let best = null, bd = Infinity;
    for (const n of this.sim.nodes.values()) {
      const d = Math.hypot(n.x - x, n.y - y);
      if (d < Math.max(24 * this.sim.scale, this.sim.radius(n) + 8) && d < bd) { best = n; bd = d; }
    }
    return best;
  }
}
