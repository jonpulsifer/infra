/**
 * Reads kthx's engine surface: its sites, and the names the engine reserves
 * there. A call never throws; a failure is one sentence an operator reads.
 */
import { z } from 'zod';
import type { Fetcher, TokenProvider } from './deploy/cloud/http.ts';

export type KthxRead<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string };

export interface KthxTaken {
  readonly name: string;
  readonly by: 'site' | 'app';
}

export interface KthxSitePage {
  readonly total: number;
  readonly items: readonly KthxSite[];
  readonly next: string | null;
}

export interface KthxSite {
  readonly name: string;
  readonly url: string;
  readonly owner: string | null;
  readonly serving: number | null;
  readonly held: boolean;
  readonly created: string;
  readonly deployed: string | null;
  readonly provisioned: boolean;
}

export interface KthxSiteDetail extends KthxSite {
  readonly releases: readonly {
    n: number;
    digest: string;
    size: number;
    at: string;
  }[];
  readonly usage: {
    dbBytes: number;
    filesBytes: number;
    aiRequestsToday: number;
    aiTokensToday: number;
  };
  readonly quotas: {
    docBytes: number;
    dbBytes: number;
    fileBytes: number;
    filesBytes: number;
    aiRequestsDay: number;
    aiTokensDay: number;
  };
}

export interface KthxClient {
  /** The DNS zone kthx serves sites under, restated so no call is needed. */
  readonly zone: string;
  listSites(page: {
    after: string | null;
    limit: number;
  }): Promise<KthxRead<KthxSitePage>>;
  getSite(name: string): Promise<KthxRead<KthxSiteDetail | 'missing'>>;
  /** `[]` when every label is now this holder's. */
  reserve(
    holder: string,
    labels: readonly string[],
  ): Promise<KthxRead<readonly KthxTaken[]>>;
  /** `null` releases every label the holder has. */
  release(
    holder: string,
    labels: readonly string[] | null,
  ): Promise<KthxRead<readonly string[]>>;
}

export interface KthxClientOptions {
  /** The control host's origin, such as `https://kthx.example`. */
  readonly url: string;
  readonly zone: string;
  /** The engine's audience-scoped token, read per call since it rotates. */
  readonly token: TokenProvider;
  readonly fetch?: Fetcher;
  /** Milliseconds; tests shorten them. */
  readonly timeouts?: { readonly list: number; readonly call: number };
}

const TIMEOUTS = { list: 3_000, call: 5_000 } as const;

export const KTHX_BODY_LIMIT = 1024 * 1024;

/** The most names kthx takes in one reserve. */
export const RESERVE_BATCH = 32;

const site = z.object({
  name: z.string(),
  url: z.string(),
  owner: z.string().nullable(),
  serving: z.number().int().nullable(),
  held: z.boolean(),
  created: z.string(),
  deployed: z.string().nullable(),
  provisioned: z.boolean(),
});

const sitePage = z.object({
  total: z.number().int(),
  items: z.array(site),
  next: z.string().nullable(),
});

const siteDetail = site.extend({
  releases: z.array(
    z.object({
      n: z.number().int(),
      digest: z.string(),
      size: z.number(),
      at: z.string(),
    }),
  ),
  usage: z.object({
    db_bytes: z.number(),
    files_bytes: z.number(),
    ai_requests_today: z.number(),
    ai_tokens_today: z.number(),
  }),
  quotas: z.object({
    doc_bytes: z.number(),
    db_bytes: z.number(),
    file_bytes: z.number(),
    files_bytes: z.number(),
    ai_requests_day: z.number(),
    ai_tokens_day: z.number(),
  }),
});

const taken = z.object({
  taken: z.array(z.object({ name: z.string(), by: z.enum(['site', 'app']) })),
});

const released = z.object({ released: z.array(z.string()) });

type Answer =
  | { readonly ok: true; readonly status: number; readonly body: unknown }
  | { readonly ok: false; readonly reason: string };

