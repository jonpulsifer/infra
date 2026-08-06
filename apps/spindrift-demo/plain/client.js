/* ── load time ───────────────────────────────────────────────────────────── */

document.getElementById('load-time').textContent = new Date().toISOString();

/* ── spray canvas ────────────────────────────────────────────────────────── */

const canvas = document.getElementById('spray');
const ctx = canvas.getContext('2d');

let width;
let height;
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
  for (const p of particles) {
    p.update();
    p.draw();
  }
  requestAnimationFrame(frame);
}
frame();

/* ── runtime info ───────────────────────────────────────────────────────────
 *
 * Plain has no server, so runtime.js answers the platform from the URL and
 * honestly reports that the environment is unreadable. The Client panel is
 * the one that moves for this scope.
 */

const rt = window.SpinRuntime;
const runtimePanel = document.getElementById('runtime-panel');
const environmentPanel = document.querySelector('.envbook');
const clientPanel = document.getElementById('client-panel');
if (rt) {
  if (runtimePanel) rt.renderRuntime(runtimePanel);
  if (environmentPanel) rt.renderEnv(environmentPanel);
  if (clientPanel) rt.renderClient(clientPanel);
}

/* ── render time ─────────────────────────────────────────────────────────── */

const renderMs = Math.round(performance.now());
document.getElementById('render-ms').textContent = renderMs;
