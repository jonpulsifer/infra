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
 * The "better info": three real panels instead of a mock fleet and a typed
 * deploy log. Runtime answers which host this landed on and how long it has
 * been alive; Environment shows the platform-provided vars changing under a
 * redeploy; Client shows what the browser carries. All three move while the
 * page is open, and they reset across a restart — the thing a demo owes you
 * if it is going to prove the work is dynamic.
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
