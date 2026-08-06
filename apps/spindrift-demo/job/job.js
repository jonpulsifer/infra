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
 */
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
log(`plan: ${steps} stepz over ${duration}s, exiting ${exitCode}`);

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
