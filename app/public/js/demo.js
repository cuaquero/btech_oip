// Simulated classroom network. Runs in the browser, so the display works with
// no capture hardware. Background traffic plus a rotating set of short
// scenarios, each with a one-line caption.

const SERVERS = {
  gateway: '10.0.0.1',
  dns: '10.0.0.53',
  files: '10.0.0.20',
  web: '10.0.0.80',
};
const INSTRUCTOR = '10.0.1.10';
const STUDENTS = Array.from({ length: 10 }, (_, i) => `10.0.1.${21 + i}`);
const LAB = Array.from({ length: 6 }, (_, i) => `10.0.2.${11 + i}`);
const PRINTER = '10.0.2.50';
const OUTSIDE = ['203.0.113.10', '203.0.113.44', '198.51.100.7', '198.51.100.88', '192.0.2.15', '203.0.113.200'];

export const DEMO_NAMES = {
  [SERVERS.gateway]: 'Gateway',
  [SERVERS.dns]: 'DNS server',
  [SERVERS.files]: 'File server',
  [SERVERS.web]: 'Web server',
  [INSTRUCTOR]: 'Instructor',
  [PRINTER]: 'Printer',
  '10.0.0.0/24': 'Servers',
  '10.0.1.0/24': 'Classroom',
  '10.0.2.0/24': 'Lab B',
};
STUDENTS.forEach((ip, i) => { DEMO_NAMES[ip] = `Student ${i + 1}`; });
LAB.forEach((ip, i) => { DEMO_NAMES[ip] = `Lab PC ${i + 1}`; });

// extra hosts used only by the address-grid view, spread over several /24s
const CROWD = [];
for (let block = 3; block <= 60; block++) {
  const count = 10 + Math.floor(Math.random() * 45);
  const used = new Set();
  while (used.size < count) used.add(2 + Math.floor(Math.random() * 250));
  for (const host of [...used].sort((a, b) => a - b)) CROWD.push(`10.0.${block}.${host}`);
}
DEMO_NAMES['10.0.3.0/24'] = 'Lab C';
DEMO_NAMES['10.0.4.0/24'] = 'Lab D';
DEMO_NAMES['10.0.5.0/24'] = 'Library';
DEMO_NAMES['10.0.6.0/24'] = 'Wi-Fi';

const pick = (list) => list[Math.floor(Math.random() * list.length)];
const rnd = (a, b) => a + Math.random() * (b - a);

const SCENARIOS = [
  {
    name: 'Web browsing',
    caption: 'Students loading web pages. Each page is a small request out and a run of larger packets back.',
    seconds: 18,
    run(d, dt) { d.chatter(dt, { web: 2.2 }); },
  },
  {
    name: 'DNS lookup',
    caption: 'Before connecting to a site, a computer asks the DNS server for its address. The query goes to the DNS server, the answer comes back, then the web connection starts.',
    seconds: 18,
    run(d, dt) {
      d.chatter(dt, { web: 0.3, dns: 0 });
      d.every(0.5, () => {
        const who = pick([...STUDENTS, ...LAB]);
        const site = pick(OUTSIDE);
        d.emit(who, SERVERS.dns, 'dns', 78);
        d.after(0.5, () => d.emit(SERVERS.dns, who, 'dns', 130));
        d.after(1.2, () => d.web(who, site));
      });
    },
  },
  {
    name: 'Ping sweep',
    caption: 'One computer pings every address on the network. Addresses that are in use answer. This is how a scanner finds live hosts.',
    seconds: 20,
    start(d) {
      // with the grid view, sweep every address of one /24 in order
      d.targets = d.crowd
        ? Array.from({ length: 254 }, (_, i) => `10.0.4.${i + 1}`)
        : [...STUDENTS, INSTRUCTOR, ...LAB.slice(0, 5), PRINTER, SERVERS.gateway, SERVERS.dns, SERVERS.files, SERVERS.web];
      d.cursor = 0;
    },
    run(d, dt) {
      d.chatter(dt, { web: 0.4 });
      d.every(d.crowd ? 0.05 : 0.45, () => {
        const t = d.targets[d.cursor++ % d.targets.length];
        d.emit(LAB[5], t, 'icmp', 74);
        if (!d.crowd || CROWD.includes(t)) d.after(0.25, () => d.emit(t, LAB[5], 'icmp', 74));
      });
    },
  },
  {
    name: 'Port scan',
    caption: 'One computer sends connection attempts to many ports on a single server. Most are refused. A few answer, showing which services are running.',
    seconds: 20,
    run(d, dt) {
      d.chatter(dt, { web: 0.4 });
      d.every(0.07, () => {
        d.emit(LAB[5], SERVERS.files, 'tcp', 60);
        if (Math.random() < 0.18) d.after(0.2, () => d.emit(SERVERS.files, LAB[5], 'tcp', 60));
      });
    },
  },
  {
    name: 'Large file transfer',
    caption: 'One student copying a large file from the file server. Full-size packets in one direction, small acknowledgements back.',
    seconds: 18,
    run(d, dt) {
      d.chatter(dt, { web: 0.5 });
      d.every(0.025, () => d.emit(SERVERS.files, STUDENTS[2], 'tcp', 1500));
      d.every(0.05, () => d.emit(STUDENTS[2], SERVERS.files, 'tcp', 66));
    },
  },
  {
    name: 'Many clients, one server',
    caption: 'Every computer requests the same web server at the same time. The server becomes the busiest host on the network.',
    seconds: 18,
    run(d, dt) {
      d.chatter(dt, { web: 0.2 });
      d.every(0.04, () => {
        const who = pick([...STUDENTS, ...LAB]);
        d.emit(who, SERVERS.web, 'web', 420);
        d.after(0.3, () => d.emit(SERVERS.web, who, 'web', 1400));
      });
    },
  },
];

