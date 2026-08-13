/**
 * The other half of a pair, and the only scope here that reads what another
 * one wrote.
 *
 * Every other scope in this directory proves something about exactly one path
 * and shares nothing with its neighbours. This one shares a **Datastore** with
 * `job/` — and shares no code with it, names it nowhere, and declares no store
 * of its own. That absence is the subject:
 *
 *   A Datastore attaches to the **App**, never to a Component
 *   (`attachDatastore({datastoreId, appId})`). Its connection arrives as a
 *   variable whose name is fixed by the engine and is never a field —
 *   `REDIS_URL` for valkey, `DATABASE_URL` for postgres
 *   (`apps/spindrift/src/domain/desired-state.ts`). So every Component in the
 *   App is handed it on its next Deploy, and two Components sharing state need
 *   no wiring between them because there is nothing to wire.
 *
 * Which is why this file has no configuration for where the job's data is. It
 * reads two fixed keys out of whatever `REDIS_URL` points at, and if nothing
 * points anywhere it says so in those terms rather than erroring — the
 * unattached state is half of what the demo demonstrates, because an attach
 * does not roll anything and the data appears on the *next* Deploy.
 *
 * It must be a `service` rather than a `website`, and that is not a preference:
 * a website is static files served by the Target, with no process and no
 * environment, so no connection string can reach one. The `src/` and `plain/`
 * scopes are that side of the line.
 *
 * Node built-ins only, like its neighbours — a dependency here would prove
 * railpack can install one and would also make the demo fail, the first time a
 * registry is slow, for a reason that has nothing to do with Spindrift. No
 * Dockerfile either, so `buildkit.ts`'s `[ -f Dockerfile ]` switch routes this
 * scope through railpack; and no `spindrift.yaml`, because detection infers
 * `service` on its own and a file asserting it would remove the inference.
 */

import { createServer } from 'node:http';
import { connect } from 'node:net';
import { hostname } from 'node:os';
import { talk } from './resp.js';

const port = Number(process.env.PORT) || 3000;
const startedAt = new Date();

/** Fixed, because `job/` writes them and neither scope configures the other. */
const COUNTER = 'spindrift-demo:runs';
const LOG = 'spindrift-demo:log';

/**
 * What the job left, or why there is nothing.
 *
 * Three states, all of them true things to render: no store attached, a store
 * attached but unreachable, and a store with data in it. The first is not an
 * error — it is what every Component of this App looks like until a `valkey`
 * Datastore is attached *and* a Deploy has happened since.
 */
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
      // A record this scope cannot read is shown as itself rather than
      // dropped: a malformed entry is evidence about the writer, and hiding it
      // would make the page lie about what is in the list.
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

/** Which hosting platform this is, by the marker that says so. */
function platform() {
  const env = process.env;
  if (env.KUBERNETES_SERVICE_HOST) return 'Kubernetes';
  if (env.K_SERVICE || env.CLOUD_RUN_JOB) return 'Google Cloud Run';
  return 'unknown backend';
}

// ---------------------------------------------------------------------------
// the page
// ---------------------------------------------------------------------------

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

  // Cheap and independent of the store, so a probe pointed here does not go
  // red because a Datastore is missing — this Component is up either way.
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
