// Derivations every variant can call. Pure functions over the Ledger.

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

export function categoryById(ledger: Ledger) {
  return new Map(ledger.categories.map((c) => [c.id, c]));
}

export function topLevel(ledger: Ledger, categoryId: string): Category {
  const byId = categoryById(ledger);
  let c = byId.get(categoryId) ?? byId.get('uncategorized')!;
  while (c.parentId) c = byId.get(c.parentId)!;
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
  const out = new Map<string, Map<string, number>>();
  for (const acct of ledger.accounts) {
    const series = new Map<string, number>();
    let bal = 0;
    const byMonth = new Map<string, number>();
    for (const t of ledger.transactions) {
      if (t.accountId !== acct.id) continue;
      const m = monthKey(t.date);
      byMonth.set(m, (byMonth.get(m) ?? 0) + t.amount);
    }
    for (const m of ms) {
      bal += byMonth.get(m) ?? 0;
      series.set(m, Math.round(bal * 100) / 100);
    }
    out.set(acct.id, series);
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

/** Net worth per month end. Investments and house use the latest snapshot on or before the month. */
export function netWorthSeries(ledger: Ledger): NetWorthPoint[] {
  const ms = months(ledger);
  const bal = balancesByMonth(ledger);
  const cashIds = ledger.accounts
    .filter(
      (a) =>
        a.kind === 'chequing' || a.kind === 'savings' || a.kind === 'credit',
    )
    .map((a) => a.id);
  const invIds = ledger.accounts
    .filter((a) => a.kind === 'investment')
    .map((a) => a.id);
  const points: NetWorthPoint[] = [];
  for (const m of ms) {
    const end = `${m}-31`;
    const cash = cashIds.reduce((s, id) => s + (bal.get(id)?.get(m) ?? 0), 0);
    let investments = 0;
    let estimated = false;
    for (const id of invIds) {
      const snaps = ledger.holdings.filter(
        (h) => h.accountId === id && h.date <= end,
      );
      const last = snaps[snaps.length - 1];
      if (last) {
        investments += last.total;
        if (last.date.slice(0, 7) !== m) estimated = true;
      }
    }
    const vals = ledger.valuations.filter((v) => v.date <= end);
    const house = vals.length ? vals[vals.length - 1].value : 0;
    if (vals.length && vals[vals.length - 1].date.slice(0, 7) !== m)
      estimated = true;
    const mort = ledger.assertions
      .filter((a) => a.accountId === 'mortgage' && a.date <= end)
      .slice(-1)[0];
    const mortgage = mort ? mort.balance : 0;
    const r = (n: number) => Math.round(n);
    points.push({
      month: m,
      cash: r(cash),
      investments: r(investments),
      house: r(house),
      mortgage: r(mortgage),
      total: r(cash + investments + house + mortgage),
      estimated,
    });
  }
  return points;
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
    ledger.holdings.filter((h) => h.accountId === accountId).slice(-1)[0] ??
    null
  );
}

export function accountBalance(ledger: Ledger, accountId: string) {
  const acct = ledger.accounts.find((a) => a.id === accountId);
  if (!acct) return 0;
  if (acct.kind === 'investment')
    return latestHoldings(ledger, accountId)?.total ?? 0;
  if (acct.kind === 'asset')
    return (
      ledger.valuations.filter((v) => v.accountId === accountId).slice(-1)[0]
        ?.value ?? 0
    );
  if (acct.kind === 'mortgage')
    return (
      ledger.assertions.filter((a) => a.accountId === accountId).slice(-1)[0]
        ?.balance ?? 0
    );
  return ledger.transactions
    .filter((t) => t.accountId === accountId)
    .reduce((s, t) => s + t.amount, 0);
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
