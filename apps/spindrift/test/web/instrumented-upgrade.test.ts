// A stream upgrade needs the `server` argument Bun passes second and returns
// `undefined` once Bun owns the socket, so the wrapper must pass both through.
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
