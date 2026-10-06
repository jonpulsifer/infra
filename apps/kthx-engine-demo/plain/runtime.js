// Renders the runtime, environment and client panels from the facts serve.ts
// injects as window.__SPINDRIFT_RUNTIME__, or from the URL host when there is no server.

// A platform with no logo here renders UNKNOWN_MARK.
const LOGOS = {
  'firebase-app-hosting': 'logos/firebase.svg',
  'firebase-hosting': 'logos/firebase.svg',
  'cloud-run': 'logos/google-cloud.svg',
  kubernetes: 'logos/kubernetes.svg',
  'cloudflare-pages': 'logos/cloudflare.svg',
  'cloudflare-workers': 'logos/cloudflare-workers.svg',
  vercel: 'logos/vercel.svg',
  aws: 'logos/aws.svg',
  unknown: null,
};

const UNKNOWN_MARK =
  '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18"/></svg>';

const serverFacts = window.__SPINDRIFT_RUNTIME__ ?? null;

function detectFromHost(host) {
  const h = host.toLowerCase();
  if (h.endsWith('.vercel.app'))
    return { id: 'vercel', name: 'Vercel', by: 'hostname' };
  if (h.endsWith('.pages.dev'))
    return { id: 'cloudflare-pages', name: 'Cloudflare Pages', by: 'hostname' };
  if (h.endsWith('.web.app') || h.endsWith('.firebaseapp.com'))
    return { id: 'firebase-hosting', name: 'Firebase Hosting', by: 'hostname' };
  if (h.endsWith('.run.app'))
    return { id: 'cloud-run', name: 'Google Cloud Run', by: 'hostname' };
  if (h.endsWith('.cloudfunctions.net'))
    return { id: 'cloud-run', name: 'Google Cloud Functions', by: 'hostname' };
  return null;
}

function platform() {
  const s = serverFacts?.server;
  if (s) return { id: s.platform, name: s.platformName, by: s.detectedBy };
  const fromHost = detectFromHost(location.host);
  if (fromHost) return fromHost;
  if (location.protocol === 'file:')
    return { id: 'unknown', name: 'Local file', by: 'protocol' };
  return { id: 'unknown', name: location.host || 'unknown', by: 'hostname' };
}

/** Fills the panel's `data-rt-*` elements. */
function renderRuntime(panel) {
  const plat = platform();
  const logo = LOGOS[plat.id] ?? null;
  const logoEl = panel.querySelector('[data-rt-logo]');
  if (logoEl) {
    logoEl.innerHTML = logo
      ? `<img src="${logo}" alt="${plat.name}" width="28" height="28">`
      : UNKNOWN_MARK;
  }
  setText(panel, 'rt-platform', plat.name);
  setText(panel, 'rt-detected', plat.by);

  const s = serverFacts?.server;
  if (s) {
    setText(panel, 'rt-hostname', s.hostname);
    setText(panel, 'rt-pid', String(s.pid));
    setText(panel, 'rt-port', String(s.port));
    setText(panel, 'rt-runtime', s.runtime);
    setText(panel, 'rt-os', s.os);
    setText(panel, 'rt-started', s.startedAt);
    setText(panel, 'rt-build', s.build ?? '—');
    setText(panel, 'rt-utcnow', s.utcNow);
  } else {
    setText(panel, 'rt-hostname', location.hostname);
    hide(panel, 'rt-pid-row');
    hide(panel, 'rt-port-row');
    hide(panel, 'rt-runtime-row');
    hide(panel, 'rt-os-row');
    setText(panel, 'rt-started', '(no server runtime — bare static host)');
    setText(panel, 'rt-build', '—');
  }

  if (s?.startedAt) {
    const started = new Date(s.startedAt).getTime();
    const upEl = panel.querySelector('[data-rt-uptime]');
    const tick = () => {
      if (upEl) upEl.textContent = humanUptime(Date.now() - started);
    };
    tick();
    setInterval(tick, 1000);
  } else {
    setText(panel, 'rt-uptime', '—');
  }
}

function renderEnv(panel) {
  const env = serverFacts?.env;
  const list = panel.querySelector('[data-rt-env]');
  if (!list) return;
  if (!env) {
    list.innerHTML =
      '<div class="env-empty">No server — environment is not visible to a bare static host.</div>';
    return;
  }
  if (env.names.length === 0) {
    list.innerHTML =
      '<div class="env-empty">No recognised platform variables are set.</div>';
    return;
  }
  const row = (name, value) =>
    `<div class="env-row env-valued"><span class="env-name">${escapeHtml(name)}</span><code class="env-value">${escapeHtml(value === '' ? '(empty)' : value)}</code></div>`;
  list.innerHTML = env.names
    .map((name) => row(name, env.values[name]))
    .join('');
  const count = panel.querySelector('[data-rt-env-count]');
  if (count) count.textContent = String(env.names.length);
}

function renderClient(panel) {
  const n = navigator;
  const ua = n.userAgent;
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Chrome\//.test(ua)
      ? 'Chrome'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'unknown';
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /Mac OS X/.test(ua)
      ? 'macOS'
      : /Android/.test(ua)
        ? 'Android'
        : /(iPhone|iPad|iOS)/.test(ua)
          ? 'iOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : 'unknown';
  setText(panel, 'c-browser', `${browser} ${os}`);
  setText(panel, 'c-href', location.href);
  setText(panel, 'c-lang', n.language);
  setText(
    panel,
    'c-screen',
    `${window.screen.width}×${window.screen.height} · ${window.screen.colorDepth}-bit`,
  );
  setText(panel, 'c-cores', String(n.hardwareConcurrency ?? '—'));
  setText(panel, 'c-mem', n.deviceMemory ? `${n.deviceMemory} GB` : '—');
  setText(panel, 'c-dpr', String(window.devicePixelRatio ?? 1));
  const conn = n.connection || n.mozConnection || n.webkitConnection;
  setText(
    panel,
    'c-net',
    conn ? `${conn.effectiveType ?? '—'} · ${conn.downlink ?? '—'}Mbps` : '—',
  );
}

function setText(panel, key, value) {
  const el = panel.querySelector(`[data-${key}]`);
  if (el) el.textContent = value;
}
function hide(panel, key) {
  const el = panel.querySelector(`[data-${key}]`);
  if (el) el.style.display = 'none';
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[char],
  );
}

/** Formats `ms` as `1h 04m 03s`. */
function humanUptime(ms) {
  const s = Math.floor(ms / 1000) % 60;
  const m = Math.floor(ms / 60000) % 60;
  const h = Math.floor(ms / 3600000);
  const dd = (n) => String(n).padStart(2, '0');
  return `${h}h ${dd(m)}m ${dd(s)}s`;
}

// client.js is a separate classic script, so the renderers go on a global.
window.SpinRuntime = { renderRuntime, renderEnv, renderClient };
