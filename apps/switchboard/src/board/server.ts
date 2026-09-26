import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { BoardView } from './model.ts';
import { PAGE } from './page.ts';

export interface BoardSource {
  snapshot(): BoardView;
  subscribe(listener: () => void): () => void;
}

export interface BoardServerOptions {
  readonly board: BoardSource;
  /** How often an idle stream sends a ping, so proxies keep it open. */
  readonly heartbeatMs?: number;
  /** How long a burst of changes is gathered into one frame. */
  readonly coalesceMs?: number;
}

/**
 * The board's HTTP surface: the page, a Server-Sent Events stream of full
 * snapshots, the same snapshot as JSON, and a health check. It is read-only;
 * no route changes the PBX.
 */
export function createBoardApp(opts: BoardServerOptions) {
  const { board } = opts;
  const heartbeatMs = opts.heartbeatMs ?? 15_000;
  const coalesceMs = opts.coalesceMs ?? 250;
  const app = new Hono();

  app.get('/healthz', (c) => c.text('ok'));

  app.get('/', (c) => {
    c.header('cache-control', 'no-store');
    c.header(
      'content-security-policy',
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    c.header('referrer-policy', 'no-referrer');
    return c.html(PAGE);
  });

  app.get('/api/board', (c) => {
    c.header('cache-control', 'no-store');
    return c.json(board.snapshot());
  });

  app.get('/events', (c) => {
    c.header('cache-control', 'no-store');
    // Envoy and other proxies buffer a response unless told it streams.
    c.header('x-accel-buffering', 'no');
    return streamSSE(c, async (stream) => {
      let open = true;
      let dirty = true;
      let wake: (() => void) | undefined;
      const unsubscribe = board.subscribe(() => {
        dirty = true;
        wake?.();
      });
      stream.onAbort(() => {
        open = false;
        unsubscribe();
        wake?.();
      });
      while (open) {
        if (dirty) {
          dirty = false;
          await stream.writeSSE({
            event: 'board',
            data: JSON.stringify(board.snapshot()),
          });
        } else {
          await stream.writeSSE({ event: 'ping', data: '' });
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, heartbeatMs);
          wake = done;
          function done() {
            clearTimeout(timer);
            wake = undefined;
            resolve();
          }
        });
        if (open && dirty) await stream.sleep(coalesceMs);
      }
    });
  });

  return app;
}
