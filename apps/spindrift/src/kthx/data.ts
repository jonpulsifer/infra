/**
 * kthx: the `/_/` surface over Postgres. `underscore.ts` is the contract —
 * refusals, etags, `me`, the socket — and this is the `KthxStore` it reads
 * and writes, one statement per write so the row decides a race, plus the
 * SDK that fronts it all as `window.kthx`.
 */
import { join as pathJoin } from 'node:path';
import { and, asc, eq, sql } from 'drizzle-orm';
import { kthxKv } from '../db/schema.ts';
import type { KthxDeps } from './serve.ts';
import {
  underscoreResponse as answer,
  type KthxStore,
  MAX_LIST,
} from './underscore.ts';

const SDK = pathJoin(import.meta.dir, 'sdk.js');

/** The SDK, the same bytes at apex `/sdk.js` and every site's `/_/sdk.js`. */
export function sdkResponse(): Response {
  return new Response(Bun.file(SDK), {
    headers: {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'public, max-age=300',
    },
  });
}

/**
 * What a site answers under `/_/`, given the decoded path: `undefined` once
 * the socket is Bun's, `null` for a path that is nothing of kthx's.
 */
export function underscoreResponse(
  request: Request,
  pathname: string,
  site: string,
  deps: KthxDeps,
  server: Bun.Server<unknown> | undefined,
): Response | null | undefined | Promise<Response | undefined> {
  if (pathname === '/_/sdk.js') return sdkResponse();
  return answer(request, pathname, site, server, {
    store: storeFor(site, deps),
  });
}

/** The stored value as its JSON text — see `jsonbValue` in the schema. */
const VALUE_TEXT = sql<string>`${kthxKv.value}::text`;

function storeFor(site: string, deps: KthxDeps): KthxStore {
  const at = (key: string) => and(eq(kthxKv.site, site), eq(kthxKv.key, key));
  return {
    list: (prefix) =>
      deps.db
        .select({ key: kthxKv.key, text: VALUE_TEXT })
        .from(kthxKv)
        .where(
          and(
            eq(kthxKv.site, site),
            sql`starts_with(${kthxKv.key}, ${prefix})`,
          ),
        )
        .orderBy(asc(kthxKv.key))
        .limit(MAX_LIST),
    async get(key) {
      const [row] = await deps.db
        .select({ text: VALUE_TEXT, etag: kthxKv.etag })
        .from(kthxKv)
        .where(at(key))
        .limit(1);
      return row;
    },
    async put(key, value, _text, etag, { ifMatch, ifNoneMatch }) {
      const written =
        ifMatch !== null
          ? await deps.db
              .update(kthxKv)
              .set({ value, etag, updatedAt: new Date() })
              .where(
                ifMatch === '*'
                  ? at(key)
                  : and(at(key), eq(kthxKv.etag, ifMatch)),
              )
              .returning({ key: kthxKv.key })
          : ifNoneMatch
            ? await deps.db
                .insert(kthxKv)
                .values({ site, key, value, etag })
                .onConflictDoNothing()
                .returning({ key: kthxKv.key })
            : await deps.db
                .insert(kthxKv)
                .values({ site, key, value, etag })
                .onConflictDoUpdate({
                  target: [kthxKv.site, kthxKv.key],
                  set: { value, etag, updatedAt: new Date() },
                })
                .returning({ key: kthxKv.key });
      return written.length > 0;
    },
    async del(key) {
      await deps.db.delete(kthxKv).where(at(key));
    },
  };
}
