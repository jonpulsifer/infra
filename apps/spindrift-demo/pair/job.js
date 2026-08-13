/**
 * A job that finishes, on purpose, and says who ran it.
 *
 * **This file is not a scope.** It is one of the two entrypoints of one, and
 * the Component that runs it is a `job` because somebody said so at creation —
 * `node job.js`, typed into the entrypoint field — while its sibling runs
 * `server.js` off the same image. Detection could not have proposed either
 * fact: `ladder.ts` types the inferred kind as `Exclude<ComponentKind, 'job'>`
 * because nothing about a tree of files says "run this once and stop", and
 * nothing about one says which of two entrypoints a Component wanted.
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
 * It also leaves a **record** of itself, which `server.js` reads back and
 * renders. That is the pair's whole subject: nothing connects the two
 * Components to each other. They are in one App, one `valkey` Datastore is
 * attached to that App, and so both are handed the same `REDIS_URL` on their
 * next Deploy — neither entrypoint names the other, and neither declares a
 * store.
 *
 * Optional like the rest, and deliberately so: the same image runs on Cloud
 * Run, where there is no Datastore to attach, and a demo that failed there
 * would be demonstrating the wrong thing.
 */
import { connect } from 'node:net';
import { talk } from './resp.js';

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
    // `resp.js`, the same reader `server.js` uses — one scope, so the parser
    // that was duplicated while these were two directories is now imported.
    const [runs] = await talk(connect, process.env.REDIS_URL, [
      ['INCR', 'spindrift-demo:runs'],
      ['LPUSH', 'spindrift-demo:log', record],
      ['LTRIM', 'spindrift-demo:log', 0, 19],
    ]);
    log(`valkey: run #${runs}, record written`);
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
