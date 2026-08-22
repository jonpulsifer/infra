/**
 * Run — execute a function's source once, here, without deploying it.
 *
 * The source is written to a temp `.mjs` and imported by a worker, rather than
 * evaluated in this thread: an author's `while (true) {}` has to be survivable,
 * and terminating a worker is the only way to take a spinning thread back.
 * The file is unlinked and the worker terminated on every path, including the
 * timeout.
 *
 * This is a preview, not a sandbox. The handler runs with this process's
 * privileges — see `contract.ts` on why trusted-author admission is what makes
 * that acceptable.
 */
import { unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type FunctionLogEntry,
  PREVIEW_TIMEOUT_MS,
  type PreviewRequest,
  type PreviewResult,
} from './contract.ts';
import type { PreviewWorkerMessage } from './preview-worker.ts';

export async function runPreview(
  source: string,
  request: PreviewRequest,
  options: { readonly timeoutMs?: number } = {},
): Promise<PreviewResult> {
  const timeoutMs = options.timeoutMs ?? PREVIEW_TIMEOUT_MS;
  const started = performance.now();
  const logs: FunctionLogEntry[] = [];
  const file = join(tmpdir(), `spindrift-preview-${crypto.randomUUID()}.mjs`);
  // Owner-only: the source sits in a shared tmpdir until the run ends.
  await writeFile(file, source, { mode: 0o600 });

  const worker = new Worker(new URL('./preview-worker.ts', import.meta.url));
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await new Promise<PreviewResult>((resolve) => {
      const settle = (
        outcome: Omit<PreviewResult, 'logs' | 'durationMs'>,
      ): void => {
        resolve({
          ...outcome,
          logs,
          durationMs: Math.round(performance.now() - started),
        });
      };

      timer = setTimeout(() => {
        settle({
          ok: false,
          status: null,
          headers: {},
          body: '',
          truncated: false,
          error: `timed out after ${timeoutMs / 1000}s`,
        });
      }, timeoutMs);

      worker.onmessage = (event: MessageEvent) => {
        const message = event.data as PreviewWorkerMessage;
        if (message.kind === 'log') {
          logs.push(message.entry);
          return;
        }
        if (message.kind === 'done') {
          settle({
            ok: true,
            status: message.status,
            headers: message.headers,
            body: message.body,
            truncated: message.truncated,
            error: null,
          });
          return;
        }
        settle({
          ok: false,
          status: null,
          headers: {},
          body: '',
          truncated: false,
          error: message.message,
        });
      };

      // A worker that dies before answering — an unparseable module, a crash in
      // the runtime itself — would otherwise sit here until the timeout.
      worker.onerror = (event: ErrorEvent) => {
        settle({
          ok: false,
          status: null,
          headers: {},
          body: '',
          truncated: false,
          error: event.message || 'the preview worker failed to start',
        });
      };

      worker.postMessage({ file, request });
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    worker.terminate();
    await unlink(file).catch(() => {});
  }
}
