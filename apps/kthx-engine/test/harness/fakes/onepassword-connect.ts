/**
 * The 1Password Connect API behind the real `OnePasswordStore`. It serves only
 * create, get, filtered list and delete; anything else answers 404.
 */
import type { Fetcher } from '../../../src/adapters/store/http.ts';

interface StoredSection {
  id: string;
  label?: string;
}

interface StoredField {
  type: string;
  label?: string;
  value?: string;
  section?: { id?: string };
}

interface StoredItem {
  id: string;
  title: string;
  category: string;
  createdAt: string;
  sections: StoredSection[];
  /** What Connect returns: the category's defaults, then the caller's. */
  fields: StoredField[];
  /** The caller's fields alone. */
  own: StoredField[];
}

/**
 * Fields Connect adds from the category template ahead of the caller's. One is
 * `CONCEALED`, so neither the first labelled nor concealed field is the caller's.
 */
const CATEGORY_DEFAULTS: Record<string, readonly StoredField[]> = {
  API_CREDENTIAL: [
    { type: 'STRING', label: 'username' },
    { type: 'CONCEALED', label: 'credential' },
    { type: 'STRING', label: 'notesPlain' },
  ],
  LOGIN: [
    { type: 'STRING', label: 'username' },
    { type: 'CONCEALED', label: 'password' },
    { type: 'STRING', label: 'notesPlain' },
  ],
};

export interface RecordedRequest {
  method: string;
  /** Path and query, without the base URL. */
  path: string;
  body: unknown;
}

export interface FakeConnectOptions {
  /** The one vault this Connect fronts. Any other answers `404`. */
  vault?: string;
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

  get baseUrl(): string {
    return BASE;
  }

  get itemCount(): number {
    return this.items.size;
  }

  /** The caller's first field value; the rendered item leads with defaults. */
  valueOf(itemId: string): string | null {
    return this.items.get(itemId)?.own[0]?.value ?? null;
  }

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

  /** Connect has no default `vault` or `category`, so a create needs both. */
  private create(body: unknown): Response {
    const requested = body as {
      title?: string;
      category?: string;
      vault?: { id?: string };
      sections?: StoredSection[];
      fields?: StoredField[];
    };
    if (typeof requested?.title !== 'string') {
      return json({ message: 'title is required' }, 422);
    }
    if (typeof requested.vault?.id !== 'string') {
      return json({ message: 'vault.id is required' }, 422);
    }
    if (requested.vault.id !== this.vault) {
      return json({ message: 'item vault does not match the path' }, 422);
    }
    if (typeof requested.category !== 'string') {
      return json({ message: 'category is required' }, 422);
    }
    const defaults = CATEGORY_DEFAULTS[requested.category];
    if (defaults === undefined) {
      return json({ message: `unknown category ${requested.category}` }, 422);
    }

    this.counter += 1;
    const own = requested.fields ?? [];
    const item: StoredItem = {
      id: `item-${this.counter}`,
      title: requested.title,
      category: requested.category,
      createdAt: new Date(Date.UTC(2024, 0, this.counter)).toISOString(),
      sections: requested.sections ?? [],
      fields: [...defaults.map((field) => ({ ...field })), ...own],
      own,
    };
    this.items.set(item.id, item);
    return json(render(item), 200);
  }

  private get(itemId: string): Response {
    const item = this.items.get(itemId);
    return item
      ? json(render(item), 200)
      : json({ message: 'no such item' }, 404);
  }

  /** Connect lists overviews, which carry no fields. */
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

/** Drops `own`, which is this fake's bookkeeping. */
function render(item: StoredItem) {
  const { own: _own, ...rest } = item;
  return rest;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
