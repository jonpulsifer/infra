// Derivations over the Ledger. Pure. src/tally/report.py mirrors them.

import type { Category, Ledger, Transaction } from './types';

export const cad = new Intl.NumberFormat('en-CA', {
  style: 'currency',
  currency: 'CAD',
  maximumFractionDigits: 0,
});
export const cadCents = new Intl.NumberFormat('en-CA', {
  style: 'currency',
  currency: 'CAD',
});
export const compact = new Intl.NumberFormat('en-CA', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

export function monthKey(date: string) {
  return date.slice(0, 7);
}

export function monthLabel(ym: string) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-CA', {
    month: 'short',
    year: '2-digit',
    timeZone: 'UTC',
  });
}

export const UNCATEGORIZED = 'uncategorized';

const FALLBACK: Category = {
  id: UNCATEGORIZED,
  name: 'Uncategorized',
  parentId: null,
  flow: 'expense',
};

const byIdCache = new WeakMap<Category[], Map<string, Category>>();
const topCache = new WeakMap<Category[], Map<string, Category>>();

export function categoryById(ledger: Ledger) {
  return categoriesById(ledger.categories);
}

function categoriesById(categories: Category[]) {
  let m = byIdCache.get(categories);
  if (!m) {
    m = new Map(categories.map((c) => [c.id, c]));
    byIdCache.set(categories, m);
  }
  return m;
}

export function topLevel(ledger: Ledger, categoryId: string): Category {
  return topOf(ledger.categories, categoryId);
}

/** The top-level category of any id; unknown ids read as uncategorised. */
export function topOf(categories: Category[], categoryId: string): Category {
  let tops = topCache.get(categories);
  if (!tops) {
    tops = new Map();
    topCache.set(categories, tops);
  }
  const hit = tops.get(categoryId);
  if (hit) return hit;
  const byId = categoriesById(categories);
  let c = byId.get(categoryId) ?? byId.get(UNCATEGORIZED) ?? FALLBACK;
  const seen = new Set<string>();
  while (c.parentId && !seen.has(c.id)) {
    seen.add(c.id);
    c = byId.get(c.parentId) ?? c;
  }
  tops.set(categoryId, c);
  return c;
}

export function isSpend(t: Transaction, ledger: Ledger) {
  if (t.transferId) return false;
  const top = topLevel(ledger, t.categoryId);
  return top.flow === 'expense' && t.amount < 0;
}

export function isIncome(t: Transaction, ledger: Ledger) {
  if (t.transferId) return false;
  const top = topLevel(ledger, t.categoryId);
  return top.flow === 'income' && t.amount > 0;
}

export function months(ledger: Ledger): string[] {
  const set = new Set(ledger.transactions.map((t) => monthKey(t.date)));
  return Array.from(set).sort();
}

/** Rows of { month, [topLevelCategoryId]: spend } for a stacked chart. */
export function monthlySpendByCategory(
  ledger: Ledger,
  opts: { from?: string; to?: string; level?: 'top' | 'leaf' } = {},
) {
  const level = opts.level ?? 'top';
  const byId = categoryById(ledger);
  const rows = new Map<string, Record<string, number>>();
  for (const t of ledger.transactions) {
    if (!isSpend(t, ledger)) continue;
    const m = monthKey(t.date);
    if (opts.from && m < opts.from) continue;
    if (opts.to && m > opts.to) continue;
    const key =
      level === 'top' ? topLevel(ledger, t.categoryId).id : t.categoryId;
    const row = rows.get(m) ?? {};
    row[key] = (row[key] ?? 0) - t.amount;
    rows.set(m, row);
  }
  const keys = Array.from(
    new Set(Array.from(rows.values()).flatMap((r) => Object.keys(r))),
  );
  return {
    keys,
    names: Object.fromEntries(keys.map((k) => [k, byId.get(k)?.name ?? k])),
    rows: Array.from(rows.entries())
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([month, r]) => ({ month, ...r })),
  };
}

export function topMerchants(
  ledger: Ledger,
  opts: { from?: string; to?: string; limit?: number } = {},
) {
  const agg = new Map<
    string,
    { merchant: string; total: number; count: number; categoryId: string }
  >();
  for (const t of ledger.transactions) {
    if (!isSpend(t, ledger)) continue;
    if (opts.from && t.date < opts.from) continue;
    if (opts.to && t.date > opts.to) continue;
    const a = agg.get(t.merchant) ?? {
      merchant: t.merchant,
      total: 0,
      count: 0,
      categoryId: t.categoryId,
    };
    a.total -= t.amount;
    a.count += 1;
    agg.set(t.merchant, a);
  }
  return Array.from(agg.values())
    .sort((a, b) => b.total - a.total)
    .slice(0, opts.limit ?? 10);
}

