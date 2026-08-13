/**
 * PROTOTYPE server — `bun run src/web/prototype-build-dev.ts`.
 *
 * Serves the workspace prototype with no database and no session. Two fakes,
 * both deliberately shallow:
 *
 * - `/internal/upload` runs the **real** `normalizeArchive`, so a ZIP is
 *   genuinely transcoded and the digest returned is the digest a live
 *   installation would stage. Nothing is written anywhere.
 * - `/internal/commands/*` answers from `test/fixtures/scenarios.ts`, so the
 *   Releases tab has rows to render variant B against.
 *
 * Throwaway. Delete with `views/apps/prototype-new-build.tsx`.
 */
import { normalizeArchive } from '../storage/archive-format.ts';
import index from './client/prototype-build.html';
import type { DeployLedgerItem } from './model.ts';

const PORT = 8201;

/** Enough releases for variant B to sit above something real. */
const LEDGER: readonly DeployLedgerItem[] = [3, 2, 1].map((n) => ({
  id: 900 + n,
  appId: 'app-bluenose',
  app: 'slides',
  buildId: 40 + n,
  componentId: 'component-deck',
  component: 'deck',
  targetId: 'target-bluenose',
  target: 'bluenose/static',
  phase: 'LIVE',
  commit: `sha256:${'0'.repeat(6)}${n}`.slice(0, 14),
  configVersion: `4f53cda${n}`,
  when: n === 3 ? 'active' : 'past',
  at: `2026-08-${10 + n}T12:44:00.000Z`,
  current: n === 3,
  rollbackable: n !== 3,
}));

const server = Bun.serve({
  port: PORT,
  development: true,
  routes: { '/': index },
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/internal/upload' && request.method === 'POST') {
      const filename = request.headers.get('x-filename') ?? 'upload.zip';
      const bytes = new Uint8Array(await request.arrayBuffer());
      try {
        const archive = normalizeArchive(filename, bytes);
        const digest = new Bun.CryptoHasher('sha256')
          .update(archive.bytes)
          .digest('hex');
        return Response.json({
          ok: true,
          value: {
            digest: `sha256:${digest}`,
            location: `gs://prototype-depot/${archive.filename}`,
            filename: archive.filename,
            size: archive.bytes.length,
          },
        });
      } catch (error: unknown) {
        return Response.json(
          {
            ok: false,
            failure: {
              code: 'UNKNOWN_FORMAT',
              message: error instanceof Error ? error.message : 'refused',
            },
          },
          { status: 400 },
        );
      }
    }

    if (url.pathname.startsWith('/internal/commands/')) {
      const name = url.pathname.slice('/internal/commands/'.length);
      if (name === 'listDeploys') {
        return Response.json({
          ok: true,
          value: { deploys: LEDGER, nextBefore: null },
        });
      }
      return Response.json({ ok: true, value: {} });
    }

    return new Response('not found', { status: 404 });
  },
});

console.log(`prototype: ${server.url}?variant=A`);
