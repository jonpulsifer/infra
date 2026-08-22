/**
 * The other side of {@link runPreview}: a worker that imports one module and
 * calls its handler once.
 *
 * A worker rather than a `vm` or a subprocess because the isolation that
 * matters here is *time*, not privilege — the author is an enrolled operator,
 * so what has to be survivable is `while (true) {}`, and a worker is the one
 * primitive whose thread the parent can terminate outright. Everything the
 * handler can reach, this process can reach.
 *
 * Console is hooked rather than piped: the parent shows the author their own
 * `console.log` next to the response, and a hook keeps each line's timestamp
 * and level instead of reassembling them out of interleaved stdout.
 */
import {
  FUNCTION_CONTRACT,
  type FunctionEnv,
  type FunctionLogEntry,
  PREVIEW_BODY_LIMIT,
  type PreviewRequest,
} from './contract.ts';

/** What the parent sends, and what it hears back. */
interface PreviewJob {
  readonly file: string;
  readonly request: PreviewRequest;
  /** The function's saved environment, as the handler's second argument. */
  readonly env: FunctionEnv;
}

export type PreviewWorkerMessage =
  | { readonly kind: 'log'; readonly entry: FunctionLogEntry }
  | {
      readonly kind: 'done';
      readonly status: number;
      readonly headers: Record<string, string>;
      readonly body: string;
      readonly truncated: boolean;
    }
  | { readonly kind: 'error'; readonly message: string };

/**
 * The worker globals, named rather than inferred: this file is typed against
 * the DOM lib the rest of the app uses, where `postMessage` is the window's
 * three-argument one.
 */
const worker = globalThis as unknown as {
  postMessage: (message: PreviewWorkerMessage) => void;
  onmessage: ((event: { data: PreviewJob }) => void) | null;
};

const LEVELS = ['log', 'info', 'warn', 'error', 'debug'] as const;

/** One console argument as a line fragment. Objects go through JSON. */
function render(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack ?? value.message;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

for (const level of LEVELS) {
  console[level] = (...args: unknown[]) => {
    worker.postMessage({
      kind: 'log',
      entry: {
        at: new Date().toISOString(),
        line: args.map(render).join(' '),
        level,
      },
    });
  };
}

/** `https://preview.local/...` — one origin, so a handler reading `request.url` sees a real one. */
const PREVIEW_ORIGIN = 'https://preview.local';

async function run(job: PreviewJob): Promise<void> {
  // The cache key has to change per run or a second Run after an edit would
  // re-execute the first version of the module.
  const module: unknown = await import(
    `${Bun.pathToFileURL(job.file).href}?t=${Date.now()}`
  );
  const handler = (module as { default?: { fetch?: unknown } }).default;
  if (handler === undefined || typeof handler.fetch !== 'function') {
    throw new Error(`the module does not \`${FUNCTION_CONTRACT}\``);
  }

  const method = job.request.method.toUpperCase();
  const request = new Request(
    new URL(job.request.path || '/', PREVIEW_ORIGIN),
    {
      method,
      headers: job.request.headers ?? {},
      ...(method === 'GET' ||
      method === 'HEAD' ||
      job.request.body === undefined
        ? {}
        : { body: job.request.body }),
    },
  );

  const response: unknown = await (
    handler.fetch as (
      request: Request,
      env: unknown,
      context: unknown,
    ) => unknown
  )(request, job.env, { waitUntil() {} });
  if (!(response instanceof Response)) {
    throw new Error(
      'the handler resolved with something other than a Response',
    );
  }

  const text = await response.text();
  worker.postMessage({
    kind: 'done',
    status: response.status,
    headers: Object.fromEntries(response.headers),
    body: text.slice(0, PREVIEW_BODY_LIMIT),
    truncated: text.length > PREVIEW_BODY_LIMIT,
  });
}

worker.onmessage = (event) => {
  run(event.data).catch((cause: unknown) => {
    worker.postMessage({
      kind: 'error',
      message:
        cause instanceof Error ? (cause.stack ?? cause.message) : String(cause),
    });
  });
};
