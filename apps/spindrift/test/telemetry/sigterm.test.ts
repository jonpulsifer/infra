import { expect, test } from 'bun:test';

/**
 * A SIGTERM listener replaces the default disposition and `Bun.serve` holds the
 * loop open, so the handler has to exit the process itself. Run as a subprocess
 * because a test runner cannot assert its own exit.
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
