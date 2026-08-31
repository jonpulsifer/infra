import { expect, test } from 'bun:test';

/**
 * The web process has to end when Kubernetes asks it to.
 *
 * `initTelemetry` registers a SIGTERM handler to flush the exporter, and
 * registering one replaces the signal's default disposition — nothing ends the
 * process once the handler returns, and `Bun.serve` holds the loop open. The
 * pod then sat for the full 30s grace period and left on a SIGKILL, which put
 * a second copy of a single-replica process beside the old one for the whole
 * window. `web` keeps its rate-limit buckets and its bundle cache in its own
 * memory, so two of it is two of both.
 *
 * Driven as a subprocess, because the assertion is that the process exits and
 * a test runner cannot make that claim about itself.
 */
test('a served process with a telemetry-style SIGTERM handler exits on SIGTERM', async () => {
  const child = Bun.spawn(
    [
      'bun',
      '-e',
      `
      const server = Bun.serve({ port: 0, fetch: () => new Response('ok') });
      process.on('SIGTERM', async () => {
        // Stand in for sdkInstance.shutdown(): async, and resolves.
        await new Promise((resolve) => setTimeout(resolve, 10));
        process.exit(0);
      });
      console.log('ready');
      setInterval(() => {}, 1000);
      `,
    ],
    { stdout: 'pipe', stderr: 'ignore' },
  );

  // Wait for the server to be listening before signalling it.
  const reader = child.stdout.getReader();
  await reader.read();
  reader.releaseLock();

  child.kill('SIGTERM');
  const exited = await Promise.race([
    child.exited,
    Bun.sleep(5000).then(() => 'timed out' as const),
  ]);
  if (exited === 'timed out') child.kill('SIGKILL');
  expect(exited).toBe(0);
});
