/**
 * A job that finishes, on purpose, and says who ran it.
 *
 * Detection cannot propose `kind: job` — `ladder.ts` types the inferred kind
 * as `Exclude<ComponentKind, 'job'>`, because nothing about a tree of files
 * says "run this once and stop" rather than "serve this". That is why this
 * scope carries a `spindrift.yaml` and the railpack service demo beside it
 * does not: the file is not a convenience here, it is the only way to say it.
 *
 * Three env vars, all optional, so one image demos every case an operator
 * wants to look at:
 *
 *   DURATION_SECONDS   how long to take (default 15) — long enough to watch
 *                      a run go from started to finished, short enough that a
 *                      `*\/5 * * * *` schedule never overlaps itself
 *   EXIT_CODE          what to exit with (default 0) — set it non-zero to see
 *                      how a failed run surfaces
 *   STEPS              how many progress lines to emit (default 5)
 *
 * `REDIS_URL` is the fourth, and it is not set by an operator: it is what a
 * `valkey` Datastore attached to this App fills, and the name is fixed by the
 * engine rather than chosen here. A run counts itself in it, because a counter
 * that survives the run is the shortest thing that proves the connection was
 * real — a job that merely started is a job that proves the variable parsed.
 *
 * It also leaves a **record** of itself, which the sibling `web/` scope reads
 * back and renders. That is the pair's whole subject: nothing connects these
 * two Components to each other. They are in one App, one `valkey` Datastore is
 * attached to that App, and so both are handed the same `REDIS_URL` on their
 * next Deploy — neither scope names the other, and neither declares a store.
 *
 * Optional like the rest, and deliberately so: the same image runs on Cloud
 * Run, where there is no Datastore to attach, and a demo that failed there
 * would be demonstrating the wrong thing.
 */
import { connect } from 'node:net';

const duration = Number(process.env.DURATION_SECONDS ?? 15);
const exitCode = Number(process.env.EXIT_CODE ?? 0);
const steps = Math.max(1, Number(process.env.STEPS ?? 5));

/**
 * Which backend is this, in its own words.
 *
 * Cloud Run names the execution; a Kubernetes Job leaves the pod name in
 * `HOSTNAME` and nothing else. Reporting whichever is present is how a single
 * run tells you which adapter placed it without anybody consulting the UI.
 */
function whoAmI() {
  const execution = process.env.CLOUD_RUN_EXECUTION;
  if (execution) {
    const task = process.env.CLOUD_RUN_TASK_INDEX ?? '0';
    return `cloudrun execution=${execution} task=${task}`;
  }
  if (process.env.HOSTNAME) return `kubernetes pod=${process.env.HOSTNAME}`;
  return 'unknown backend';
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One RESP array, which is the only way this speaks. */
const encode = (args) =>
  `*${args.length}\r\n${args
    .map((arg) => `$${Buffer.byteLength(String(arg))}\r\n${arg}\r\n`)
    .join('')}`;

/**
 * A few commands down one socket, replies in order.
 *
 * No client library, for the same reason nothing else here has a dependency:
 * the demo is read as much as it is run, and the install that would save
 * writing this is an install that can fail for reasons having nothing to do
 * with Spindrift.
 *
 * ponytail: reads **single-line replies only** — `:<n>` from INCR and LPUSH,
 * `+OK` from LTRIM — by counting `\r\n` terminators, so it cannot parse a bulk
 * string or an array and does not pretend to. That is exactly the set this job
 * sends; the sibling `web/` scope reads and therefore carries a real parser.
 * A `-ERR` line rejects rather than resolving, so a wrong assumption reads as
 * one. Reach for a client the moment a reply here stops being one line.
 */
function talk(url, commands) {
  const { hostname, port } = new URL(url);
  return new Promise((resolve, reject) => {
    const socket = connect({ host: hostname, port: Number(port) || 6379 }, () =>
      socket.write(commands.map(encode).join('')),
    );
    socket.setTimeout(5000);

    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      // Every reply this sends is one line, so a complete response is simply
      // as many terminators as there were commands.
      if (buffer.split('\r\n').length - 1 < commands.length) return;
      socket.end();
      const replies = buffer.split('\r\n').slice(0, commands.length);
      const failure = replies.find((reply) => reply.startsWith('-'));
      if (failure) reject(new Error(failure.slice(1)));
      else resolve(replies);
    });

    socket.once('timeout', () => {
      socket.destroy();
      reject(new Error('timed out after 5s'));
    });
    socket.once('error', reject);
  });
}

const log = (message) =>
  console.log(`[${new Date().toISOString()}] ${message}`);

log(`spindrift-demo-job starting — ${whoAmI()}`);
log(`build: ${process.env.SPINDRIFT_BUILD ?? 'unknown'}`);
log(`plan: ${steps} stepz over ${duration}s, exiting ${exitCode}`);

// Before the work rather than after it: a run that fails on purpose still
// counted, and reading the tally at the top is how the log answers "is this the
// first run since the Datastore was attached" without anyone counting runs.
if (process.env.REDIS_URL) {
  try {
    // The record is JSON so `web/` renders fields rather than re-parsing a
    // sentence this file happened to phrase. Trimmed to the last 20 because an
    // unbounded list is a demo that eventually becomes a memory leak, and 20 is
    // more runs than anybody watches in one sitting.
    const record = JSON.stringify({
      at: new Date().toISOString(),
      backend: whoAmI(),
      build: process.env.SPINDRIFT_BUILD ?? null,
      label: process.env.SPINDRIFT_RUNTIME_LABEL ?? null,
      steps,
      duration,
      exitCode,
    });
    const [runs] = await talk(process.env.REDIS_URL, [
      ['INCR', 'spindrift-demo:runs'],
      ['LPUSH', 'spindrift-demo:log', record],
      ['LTRIM', 'spindrift-demo:log', 0, 19],
    ]);
    log(`valkey: run #${runs.slice(1)}, record written`);
  } catch (error) {
    // Reported and survived. The datastore is what this run *uses*, not what
    // it is for, and a job that died because a cache was unreachable would
    // make every other thing it demonstrates unobservable.
    log(`valkey: unreachable — ${error.message}`);
  }
} else {
  log('valkey: no REDIS_URL, so no Datastore is attached');
}

// Emitted one at a time rather than all at once: the log pane is supposed to
// show a run in progress, and a job that printed everything in the first
// millisecond would look identical to one that had already finished.
for (let step = 1; step <= steps; step++) {
  await sleep((duration / steps) * 1000);
  log(`step ${step}/${steps} done`);
}

if (exitCode === 0) {
  log('finished');
} else {
  // stderr, because a failing run that only ever wrote to stdout is a failing
  // run that looks fine in any tool that separates the two.
  console.error(
    `[${new Date().toISOString()}] failing on purpose with ${exitCode}`,
  );
}

process.exit(exitCode);
