import type {
  Account,
  BalanceAssertion,
  Category,
  Finding,
  HoldingSnapshot,
  ImportBatch,
  ImportPreview,
  Ledger,
  PreviewFile,
  Rule,
  Transaction,
  Valuation,
} from '~/fixtures/types';
import type { Decisions } from '~/lib/store';

export type Me = {
  login: string;
  role: 'owner' | 'viewer';
  ledgerId: string | null;
};

export type TxnQuery = {
  from?: string;
  to?: string;
  q?: string;
  accountId?: string;
  categoryId?: string;
};

export type RuleDraft = {
  match: string;
  categoryId: string;
  merchant: string;
  accountId?: string | null;
};

export type AccountDraft = Pick<
  Account,
  'name' | 'institution' | 'kind' | 'since'
>;

export type Applied = { ledger: Ledger; batch: ImportBatch | null };

/** Everything the app asks of the server. The synthetic ledger serves the same. */
export interface Api {
  source: 'server' | 'synthetic';
  /** A preview to open on load when the URL names none. */
  pendingPreviewId: string | null;
  me(): Promise<Me>;
  ledger(): Promise<Ledger>;
  report(name: string, params?: Record<string, string>): Promise<unknown>;
  transactions(q?: TxnQuery): Promise<Transaction[]>;
  previewImport(files: File[]): Promise<ImportPreview>;
  getPreview(id: string): Promise<ImportPreview>;
  applyPreview(id: string, decisions: Decisions): Promise<Applied>;
  setCategory(id: string, categoryId: string): Promise<Transaction>;
  rules(): Promise<Rule[]>;
  /** `moved` lists the rows the server refiled, or null when it refiles none. */
  createRule(
    draft: RuleDraft,
  ): Promise<{ rule: Rule; moved: Transaction[] | null }>;
  accounts(): Promise<Account[]>;
  createAccount(draft: AccountDraft): Promise<Account>;
  addValuation(v: Valuation): Promise<Valuation>;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Every route in one place, so a server that names them differently is a one-line fix. */
export const ROUTES = {
  me: '/me',
  ledger: '/ledger',
  report: (name: string) => `/report/${encodeURIComponent(name)}`,
  transactions: '/transactions',
  preview: '/import/preview',
  previewById: (id: string) => `/import/preview/${encodeURIComponent(id)}`,
  apply: (id: string) => `/import/preview/${encodeURIComponent(id)}/apply`,
  category: (id: string) => `/transactions/${encodeURIComponent(id)}/category`,
  rules: '/rules',
  accounts: '/accounts',
  valuations: (accountId: string) =>
    `/accounts/${encodeURIComponent(accountId)}/valuations`,
} as const;

// Wire shapes ------------------------------------------------------------------
// pydantic serialises Decimal as a string and names some fields differently
// from the app (dateFrom for from, members for owner and viewers). Adapt here,
// nowhere else.

type Num = number | string;
type Wire = Record<string, unknown>;

const num = (v: unknown): number =>
  typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : 0;
const str = (v: unknown, fallback = ''): string =>
  typeof v === 'string' ? v : fallback;
const day = (v: unknown): string => str(v).slice(0, 10);
const list = (v: unknown): Wire[] => (Array.isArray(v) ? (v as Wire[]) : []);

export function transactionFromWire(w: Wire): Transaction {
  return {
    id: str(w.id),
    accountId: str(w.accountId),
    date: day(w.date),
    amount: num(w.amount as Num),
    descriptor: str(w.descriptor),
    merchant: str(w.merchant, str(w.descriptor)),
    categoryId: str(w.categoryId, 'uncategorized'),
    tags: Array.isArray(w.tags) ? (w.tags as string[]) : [],
    transferId: (w.transferId as string | null | undefined) ?? null,
    source: (w.source as Transaction['source'] | undefined) ?? 'rule',
    confidence: w.confidence == null ? null : num(w.confidence),
    batchId: str(w.batchId),
    fitid: (w.fitid as string | null | undefined) ?? null,
    pending: !!w.pending,
  };
}

function accountFromWire(w: Wire): Account {
  return {
    id: str(w.id),
    name: str(w.name),
    institution: str(w.institution),
    kind: w.kind as Account['kind'],
    since: day(w.since),
  };
}

function categoryFromWire(w: Wire): Category {
  return {
    id: str(w.id),
    name: str(w.name),
    parentId: (w.parentId as string | null | undefined) ?? null,
    flow: w.flow as Category['flow'],
  };
}

function holdingFromWire(w: Wire): HoldingSnapshot {
  return {
    accountId: str(w.accountId),
    date: day(w.date),
    total: num(w.total),
    origin: w.origin as HoldingSnapshot['origin'],
    positions: list(w.positions).map((p) => ({
      symbol: str(p.symbol),
      name: str(p.name),
      quantity: num(p.quantity),
      price: num(p.price),
      marketValue: num(p.marketValue),
      bookCost: num(p.bookCost),
    })),
  };
}

export function valuationFromWire(w: Wire): Valuation {
  return {
    accountId: str(w.accountId),
    date: day(w.date),
    value: num(w.value),
    source: w.source as Valuation['source'],
  };
}

export function ruleFromWire(w: Wire): Rule {
  return {
    id: str(w.id),
    match: str(w.match),
    categoryId: str(w.categoryId),
    merchant: str(w.merchant),
    createdFrom: (w.createdFrom as Rule['createdFrom'] | undefined) ?? 'seed',
    hits: num(w.hits),
    accountId: (w.accountId as string | null | undefined) ?? null,
  };
}

function batchFromWire(w: Wire): ImportBatch {
  return {
    id: str(w.id),
    importedAt: day(w.importedAt),
    files: num(w.files),
    rows: num(w.rows),
    note: str(w.note),
  };
}

/**
 * Each statement balance checked against the one before it: the rows between
 * them must carry the first to the second, to the cent. The first statement
 * of an account anchors it. Used only when the server does not say.
 */
function checkAssertions(
  transactions: Transaction[],
  stated: Omit<BalanceAssertion, 'ok'>[],
): BalanceAssertion[] {
  const flows = new Map<string, Transaction[]>();
  for (const t of transactions)
    flows.set(t.accountId, [...(flows.get(t.accountId) ?? []), t]);
  const prev = new Map<string, Omit<BalanceAssertion, 'ok'>>();
  return [...stated]
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .map((a) => {
      const before = prev.get(a.accountId);
      prev.set(a.accountId, a);
      if (!before) return { ...a, ok: true };
      let cents = Math.round(before.balance * 100);
      for (const t of flows.get(a.accountId) ?? [])
        if (t.date > before.date && t.date <= a.date)
          cents += Math.round(t.amount * 100);
      return { ...a, ok: cents === Math.round(a.balance * 100) };
    });
}

function assertionsFromWire(
  wire: Wire[],
  transactions: Transaction[],
  statedOnly: Set<string>,
): BalanceAssertion[] {
  const stated = wire.map((a) => ({
    accountId: str(a.accountId),
    date: day(a.date),
    balance: num(a.balance),
    origin: str(a.origin) || undefined,
    ok: typeof a.ok === 'boolean' ? a.ok : undefined,
  }));
  if (stated.every((a) => a.ok !== undefined))
    return stated.map((a) => ({ ...a, ok: a.ok ?? true }));
  const checked = checkAssertions(
    transactions,
    stated.filter((a) => !statedOnly.has(a.accountId)),
  );
  return [
    ...checked,
    ...stated
      .filter((a) => statedOnly.has(a.accountId))
      .map((a) => ({ ...a, ok: true })),
  ];
}

export function ledgerFromWire(w: Wire): Ledger {
  const transactions = list(w.transactions).map(transactionFromWire);
  const accounts = list(w.accounts).map(accountFromWire);
  const statedOnly = new Set(
    accounts
      .filter(
        (a) =>
          a.kind !== 'chequing' && a.kind !== 'savings' && a.kind !== 'credit',
      )
      .map((a) => a.id),
  );
  const members = list(w.members);
  const owner =
    str(w.owner) ||
    str(members.find((m) => m.role === 'owner')?.login, 'unknown');
  const viewers = Array.isArray(w.viewers)
    ? (w.viewers as string[])
    : members.filter((m) => m.role === 'viewer').map((m) => str(m.login));
  const asOf =
    day(w.asOf) || transactions.reduce((m, t) => (t.date > m ? t.date : m), '');
  return {
    owner,
    viewers,
    accounts,
    categories: list(w.categories).map(categoryFromWire),
    transactions,
    holdings: list(w.holdings).map(holdingFromWire),
    valuations: list(w.valuations).map(valuationFromWire),
    assertions: assertionsFromWire(
      list(w.assertions),
      transactions,
      statedOnly,
    ),
    batches: list(w.batches).map(batchFromWire),
    rules: list(w.rules).map(ruleFromWire),
    asOf,
  };
}

function fileFromWire(w: Wire): PreviewFile {
  return {
    name: str(w.name),
    format: w.format as PreviewFile['format'],
    institution: str(w.institution),
    accountId: (w.accountId as string | null | undefined) ?? null,
    rows: num(w.rows),
    from: day(w.from ?? w.dateFrom),
    to: day(w.to ?? w.dateTo),
    pages: w.pages == null ? undefined : num(w.pages),
    scanned: w.scanned == null ? undefined : !!w.scanned,
    needsAccount: !!w.needsAccount,
  };
}

function findingFromWire(w: Wire): Finding | null {
  switch (w.kind) {
    case 'duplicate':
      return {
        kind: 'duplicate',
        id: str(w.id),
        transactionId: str(w.transactionId),
        matchesId: str(w.matchesId),
        reason: str(w.reason),
        tier: w.tier as 'fitid' | 'fuzzy' | undefined,
      };
    case 'missing-period':
      return {
        kind: 'missing-period',
        id: str(w.id),
        accountId: str(w.accountId),
        from: day(w.from ?? w.dateFrom),
        to: day(w.to ?? w.dateTo),
        expectedBalance: num(w.expectedBalance),
        actualBalance: num(w.actualBalance),
      };
    case 'transfer':
      return {
        kind: 'transfer',
        id: str(w.id),
        outId: str(w.outId),
        inId: str(w.inId),
        daysApart: num(w.daysApart),
        auto: !!w.auto,
      };
    case 'low-confidence':
      return {
        kind: 'low-confidence',
        id: str(w.id),
        transactionId: str(w.transactionId),
        suggestedCategoryId: str(w.suggestedCategoryId),
        confidence: num(w.confidence),
      };
    default:
      return null;
  }
}

/** Accepts the preview flat with an id, or as `{ id, preview }`. */
export function previewFromWire(w: Wire): ImportPreview {
  const body = (w.preview as Wire | undefined) ?? w;
  return {
    id: str(w.id, str(body.id)),
    files: list(body.files).map(fileFromWire),
    newTransactions: list(body.newTransactions).map(transactionFromWire),
    findings: list(body.findings)
      .map(findingFromWire)
      .filter((f): f is Finding => f !== null),
    outboundStrings: Array.isArray(body.outboundStrings)
      ? (body.outboundStrings as string[])
      : [],
    rulesHit: num(body.rulesHit),
    modelCalls: num(body.modelCalls),
  };
}

function meFromWire(w: Wire): Me {
  return {
    login: str(w.login, 'unknown'),
    role: w.role === 'viewer' ? 'viewer' : 'owner',
    ledgerId: (w.ledgerId as string | null | undefined) ?? null,
  };
}

// HTTP ---------------------------------------------------------------------------

async function request(
  base: string,
  path: string,
  init: RequestInit = {},
): Promise<Wire> {
  const res = await fetch(`${base}${path}`, {
    credentials: 'same-origin',
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init.body && !(init.body instanceof FormData)
        ? { 'Content-Type': 'application/json' }
        : {}),
    },
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = (await res.json()) as Wire;
      detail = str(body.detail, detail);
    } catch {}
    throw new ApiError(res.status, `${res.status} ${detail}`.trim());
  }
  if (res.status === 204) return {};
  return (await res.json()) as Wire;
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  body: JSON.stringify(body),
});