export function kthxClient(options: KthxClientOptions): KthxClient {
  const origin = options.url.replace(/\/+$/, '');
  const send = options.fetch ?? fetch;
  const timeouts = options.timeouts ?? TIMEOUTS;

  async function call(
    method: string,
    path: string,
    timeout: number,
    body?: unknown,
  ): Promise<Answer> {
    let token: string;
    try {
      token = await options.token();
    } catch {
      return { ok: false, reason: 'the engine could not read its kthx token' };
    }
    const signal = AbortSignal.timeout(timeout);
    try {
      const response = await send(
        new Request(`${origin}${path}`, {
          method,
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${token}`,
            ...(body === undefined
              ? {}
              : { 'Content-Type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          redirect: 'error',
          signal,
        }),
      );
      const text = await readCapped(response, KTHX_BODY_LIMIT);
      if (text === null) {
        return { ok: false, reason: 'kthx answered with more than 1 MiB' };
      }
      return { ok: true, status: response.status, body: parsed(text) };
    } catch (error) {
      if (signal.aborted) {
        return {
          ok: false,
          reason: `kthx did not answer within ${seconds(timeout)}`,
        };
      }
      const detail = error instanceof Error ? `: ${error.message}` : '';
      return { ok: false, reason: `kthx could not be reached${detail}` };
    }
  }

  return {
    zone: options.zone,

    async listSites(page) {
      const query = new URLSearchParams({ limit: String(page.limit) });
      if (page.after !== null) query.set('after', page.after);
      const answer = await call(
        'GET',
        `/api/engine/sites?${query}`,
        timeouts.list,
      );
      if (!answer.ok) return answer;
      if (answer.status !== 200) return refusal(answer);
      return shaped(sitePage, answer.body, (value) => value);
    },

    async getSite(name) {
      const answer = await call(
        'GET',
        `/api/engine/sites/${encodeURIComponent(name)}`,
        timeouts.call,
      );
      if (!answer.ok) return answer;
      if (
        answer.status === 410 ||
        (answer.status === 404 && codeOf(answer.body) === 'NO_SITE')
      ) {
        return { ok: true, value: 'missing' };
      }
      if (answer.status !== 200) return refusal(answer);
      return shaped(siteDetail, answer.body, (value) => ({
        ...value,
        usage: {
          dbBytes: value.usage.db_bytes,
          filesBytes: value.usage.files_bytes,
          aiRequestsToday: value.usage.ai_requests_today,
          aiTokensToday: value.usage.ai_tokens_today,
        },
        quotas: {
          docBytes: value.quotas.doc_bytes,
          dbBytes: value.quotas.db_bytes,
          fileBytes: value.quotas.file_bytes,
          filesBytes: value.quotas.files_bytes,
          aiRequestsDay: value.quotas.ai_requests_day,
          aiTokensDay: value.quotas.ai_tokens_day,
        },
      }));
    },

    // A reservation is idempotent and never released by a reserve, so a batch
    // held before a later one fails only keeps those names from a site.
    async reserve(holder, labels) {
      for (let start = 0; start < labels.length; start += RESERVE_BATCH) {
        const answer = await call(
          'POST',
          '/api/engine/reservations',
          timeouts.call,
          { holder, names: labels.slice(start, start + RESERVE_BATCH) },
        );
        if (!answer.ok) return answer;
        if (answer.status === 200) continue;
        if (answer.status === 409) {
          const conflict = taken.safeParse(answer.body);
          if (conflict.success) return { ok: true, value: conflict.data.taken };
        }
        return refusal(answer);
      }
      return { ok: true, value: [] };
    },

    async release(holder, labels) {
      // An empty list would read as every label the holder has.
      if (labels !== null && labels.length === 0)
        return { ok: true, value: [] };
      const query = new URLSearchParams({ holder });
      for (const label of labels ?? []) query.append('name', label);
      const answer = await call(
        'DELETE',
        `/api/engine/reservations?${query}`,
        timeouts.call,
      );
      if (!answer.ok) return answer;
      if (answer.status !== 200) return refusal(answer);
      return shaped(released, answer.body, (value) => value.released);
    },
  };
}

/** The body as text, or `null` past `limit` bytes. */
async function readCapped(
  response: Response,
  limit: number,
): Promise<string | null> {
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parsed(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function codeOf(body: unknown): string | null {
  if (body === null || typeof body !== 'object') return null;
  const code = (body as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

function shaped<Schema extends z.ZodType, Value>(
  schema: Schema,
  body: unknown,
  map: (value: z.infer<Schema>) => Value,
): KthxRead<Value> {
  const result = schema.safeParse(body);
  return result.success
    ? { ok: true, value: map(result.data) }
    : { ok: false, reason: 'kthx answered with a body the engine cannot read' };
}

function refusal(answer: { status: number; body: unknown }): {
  ok: false;
  reason: string;
} {
  const code = codeOf(answer.body);
  const said = code === null ? `${answer.status}` : `${answer.status} ${code}`;
  const { status } = answer;
  if (status === 401) {
    return { ok: false, reason: `kthx refused the engine's token (${said})` };
  }
  if (status === 404) {
    return {
      ok: false,
      reason: 'kthx does not serve the engine surface (404)',
    };
  }
  if (status === 400) {
    return {
      ok: false,
      reason: `kthx refused the request as malformed (${said})`,
    };
  }
  if (status >= 300 && status < 400) {
    return {
      ok: false,
      reason: `kthx answered with a redirect (${status}), which the engine does not follow`,
    };
  }
  return { ok: false, reason: `kthx could not answer (${said})` };
}

function seconds(milliseconds: number): string {
  return `${milliseconds / 1000}s`;
}