/** Per month: income in, spend out, net. */
export function cashFlow(
  ledger: Ledger,
  opts: { from?: string; to?: string } = {},
) {
  const rows = new Map<
    string,
    { month: string; income: number; spend: number; net: number }
  >();
  for (const t of ledger.transactions) {
    const m = monthKey(t.date);
    if (opts.from && m < opts.from) continue;
    if (opts.to && m > opts.to) continue;
    const row = rows.get(m) ?? { month: m, income: 0, spend: 0, net: 0 };
    if (isIncome(t, ledger)) row.income += t.amount;
    else if (isSpend(t, ledger)) row.spend -= t.amount;
    row.net = row.income - row.spend;
    rows.set(m, row);
  }
  return Array.from(rows.values()).sort((a, b) => (a.month < b.month ? -1 : 1));
}

/** Running balance per account per month end, from transactions. */
export function balancesByMonth(ledger: Ledger) {
  const ms = months(ledger);
  const cents = monthlyCents(ledger);
  const out = new Map<string, Map<string, number>>();
  for (const acct of ledger.accounts) {
    const flows = cents.get(acct.id);
    const series = new Map<string, number>();
    let bal = 0;
    for (const m of ms) {
      bal += flows?.get(m) ?? 0;
      series.set(m, bal / 100);
    }
    out.set(acct.id, series);
  }
  return out;
}

function monthlyCents(ledger: Ledger) {
  const out = new Map<string, Map<string, number>>();
  for (const t of ledger.transactions) {
    const flows = out.get(t.accountId) ?? new Map<string, number>();
    const m = monthKey(t.date);
    flows.set(m, (flows.get(m) ?? 0) + Math.round(t.amount * 100));
    out.set(t.accountId, flows);
  }
  return out;
}

export type NetWorthPoint = {
  month: string;
  cash: number;
  investments: number;
  house: number;
  mortgage: number;
  total: number;
  /** True when at least one component is carried forward from an older statement. */
  estimated: boolean;
};

type Stated = { date: string; value: number };

function latestOnOrBefore(points: Stated[], end: string): Stated | null {
  let last: Stated | null = null;
  for (const p of points) if (p.date <= end) last = p;
  return last;
}

function byDate<T extends { date: string }>(rows: T[]) {
  return [...rows].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0,
  );
}

/** What each account states for itself: snapshots, valuations or statements. */
function statedPoints(
  ledger: Ledger,
  accountId: string,
  kind: string,
): Stated[] | null {
  if (kind === 'investment')
    return byDate(ledger.holdings.filter((h) => h.accountId === accountId)).map(
      (h) => ({ date: h.date, value: h.total }),
    );
  if (kind === 'asset')
    return byDate(
      ledger.valuations.filter((v) => v.accountId === accountId),
    ).map((v) => ({ date: v.date, value: v.value }));
  if (kind === 'mortgage')
    return byDate(
      ledger.assertions.filter((a) => a.accountId === accountId),
    ).map((a) => ({ date: a.date, value: a.balance }));
  return null;
}

type AccountValue = {
  cents: number;
  /** The value is an older statement carried forward. */
  carried: boolean;
  /** False before an account's first statement or valuation. */
  stated: boolean;
};

/**
 * Every account's value at every ledger month end, in integer cents. The
 * reader's net worth and the Accounts screen both sum this one table, so the
 * two can never disagree by a rounding.
 */
export function accountValues(ledger: Ledger) {
  const hit = valuesCache.get(ledger);
  if (hit) return hit;
  const ms = months(ledger);
  const flows = monthlyCents(ledger);
  const out = new Map<string, AccountValue[]>();
  for (const acct of ledger.accounts) {
    const stated = statedPoints(ledger, acct.id, acct.kind);
    if (stated) {
      out.set(
        acct.id,
        ms.map((m) => {
          const p = latestOnOrBefore(stated, `${m}-31`);
          return {
            cents: p ? Math.round(p.value * 100) : 0,
            carried: !!p && p.date.slice(0, 7) !== m,
            stated: !!p,
          };
        }),
      );
      continue;
    }
    const f = flows.get(acct.id);
    let bal = 0;
    out.set(
      acct.id,
      ms.map((m) => {
        bal += f?.get(m) ?? 0;
        return { cents: bal, carried: false, stated: true };
      }),
    );
  }
  const result = { months: ms, values: out };
  valuesCache.set(ledger, result);
  return result;
}

const valuesCache = new WeakMap<
  Ledger,
  {
    months: string[];
    values: Map<string, AccountValue[]>;
  }
>();

const PART: Record<
  string,
  keyof Omit<NetWorthPoint, 'month' | 'total' | 'estimated'>
> = {
  chequing: 'cash',
  savings: 'cash',
  credit: 'cash',
  investment: 'investments',
  asset: 'house',
  mortgage: 'mortgage',
};

