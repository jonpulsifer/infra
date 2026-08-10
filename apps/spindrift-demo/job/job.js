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

/**
 * `INCR <key>`, spoken straight down a socket.
 *
 * No client library, for the same reason nothing else here has a dependency:
 * the demo is read as much as it is run, and one command whose reply is a
 * single line is smaller than the install that would save writing it.
 *
 * ponytail: understands exactly one reply — `:<n>`, which is all `INCR` can
 * answer with on success. Anything else is handed back verbatim as an error
 * rather than parsed, so a wrong assumption reads as a wrong assumption. Reach
 * for a real client the moment a second command is wanted.
 */
function incr(url, key) {
  const { hostname, port } = new URL(url);
  return new Promise((resolve, reject) => {
    const socket = connect({ host: hostname, port: Number(port) || 6379 }, () =>
      socket.write(
        `*2\r\n$4\r\nINCR\r\n$${Buffer.byteLength(key)}\r\n${key}\r\n`,
      ),
    );
    socket.setTimeout(5000);
    socket.once('data', (chunk) => {
      socket.end();
      const reply = chunk.toString().trim();
      if (reply.startsWith(':')) resolve(Number(reply.slice(1)));
      else reject(new Error(`unexpected reply: ${reply}`));
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
    const runs = await incr(process.env.REDIS_URL, 'spindrift-demo-job:runs');
    log(`valkey: run #${runs}`);
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
