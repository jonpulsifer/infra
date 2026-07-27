/**
 * A fake 1Password Connect (Task 10, § Seam 2).
 *
 * § Seam 2: real backends are stood in for "the way `apps/ddnsd/main_test.go`
 * already does it in this repo: **a fake of the far-side HTTP API behind the
 * real client**, with the test asserting the requests that were made." So this
 * is the Connect service, not a fake `SecretStore` — every assertion the
 * conformance suite makes about `OnePasswordStore` runs through the real
 * adapter's real URL construction, its real JSON bodies, and its real handling
 * of a `404`.
 *
 * It models only what the adapter calls: create an item, get one, list a
 * vault's overviews with the `filter` Connect supports, and delete. Anything
 * else answers `404`, so an adapter that started calling a fifth endpoint would
 * fail rather than silently pass against a permissive stand-in.
 */
import type { Fetcher } from '../../../src/adapters/store/http.ts';

interface StoredField {
  type: string;
  label?: string;
  value?: string;
}

interface StoredItem {
  id: string;
  title: string;
  createdAt: string;
  fields: StoredField[];
}

/** Every request the adapter made, for a test to assert against. */
export interface RecordedRequest {
  method: string;
  /** Path and query, without the base URL. */
  path: string;
  body: unknown;
}

export interface FakeConnectOptions {
  /** The one vault this Connect fronts. Any other answers `404`. */
  vault?: string;
  /** The token the adapter must present. */
  token?: string;
}

const BASE = 'https://connect.invalid';

export class FakeOnePasswordConnect {
  readonly vault: string;
  readonly requests: RecordedRequest[] = [];

  private readonly token: string;
  private readonly items = new Map<string, StoredItem>();
  private counter = 0;

  constructor(options: FakeConnectOptions = {}) {
    this.vault = options.vault ?? 'vault-of-record';
    this.token = options.token ?? 'connect-token';
  }

  /** The base URL to construct the adapter against. */
  get baseUrl(): string {
    return BASE;
  }

  /** How many items the vault holds — the far side's own view, for a test. */
  get itemCount(): number {
    return this.items.size;
  }

  /** What was written under one item id. Never reachable through the contract. */
  valueOf(itemId: string): string | null {
    return this.items.get(itemId)?.fields[0]?.value ?? null;
  }

  /** The transport to hand the adapter. */
  readonly fetch: Fetcher = async (request) => {
    const url = new URL(request.url);
    const body =
      request.method === 'GET' || request.method === 'DELETE'
        ? undefined
        : await request.clone().json();
    this.requests.push({
      method: request.method,
      path: `${url.pathname}${url.search}`,
      body,
    });

    if (request.headers.get('Authorization') !== `Bearer ${this.token}`) {
      return json({ message: 'unauthorized' }, 401);
    }

    const segments = url.pathname.split('/').filter(Boolean);
    // /v1/vaults/{vault}/items[/{item}]
    if (
      segments[0] !== 'v1' ||
      segments[1] !== 'vaults' ||
      segments[3] !== 'items' ||
      segments.length > 5
    ) {
      return json({ message: 'no such route' }, 404);
    }
    if (segments[2] !== this.vault) {
      return json({ message: 'no such vault' }, 404);
    }

    const itemId = segments[4];
    if (itemId === undefined) {
      if (request.method === 'POST') return this.create(body);
      if (request.method === 'GET') return this.list(url.searchParams);
      return json({ message: 'method not allowed' }, 405);
    }
    if (request.method === 'GET') return this.get(itemId);
    if (request.method === 'DELETE') return this.remove(itemId);
    return json({ message: 'method not allowed' }, 405);
  };

  private create(body: unknown): Response {
    const requested = body as { title?: string; fields?: StoredField[] };
    if (typeof requested?.title !== 'string') {
      return json({ message: 'title is required' }, 422);
    }
    this.counter += 1;
    const item: StoredItem = {
      // Connect mints the id, which is why the adapter never has to invent a
      // version number and never has to count what already exists.
      id: `item-${this.counter}`,
      title: requested.title,
      createdAt: new Date(Date.UTC(2024, 0, this.counter)).toISOString(),
      fields: requested.fields ?? [],
    };
    this.items.set(item.id, item);
    return json(item, 200);
  }

  private get(itemId: string): Response {
    const item = this.items.get(itemId);
    return item ? json(item, 200) : json({ message: 'no such item' }, 404);
  }

  /**
   * Connect's list endpoint returns overviews — id, title, createdAt, and no
   * fields. The adapter must not depend on a value or a label being here, and
   * this is what holds it to that.
   */
  private list(query: URLSearchParams): Response {
    const filter = query.get('filter');
    const wanted = filter?.match(/^title eq "(.*)"$/)?.[1];
    const overviews = [...this.items.values()]
      .filter((item) => wanted === undefined || item.title === wanted)
      .map(({ id, title, createdAt }) => ({ id, title, createdAt }));
    return json(overviews, 200);
  }

  private remove(itemId: string): Response {
    if (!this.items.delete(itemId)) {
      return json({ message: 'no such item' }, 404);
    }
    return new Response(null, { status: 204 });
  }
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