export class Demo {
  constructor(emit, onCaption) {
    this._emit = emit;
    this.onCaption = onCaption;
    this.t = 0;
    this.queue = [];
    this.timers = new Map();
    this.slot = 0;
    this.crowd = false; // add many more hosts (for the address grid)
    this.index = -1;
    this.scenario = null;
    this.left = 4; // seconds of background traffic before the first scenario
  }

  emit(s, d, c, b) { this._emit({ s, d, c, b }); }
  after(sec, fn) { this.queue.push({ at: this.t + sec, fn }); }

  // run fn every `period` seconds on average (steady rate with a little jitter)
  // (timers are keyed by call order, which is the same every frame)
  every(period, fn) {
    const slot = this.slot++;
    const due = this.timers.get(slot) ?? this.t + rnd(0, period);
    if (this.t >= due) {
      // catch up if a frame was long, but never burst more than a few events
      let n = 0;
      let next = due;
      while (next <= this.t && n++ < 4) { fn(); next += period * rnd(0.6, 1.4); }
      this.timers.set(slot, Math.max(next, this.t));
    } else this.timers.set(slot, due);
  }

  web(client, server) {
    this.emit(client, server, 'web', 90);
    const n = 3 + Math.floor(Math.random() * 6);
    for (let i = 0; i < n; i++) this.after(0.15 + i * 0.07, () => this.emit(server, client, 'web', 900 + Math.random() * 600));
    this.after(0.4, () => this.emit(client, server, 'web', 66));
  }

  // background traffic: rates are per-second events, scaled by `boost`
  chatter(dt, boost = {}) {
    const poisson = (rate) => Math.random() < rate * dt;
    const clients = [...STUDENTS, ...LAB, INSTRUCTOR];
    if (poisson(7 * (boost.web ?? 1))) this.web(pick(clients), pick(OUTSIDE));
    if (poisson(2 * (boost.dns ?? 1))) {
      const who = pick(clients);
      this.emit(who, SERVERS.dns, 'dns', 78);
      this.after(0.3, () => this.emit(SERVERS.dns, who, 'dns', 140));
    }
    if (poisson(0.8)) { const who = pick(clients); this.emit(who, SERVERS.files, 'tcp', 1200); this.after(0.2, () => this.emit(SERVERS.files, who, 'tcp', 66)); }
    if (poisson(0.6)) this.emit(pick(clients), '224.0.0.251', 'dns', 90);       // mDNS
    if (poisson(0.3)) this.emit(pick(LAB), PRINTER, 'tcp', 1000);
    if (poisson(0.25)) this.emit(SERVERS.gateway, pick(clients), 'udp', 120);
    if (poisson(0.2)) this.emit(pick(clients), '10.0.1.255', 'other', 60);     // broadcast
    if (this.crowd) {
      if (poisson(45)) this.web(pick(CROWD), pick(OUTSIDE));
      if (poisson(6)) { const who = pick(CROWD); this.emit(who, SERVERS.dns, 'dns', 78); this.after(0.3, () => this.emit(SERVERS.dns, who, 'dns', 140)); }
      if (poisson(2)) this.emit(pick(CROWD), SERVERS.files, 'tcp', 1200);
    }
  }

  next() {
    this.index = (this.index + 1) % SCENARIOS.length;
    this.scenario = SCENARIOS[this.index];
    this.scenario.start?.(this);
    this.timers.clear();
    this.left = this.scenario.seconds;
    this.onCaption(this.scenario);
  }

  update(dt) {
    this.t += dt;
    this.slot = 0;
    while (this.queue.length) {
      const i = this.queue.findIndex((q) => q.at <= this.t);
      if (i < 0) break;
      this.queue.splice(i, 1)[0].fn();
    }

    this.left -= dt;
    if (this.left <= 0) {
      if (this.scenario) { this.scenario = null; this.timers.clear(); this.left = 5; this.onCaption(null); }
      else this.next();
    }

    if (this.scenario) this.scenario.run(this, dt);
    else this.chatter(dt);
  }
}
