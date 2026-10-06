// The pair's job entrypoint: logs who ran it, emits STEPS progress lines over
// DURATION_SECONDS, records the run in Valkey for server.js, and exits EXIT_CODE.
import { connect } from 'node:net';
import { talk } from './resp.js';

const duration = Number(process.env.DURATION_SECONDS ?? 15);
const exitCode = Number(process.env.EXIT_CODE ?? 0);
const steps = Math.max(1, Number(process.env.STEPS ?? 5));

// Cloud Run names the execution; a Kubernetes Job only leaves the pod name in HOSTNAME.
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

// A valkey Datastore attached to the App sets REDIS_URL. It is optional because
// Cloud Run has no Datastore to attach.
if (process.env.REDIS_URL) {
  try {
    const record = JSON.stringify({
      at: new Date().toISOString(),
      backend: whoAmI(),
      build: process.env.SPINDRIFT_BUILD ?? null,
      label: process.env.SPINDRIFT_RUNTIME_LABEL ?? null,
      steps,
      duration,
      exitCode,
    });
    const [runs] = await talk(connect, process.env.REDIS_URL, [
      ['INCR', 'spindrift-demo:runs'],
      ['LPUSH', 'spindrift-demo:log', record],
      // Keep the newest 20 records so the list stays bounded.
      ['LTRIM', 'spindrift-demo:log', 0, 19],
    ]);
    log(`valkey: run #${runs}, record written`);
  } catch (error) {
    // A datastore failure is logged and the job keeps running.
    log(`valkey: unreachable — ${error.message}`);
  }
} else {
  log('valkey: no REDIS_URL, so no Datastore is attached');
}

for (let step = 1; step <= steps; step++) {
  await sleep((duration / steps) * 1000);
  log(`step ${step}/${steps} done`);
}

if (exitCode === 0) {
  log('finished');
} else {
  console.error(
    `[${new Date().toISOString()}] failing on purpose with ${exitCode}`,
  );
}

process.exit(exitCode);
