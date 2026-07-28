/* ── spray canvas ────────────────────────────────────────────────────────── */

const canvas = document.getElementById('spray');
const ctx = canvas.getContext('2d');

let width, height;
const particles = [];
const MAX = 50;

function resize() {
  width = canvas.width = window.innerWidth;
  height = canvas.height = window.innerHeight;
}
resize();
window.addEventListener('resize', resize);

class Spray {
  constructor() {
    this.reset(true);
  }
  reset(init) {
    this.x = Math.random() * width;
    this.y = init ? Math.random() * height : height + 10;
    this.r = Math.random() * 2 + 0.5;
    this.vx = (Math.random() - 0.5) * 0.4;
    this.vy = -(Math.random() * 0.6 + 0.2);
    this.life = 1;
    this.decay = Math.random() * 0.005 + 0.003;
    this.opacity = Math.random() * 0.5 + 0.2;
  }
  update() {
    this.x += this.vx;
    this.y += this.vy;
    this.life -= this.decay;
    if (this.life <= 0) this.reset(false);
  }
  draw() {
    ctx.beginPath();
    ctx.arc(this.x, this.y, this.r, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(60,198,208,${(this.life * this.opacity).toFixed(3)})`;
    ctx.fill();
  }
}

for (let i = 0; i < MAX; i++) particles.push(new Spray());

function frame() {
  ctx.clearRect(0, 0, width, height);
  for (const p of particles) { p.update(); p.draw(); }
  requestAnimationFrame(frame);
}
frame();

/* ── vessel fleet ────────────────────────────────────────────────────────── */

const VESSELS = [
  { name: 'wave-rider',     kind: 'ingress',    status: 'ok' },
  { name: 'spray-collector', kind: 'daemonset', status: 'ok' },
  { name: 'foam-dispenser',  kind: 'deploy',    status: 'ok' },
  { name: 'salt-harvester',  kind: 'statefulset', status: 'warn' },
  { name: 'tide-gauger',     kind: 'cronjob',   status: 'ok' },
  { name: 'reef-monitor',    kind: 'deploy',    status: 'ok' },
];

const vesselsEl = document.getElementById('vessels');

for (const v of VESSELS) {
  const card = document.createElement('div');
  card.className = 'vessel';

  const dot = document.createElement('span');
  dot.className = `vessel-dot ${v.status}${v.status === 'ok' ? ' pulse' : ''}`;

  const info = document.createElement('div');
  info.className = 'vessel-info';

  const name = document.createElement('span');
  name.className = 'vessel-name';
  name.textContent = v.name;

  const meta = document.createElement('span');
  meta.className = 'vessel-meta';
  meta.textContent = `${v.kind} · ${v.status === 'ok' ? 'healthy' : v.status === 'warn' ? 'degraded' : 'down'}`;

  info.append(name, meta);
  card.append(dot, info);
  vesselsEl.appendChild(card);
}

/* ── deploy log ──────────────────────────────────────────────────────────── */

const LOG_LINES = [
  { cls: 'info',  text: '$ spindrift reconcile --fleet' },
  { cls: 'faint', text: '  scanning git tree ...' },
  { cls: 'ok',    text: '  ✓ 6 manifests discovered (2.1 KiB)' },
  { cls: 'faint', text: '  diffing against live state ...' },
  { cls: 'info',  text: '  → wave-rider: no drift' },
  { cls: 'info',  text: '  → spray-collector: no drift' },
  { cls: 'info',  text: '  → foam-dispenser: no drift' },
  { cls: 'warn',  text: '  → salt-harvester: 1 replica pending (image pull)' },
  { cls: 'info',  text: '  → tide-gauger: no drift' },
  { cls: 'info',  text: '  → reef-monitor: no drift' },
  { cls: 'faint', text: '  reconciling ...' },
  { cls: 'ok',    text: '  ✓ cluster converged (847 ms)' },
  { cls: 'faint', text: '  ---' },
  { cls: 'info',  text: '  static assets ready for liftoff.' },
  { cls: 'ok',    text: '  🚀 deploy complete.' },
];

const terminalLines = document.getElementById('terminal-lines');
const cursor = document.querySelector('.cursor');

let lineIdx = 0;
let charIdx = 0;
let currentLineEl = null;

function typeNext() {
  if (lineIdx >= LOG_LINES.length) {
    cursor.style.display = 'none';
    return;
  }

  const entry = LOG_LINES[lineIdx];

  if (charIdx === 0) {
    currentLineEl = document.createElement('div');
    currentLineEl.className = `line ${entry.cls}`;
    terminalLines.appendChild(currentLineEl);
  }

  currentLineEl.textContent += entry.text[charIdx];
  charIdx++;

  terminalLines.parentElement.scrollTop = terminalLines.parentElement.scrollHeight;

  if (charIdx >= entry.text.length) {
    lineIdx++;
    charIdx = 0;
    setTimeout(typeNext, 120);
  } else {
    const delay = entry.text[charIdx - 1] === ' ' ? 30 : 18 + Math.random() * 25;
    setTimeout(typeNext, delay);
  }
}

setTimeout(typeNext, 400);

/* ── render time ─────────────────────────────────────────────────────────── */

const renderMs = Math.round(performance.now());
document.getElementById('render-ms').textContent = renderMs;