function qs(params: Record<string, string | undefined>) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
}

const asList = (w: unknown): Wire[] =>
  Array.isArray(w) ? (w as Wire[]) : list((w as Wire).items);

export function httpApi(base = '/api'): Api {
  const call = (path: string, init?: RequestInit) => request(base, path, init);
  const api: Api = {
    source: 'server',
    pendingPreviewId: null,
    me: async () => meFromWire(await call(ROUTES.me)),
    ledger: async () => ledgerFromWire(await call(ROUTES.ledger)),
    report: (name, params = {}) => call(`${ROUTES.report(name)}${qs(params)}`),
    transactions: async (q = {}) =>
      asList(await call(`${ROUTES.transactions}${qs(q)}`)).map(
        transactionFromWire,
      ),
    previewImport: async (files) => {
      const form = new FormData();
      for (const f of files) form.append('files', f, f.name);
      return previewFromWire(
        await call(ROUTES.preview, { method: 'POST', body: form }),
      );
    },
    getPreview: async (id) =>
      previewFromWire(await call(ROUTES.previewById(id))),
    applyPreview: async (id, decisions) => {
      const w = await call(ROUTES.apply(id), json(decisions));
      const wl = (w.ledger as Wire | undefined) ?? (w.transactions ? w : null);
      return {
        ledger: wl ? ledgerFromWire(wl) : await api.ledger(),
        batch: w.batch ? batchFromWire(w.batch as Wire) : null,
      };
    },
    setCategory: async (id, categoryId) => {
      const w = await call(ROUTES.category(id), json({ categoryId }));
      return transactionFromWire((w.transaction as Wire | undefined) ?? w);
    },
    rules: async () => asList(await call(ROUTES.rules)).map(ruleFromWire),
    createRule: async (draft) => {
      const w = await call(ROUTES.rules, json(draft));
      const rule = ruleFromWire((w.rule as Wire | undefined) ?? w);
      const moved = Array.isArray(w.moved)
        ? (w.moved as Wire[]).map(transactionFromWire)
        : null;
      return { rule, moved };
    },
    accounts: async () =>
      asList(await call(ROUTES.accounts)).map(accountFromWire),
    createAccount: async (draft) =>
      accountFromWire(await call(ROUTES.accounts, json(draft))),
    addValuation: async (v) =>
      valuationFromWire(await call(ROUTES.valuations(v.accountId), json(v))),
  };
  return api;
}

/**
 * The server, or the synthetic ledger when the URL asks for it
 * (?synthetic=1) or there is no server (/api/me answers 404).
 */
export async function connect(): Promise<{ api: Api; me: Me }> {
  const params = new URLSearchParams(window.location.search);
  const synthetic = async () => {
    const { syntheticApi } = await import('./synthetic');
    const api = syntheticApi();
    return { api, me: await api.me() };
  };
  if (params.get('synthetic') === '1') return synthetic();
  const api = httpApi();
  try {
    return { api, me: await api.me() };
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return synthetic();
    throw e;
  }
}
