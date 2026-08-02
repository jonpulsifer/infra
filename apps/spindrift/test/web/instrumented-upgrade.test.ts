/**
 * The telemetry wrapper must stay transparent to a WebSocket upgrade.
 *
 * It sits between `Bun.serve` and every route, including the two stream
 * upgrades in `src/web/streams.ts`. Those need the `server` argument Bun passes
 * second, and they return `undefined` once Bun owns the socket. A wrapper that
 * forwards only the request, or that reads `.status` off the result, answers 500
 * to every stream — which is a build log page that never updates.
 */
import { expect, test } from 'bun:test';
import { instrumentRoutes } from '../../src/web/serve.ts';

test('an instrumented route can still upgrade a WebSocket', async () => {
  const routes = instrumentRoutes({
    '/ws': (request: Request, server: Bun.Server<undefined>) =>
      server.upgrade(request, { data: undefined })
        ? undefined
        : new Response('no upgrade', { status: 400 }),
  });

  const server = Bun.serve<undefined>({
    port: 0,
    routes,
    websocket: {
      open: (socket) => {
        socket.send('open');
      },
      message: () => {},
    },
  });

  try {
    const socket = new WebSocket(`ws://localhost:${server.port}/ws`);
    const first = await new Promise<string>((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), 5_000);
      socket.onmessage = (event) => {
        clearTimeout(timer);
        resolve(String(event.data));
      };
      socket.onclose = () => {
        clearTimeout(timer);
        resolve('closed');
      };
    });
    socket.close();
    expect(first).toBe('open');
  } finally {
    server.stop(true);
  }
});
