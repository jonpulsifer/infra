// The pair's service entrypoint: renders the runs job.js records in Valkey. Both
// Components get the same REDIS_URL from the valkey Datastore on their App.
// Deploy as a service (a website gets no REDIS_URL); no spindrift.yaml, as its two Components differ in kind.
// Node built-ins only and no Dockerfile: railpack builds it with this directory as context.

import { createServer } from 'node:http';
import { connect } from 'node:net';
import { hostname } from 'node:os';
import { talk } from './resp.js';

const port = Number(process.env.PORT) || 3000;
const startedAt = new Date();

// Must match the keys job.js writes.
const COUNTER = 'spindrift-demo:runs';
const LOG = 'spindrift-demo:log';

// `unattached` means no REDIS_URL: no valkey Datastore, or no Deploy since one
// was attached.
async function readStore() {
  const url = process.env.REDIS_URL;
  if (!url) return { state: 'unattached' };
  try {
    const [runs, entries] = await talk(connect, url, [
      ['GET', COUNTER],
      ['LRANGE', LOG, 0, -1],
    ]);
    return {
      state: 'attached',
      runs: runs === null ? 0 : Number(runs),
      log: (entries ?? []).map((entry) => {
        try {
          return { parsed: JSON.parse(entry) };
        } catch {
          return { raw: entry };
        }
      }),
    };
  } catch (error) {
    return { state: 'unreachable', detail: error.message };
  }
}

function platform() {
  const env = process.env;
  if (env.KUBERNETES_SERVICE_HOST) return 'Kubernetes';
  if (env.K_SERVICE || env.CLOUD_RUN_JOB) return 'Google Cloud Run';
  return 'unknown backend';
}

const html = (text) =>
  String(text).replace(
    /[&<>"]/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character],
  );

const STYLE = `
:root{color-scheme:light dark;--ink:#0c1d23;--dim:#5b7480;--paper:#eceff0;--card:#f7f9f9;--rule:#c3d0d2;--accent:#0e6e78}
@media(prefers-color-scheme:dark){:root{--ink:#dbe8e9;--dim:#8ba4ab;--paper:#08161b;--card:#0e2229;--rule:#21414c;--accent:#59c6d0}}
*{box-sizing:border-box;margin:0}
body{background:var(--paper);color:var(--ink);font:16px/1.5 ui-sans-serif,system-ui,sans-serif;padding:clamp(1.5rem,5vw,4rem);max-width:62rem;margin:0 auto}
h1{font-size:clamp(1.6rem,4vw,2.4rem);letter-spacing:-.02em;margin-bottom:.35rem}
.lede{color:var(--dim);max-width:56ch;margin-bottom:2rem}
.count{font-variant-numeric:tabular-nums;font-size:clamp(2.5rem,9vw,4.5rem);line-height:1;color:var(--accent);font-weight:600}
.note{border-left:3px solid var(--accent);padding:.75rem 1rem;background:var(--card);margin:1.5rem 0;max-width:60ch}
.note.warn{border-color:#a81b5f}
table{border-collapse:collapse;width:100%;margin-top:1rem;font-size:.9rem}
th,td{text-align:left;padding:.5rem .75rem;border-bottom:1px solid var(--rule)}
th{font-size:.7rem;text-transform:uppercase;letter-spacing:.1em;color:var(--dim);font-weight:500}
td.m{font-family:ui-monospace,monospace;font-size:.82rem}
footer{margin-top:3rem;padding-top:1rem;border-top:1px solid var(--rule);color:var(--dim);font-size:.8rem;display:flex;gap:1.5rem;flex-wrap:wrap}
`;

function render(store) {
  const rows =
    store.state === 'attached' && store.log.length > 0
      ? store.log
          .map((entry) => {
            if (entry.raw) {
              return `<tr><td colspan="4" class="m">${html(entry.raw)}</td></tr>`;
            }
            const run = entry.parsed;
            return `<tr>
              <td class="m">${html(run.at ?? '—')}</td>
              <td class="m">${html(run.backend ?? '—')}</td>
              <td class="m">${html(run.build ?? '—')}</td>
              <td class="m">${html(run.exitCode ?? '—')}</td>
            </tr>`;
          })
          .join('')
      : '';

  const body =
    store.state === 'unattached'
      ? `<div class="note warn"><b>No Datastore is attached.</b> This Component was
         handed no <code>REDIS_URL</code>, so there is nothing to read. Attach a
         <code>valkey</code> Datastore to this App and deploy again — an attach
         does not roll anything, so the data appears on the <em>next</em> Deploy
         and not before.</div>`
      : store.state === 'unreachable'
        ? `<div class="note warn"><b>A store is attached but did not answer.</b>
           <code>${html(store.detail)}</code></div>`
        : `<p class="count">${store.runs}</p>
           <p class="lede">runs recorded by the <code>job</code> Component.</p>
           ${
             rows === ''
               ? `<div class="note">The store is attached and empty. Press
                  <b>Run now</b> on the <code>job</code> Component and reload.</div>`
               : `<table><thead><tr><th>When</th><th>Backend that ran it</th>
                  <th>Build</th><th>Exit</th></tr></thead><tbody>${rows}</tbody></table>`
}`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<!-- The page is watched while a job runs, so it refreshes itself. -->
<meta http-equiv="refresh" content="5" />
<title>spindrift-demo — web</title><style>${STYLE}</style></head>
<body>
<h1>What the job wrote</h1>
<p class="lede">Two Components in one App. Neither names the other and neither
declares a store — they are handed the same <code>REDIS_URL</code> because one
<code>valkey</code> Datastore is attached to the App they share.</p>
${body}
<footer>
  <span>service on ${html(platform())}</span>
  <span>host ${html(process.env.HOSTNAME ?? hostname())}</span>
  <span>build ${html(process.env.SPINDRIFT_BUILD ?? 'unknown')}</span>
  <span>up ${Math.round((Date.now() - startedAt.getTime()) / 1000)}s</span>
</footer>
</body></html>`;
}

createServer((request, response) => {
  const path = new URL(request.url, `http://${request.headers.host}`).pathname;

  // Answered before the store is read, so a missing Datastore never fails a probe.
  if (path === '/healthz') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true, since: startedAt.toISOString() }));
    return;
  }

  readStore().then((store) => {
    if (path === '/__runtime__') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ platform: platform(), store }, null, 2));
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(render(store));
  });
}).listen(port, () => {
  console.log(`spindrift-demo-web on :${port} — ${platform()}`);
  console.log(
    process.env.REDIS_URL
      ? 'REDIS_URL is set, so a Datastore is attached'
      : 'no REDIS_URL, so no Datastore is attached',
  );
});