/** Net worth per month end. Investments, assets and the mortgage use their latest statement on or before the month. */
export function netWorthSeries(ledger: Ledger): NetWorthPoint[] {
  const { months: ms, values } = accountValues(ledger);
  return ms.map((month, i) => {
    const c = { cash: 0, investments: 0, house: 0, mortgage: 0 };
    let estimated = false;
    for (const acct of ledger.accounts) {
      const v = values.get(acct.id)?.[i];
      if (!v) continue;
      c[PART[acct.kind]] += v.cents;
      if (v.carried) estimated = true;
    }
    return {
      month,
      cash: c.cash / 100,
      investments: c.investments / 100,
      house: c.house / 100,
      mortgage: c.mortgage / 100,
      total: (c.cash + c.investments + c.house + c.mortgage) / 100,
      estimated,
    };
  });
}

export type SankeyData = {
  nodes: { id: string; name: string; kind: 'source' | 'group' | 'leaf' }[];
  links: { source: string; target: string; value: number }[];
};

/** Income sources -> top-level groups -> leaf categories, for one period. */
export function sankey(
  ledger: Ledger,
  opts: { from: string; to: string },
): SankeyData {
  const byId = categoryById(ledger);
  const nodes = new Map<string, SankeyData['nodes'][number]>();
  const links = new Map<string, number>();
  const add = (s: string, t: string, v: number) =>
    links.set(`${s}→${t}`, (links.get(`${s}→${t}`) ?? 0) + v);
  let income = 0;
  for (const t of ledger.transactions) {
    if (t.date < opts.from || t.date > opts.to) continue;
    if (isIncome(t, ledger)) {
      nodes.set(`src:${t.merchant}`, {
        id: `src:${t.merchant}`,
        name: t.merchant,
        kind: 'source',
      });
      add(`src:${t.merchant}`, 'all', t.amount);
      income += t.amount;
    } else if (isSpend(t, ledger)) {
      const top = topLevel(ledger, t.categoryId);
      const leaf = byId.get(t.categoryId)!;
      nodes.set(`grp:${top.id}`, {
        id: `grp:${top.id}`,
        name: top.name,
        kind: 'group',
      });
      nodes.set(`leaf:${leaf.id}`, {
        id: `leaf:${leaf.id}`,
        name: leaf.name,
        kind: 'leaf',
      });
      add('all', `grp:${top.id}`, -t.amount);
      if (leaf.id !== top.id)
        add(`grp:${top.id}`, `leaf:${leaf.id}`, -t.amount);
    }
  }
  nodes.set('all', { id: 'all', name: 'Income', kind: 'group' });
  const spent = Array.from(links.entries())
    .filter(([k]) => k.startsWith('all→'))
    .reduce((s, [, v]) => s + v, 0);
  if (income > spent) {
    nodes.set('leaf:saved', { id: 'leaf:saved', name: 'Saved', kind: 'leaf' });
    add('all', 'leaf:saved', income - spent);
  }
  return {
    nodes: Array.from(nodes.values()),
    links: Array.from(links.entries()).map(([k, value]) => {
      const [source, target] = k.split('→');
      return { source, target, value: Math.round(value) };
    }),
  };
}

export function latestHoldings(ledger: Ledger, accountId: string) {
  return (
    byDate(ledger.holdings.filter((h) => h.accountId === accountId)).slice(
      -1,
    )[0] ?? null
  );
}

/** An account's value at the ledger's last month end, from the same table as net worth. */
export function accountBalance(ledger: Ledger, accountId: string) {
  const { values } = accountValues(ledger);
  const v = values.get(accountId);
  return v?.length ? v[v.length - 1].cents / 100 : 0;
}

/** Every account's latest value, keyed by id. */
export function accountBalances(ledger: Ledger) {
  const { values } = accountValues(ledger);
  return new Map(
    [...values.entries()].map(([id, v]) => [
      id,
      v.length ? v[v.length - 1].cents / 100 : 0,
    ]),
  );
}

export function searchTransactions(
  ledger: Ledger,
  q: {
    text?: string;
    accountId?: string;
    categoryId?: string;
    from?: string;
    to?: string;
    limit?: number;
  },
) {
  const text = q.text?.trim().toLowerCase();
  const out: Transaction[] = [];
  for (let i = ledger.transactions.length - 1; i >= 0; i--) {
    const t = ledger.transactions[i];
    if (q.accountId && t.accountId !== q.accountId) continue;
    if (
      q.categoryId &&
      t.categoryId !== q.categoryId &&
      topLevel(ledger, t.categoryId).id !== q.categoryId
    )
      continue;
    if (q.from && t.date < q.from) continue;
    if (q.to && t.date > q.to) continue;
    if (
      text &&
      !t.descriptor.toLowerCase().includes(text) &&
      !t.merchant.toLowerCase().includes(text)
    )
      continue;
    out.push(t);
    if (q.limit && out.length >= q.limit) break;
  }
  return out;
}
