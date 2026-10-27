// Pure derivations the Editorial variant needs beyond src/fixtures/derive.ts.

import {
  type balancesByMonth,
  cad,
  cashFlow,
  categoryById,
  isIncome,
  isSpend,
  months,
  netWorthSeries,
  sankey,
  topLevel,
  topMerchants,
} from '~/fixtures/derive';
import type { Ledger, Transaction } from '~/fixtures/types';

// Dates ---------------------------------------------------------------------

const MONTHS_LONG = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function parts(iso: string) {
  const [y, m, d] = iso.split('-').map(Number);
  return { y, m, d: d || 1 };
}

function daysIn(y: number, m: number) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function pad(n: number) {
  return String(n).padStart(2, '0');
}

export function shiftMonths(iso: string, n: number) {
  const { y, m, d } = parts(iso);
  const idx = y * 12 + (m - 1) + n;
  const ny = Math.floor(idx / 12);
  const nm = (idx % 12) + 1;
  return `${ny}-${pad(nm)}-${pad(Math.min(d, daysIn(ny, nm)))}`;
}

export function monthName(ym: string, style: 'long' | 'short' = 'long') {
  const { m } = parts(ym);
  const name = MONTHS_LONG[m - 1];
  return style === 'long' ? name : name.slice(0, 3);
}

export function monthYear(ym: string) {
  const { y, m } = parts(ym);
  return `${MONTHS_LONG[m - 1].slice(0, 3)} ${y}`;
}

export function longDate(iso: string) {
  const { y, m, d } = parts(iso);
  return `${MONTHS_LONG[m - 1].slice(0, 3)} ${d} ${y}`;
}

export function dayHeading(iso: string) {
  const { y, m, d } = parts(iso);
  const wd = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-CA', {
    weekday: 'long',
    timeZone: 'UTC',
  });
  return { weekday: wd, date: `${MONTHS_LONG[m - 1]} ${d}`, year: y };
}

function ordinal(n: number) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// Money ---------------------------------------------------------------------

export function money(n: number) {
  return cad.format(Math.round(n)).replace('-', '−');
}

export function signed(n: number) {
  const r = Math.round(n);
  if (r === 0) return cad.format(0);
  return `${r > 0 ? '+' : '−'}${cad.format(Math.abs(r))}`;
}

export function compactMoney(n: number) {
  const a = Math.abs(n);
  const sign = n < 0 ? '−' : '';
  if (a >= 1_000_000) return `${sign}$${(a / 1_000_000).toFixed(2)}M`;
  if (a >= 10_000) return `${sign}$${Math.round(a / 1000)}k`;
  if (a >= 1000) return `${sign}$${(a / 1000).toFixed(1)}k`;
  return `${sign}$${Math.round(a)}`;
}

// Periods -------------------------------------------------------------------

export type PeriodKey = 'month' | 'quarter' | 'year' | 'all';

export type Period = {
  key: PeriodKey;
  /** Segmented-control label. */
  tab: string;
  /** Running-text subject, e.g. "October". */
  title: string;
  from: string;
  to: string;
  months: number;
  partial: boolean;
  /** Last day of data, as a day-of-month. */
  day: number;
};

export const PERIOD_KEYS: PeriodKey[] = ['month', 'quarter', 'year', 'all'];

export function periodFor(ledger: Ledger, key: PeriodKey): Period {
  const { y, m, d } = parts(ledger.asOf);
  const partial = d < daysIn(y, m);
  const first = `${months(ledger)[0]}-01`;
  const startOf = (n: number) => shiftMonths(`${y}-${pad(m)}-01`, -(n - 1));
  const span = (from: string) => {
    const a = parts(from);
    return (y - a.y) * 12 + (m - a.m) + 1;
  };
  const base = { to: ledger.asOf, partial, day: d };
  switch (key) {
    case 'month':
      return {
        ...base,
        key,
        tab: monthName(ledger.asOf, 'short'),
        title: monthName(ledger.asOf),
        from: startOf(1),
        months: 1,
      };
    case 'quarter':
      return {
        ...base,
        key,
        tab: '3 months',
        title: 'The last three months',
        from: startOf(3),
        months: 3,
      };
    case 'year':
      return {
        ...base,
        key,
        tab: '12 months',
        title: 'The last twelve months',
        from: startOf(12),
        months: 12,
      };
    default:
      return {
        ...base,
        key: 'all',
        tab: 'All',
        title: `Since ${monthYear(first)}`,
        from: first,
        months: span(first),
      };
  }
}

/** The same window shifted back by k whole periods. */
export function shifted(p: Period, k: number) {
  return {
    from: shiftMonths(p.from, -k * p.months),
    to: shiftMonths(p.to, -k * p.months),
  };
}

/** Month key at which a period's charts start: at least twelve months back. */
export function chartStart(ledger: Ledger, p: Period) {
  if (p.key === 'all') return months(ledger)[0];
  return shiftMonths(ledger.asOf, -(Math.max(p.months, 12) - 1)).slice(0, 7);
}

// Totals --------------------------------------------------------------------

function inRange(t: Transaction, from: string, to: string) {
  return t.date >= from && t.date <= to;
}

export function totals(ledger: Ledger, from: string, to: string) {
  let spend = 0;
  let income = 0;
  const byLeaf = new Map<string, number>();
  for (const t of ledger.transactions) {
    if (!inRange(t, from, to)) continue;
    if (isSpend(t, ledger)) {
      spend -= t.amount;
      byLeaf.set(t.categoryId, (byLeaf.get(t.categoryId) ?? 0) - t.amount);
    } else if (isIncome(t, ledger)) income += t.amount;
  }
  return { spend, income, byLeaf };
}

function baselineWindows(ledger: Ledger, p: Period) {
  const first = `${months(ledger)[0]}-01`;
  const k = p.key === 'month' ? 12 : p.key === 'quarter' ? 4 : 1;
  if (p.key === 'all') return [];
  return Array.from({ length: k }, (_, i) => shifted(p, i + 1)).filter(
    (w) => w.from >= first,
  );
}

const BASELINE_NAME: Record<PeriodKey, string> = {
  month: 'its trailing twelve-month average',
  quarter: 'the average of the four quarters before it',
  year: 'the twelve months before',
  all: '',
};

// Narrative -----------------------------------------------------------------

export type Brief = {
  pull: { value: string; caption: string } | null;
  sentences: string[];
  uncategorised: number;
};

function lower(name: string) {
  return name.toLowerCase();
}

function listJoin(items: string[]) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

export function brief(ledger: Ledger, p: Period): Brief {
  const now = totals(ledger, p.from, p.to);
  const byId = categoryById(ledger);
  const windows = baselineWindows(ledger, p);
  const sentences: string[] = [];
  let pull: Brief['pull'] = null;

  const subject =
    p.key === 'month' && p.partial
      ? `${p.title}, through the ${ordinal(p.day)},`
      : p.title;

  if (windows.length) {
    const base = windows.map((w) => totals(ledger, w.from, w.to));
    const avg = base.reduce((s, b) => s + b.spend, 0) / base.length;
    const pct = avg ? ((now.spend - avg) / avg) * 100 : 0;
    const r = Math.round(Math.abs(pct));
    const how =
      r < 1 ? 'ran level with' : `ran ${r}% ${pct < 0 ? 'under' : 'over'}`;
    sentences.push(
      `${subject} ${how} ${BASELINE_NAME[p.key]}: ${money(now.spend)} spent against a typical ${money(avg)}.`,
    );
    pull = {
      value: r < 1 ? '±0%' : `${pct < 0 ? '−' : '+'}${r}%`,
      caption: `spending against ${BASELINE_NAME[p.key].replace(/^its /, 'the ')}`,
    };

    const leaves = new Set([
      ...now.byLeaf.keys(),
      ...base.flatMap((b) => [...b.byLeaf.keys()]),
    ]);
    const moves = [...leaves]
      .map((id) => {
        const was =
          base.reduce((s, b) => s + (b.byLeaf.get(id) ?? 0), 0) / base.length;
        const is = now.byLeaf.get(id) ?? 0;
        return { name: byId.get(id)?.name ?? id, delta: is - was, was };
      })
      .filter((m) => Math.abs(m.delta) >= Math.max(40, 0.02 * avg));
    const ups = moves
      .filter((m) => m.delta > 0)
      .sort((a, b) => b.delta - a.delta)
      .slice(0, 2);
    const downs = moves
      .filter((m) => m.delta < 0)
      .sort((a, b) => a.delta - b.delta)
      .slice(0, 2);
    const up = ups.map((m, i) =>
      i === 0
        ? `${m.name} ran ${money(m.delta)} above the usual`
        : `${lower(m.name)} ${money(m.delta)}`,
    );
    const gone = downs.filter((m) => m.was > 0 && -m.delta / m.was > 0.9);
    const lighter = downs.filter((m) => !gone.includes(m));
    const down = [
      ...lighter.map(
        (m) => `${lower(m.name)} came in ${money(-m.delta)} lighter`,
      ),
      ...(gone.length
        ? [`${listJoin(gone.map((m) => lower(m.name)))} all but vanished`]
        : []),
    ];
    if (up.length && down.length)
      sentences.push(`${listJoin(up)}; ${listJoin(down)}.`);
    else if (up.length) sentences.push(`${listJoin(up)}.`);
    else if (down.length) {
      const d = listJoin(down);
      sentences.push(`${d[0].toUpperCase()}${d.slice(1)}.`);
    }
  }

  const kept = now.income - now.spend;
  if (now.income > 0 && kept > 0) {
    sentences.push(
      `Of the ${money(now.income)} that came in, ${money(kept)} stayed: ${Math.round((kept / now.income) * 100)}% of income.`,
    );
  } else if (now.income > 0) {
    sentences.push(
      `Spending ran ${money(-kept)} ahead of income${
        p.key === 'month' && p.partial
          ? ', with the month’s later paycheques still to land'
          : ''
      }.`,
    );
  }

  const [top] = topMerchants(ledger, { from: p.from, to: p.to, limit: 1 });
  if (top && now.spend > 0) {
    const name = top.merchant === 'Mortgage' ? 'The mortgage' : top.merchant;
    sentences.push(
      `${name} was the largest single line at ${money(top.total)}, ${Math.round((top.total / now.spend) * 100)}% of everything spent.`,
    );
  }

  const uncategorised = ledger.transactions.filter(
    (t) => t.categoryId === 'uncategorized' && inRange(t, p.from, p.to),
  ).length;

  return { pull, sentences, uncategorised };
}

// Rankings ------------------------------------------------------------------

export type Ranked = {
  id: string;
  name: string;
  groupId: string;
  amount: number;
  prior: number;
};

export function rankCategories(ledger: Ledger, p: Period, limit = 9) {
  const now = totals(ledger, p.from, p.to);
  const prev = shifted(p, 1);
  const then = p.key === 'all' ? null : totals(ledger, prev.from, prev.to);
  const byId = categoryById(ledger);
  const rows: Ranked[] = [...now.byLeaf.entries()]
    .map(([id, amount]) => ({
      id,
      name: byId.get(id)?.name ?? id,
      groupId: topLevel(ledger, id).id,
      amount,
      prior: then?.byLeaf.get(id) ?? 0,
    }))
    .sort((a, b) => b.amount - a.amount);
  const head = rows.slice(0, limit);
  const tail = rows.slice(limit);
  if (tail.length)
    head.push({
      id: 'other',
      name: `${tail.length} more`,
      groupId: 'other',
      amount: tail.reduce((s, r) => s + r.amount, 0),
      prior: tail.reduce((s, r) => s + r.prior, 0),
    });
  return {
    rows: head,
    compare: then,
    priorLabel:
      p.key === 'month'
        ? `vs ${monthName(prev.from)}${p.partial ? ` 1–${p.day}` : ''}`
        : p.key === 'all'
          ? ''
          : 'vs the period before',
  };
}

export function merchantList(ledger: Ledger, p: Period, limit = 10) {
  const byId = categoryById(ledger);
  return topMerchants(ledger, { from: p.from, to: p.to, limit }).map((m) => ({
    ...m,
    categoryName: byId.get(m.categoryId)?.name ?? '',
    groupId: topLevel(ledger, m.categoryId).id,
  }));
}

// Charts --------------------------------------------------------------------

export function netWorthWindow(ledger: Ledger, p: Period) {
  const start = chartStart(ledger, p);
  return netWorthSeries(ledger).filter((pt) => pt.month >= start);
}

export function cashFlowWindow(ledger: Ledger, p: Period) {
  return cashFlow(ledger, { from: chartStart(ledger, p) });
}

/** Why the latest net-worth point is an estimate, in a sentence. */
export function estimateNote(ledger: Ledger) {
  const asOfMonth = ledger.asOf.slice(0, 7);
  const bits: string[] = [];
  const inv = ledger.holdings.filter((h) => h.date <= ledger.asOf);
  const lastInv = inv[inv.length - 1];
  if (lastInv && lastInv.date.slice(0, 7) !== asOfMonth)
    bits.push(
      `holdings carry forward the ${longDate(lastInv.date)} statements`,
    );
  const vals = ledger.valuations.filter((v) => v.date <= ledger.asOf);
  const lastVal = vals[vals.length - 1];
  if (lastVal && lastVal.date.slice(0, 7) !== asOfMonth)
    bits.push(
      `the house is the ${longDate(lastVal.date)} ${lastVal.source === 'estimate' ? 'estimate' : lastVal.source}`,
    );
  return bits.length ? `${bits.join('; ')}.` : '';
}

export type FlowNode = {
  id: string;
  name: string;
  kind: 'source' | 'group' | 'leaf';
  groupId: string;
};

export type FlowLink = { source: string; target: string; value: number };

/** derive.sankey, plus a "From savings" source when spending outran income. */
export function flow(ledger: Ledger, p: Period) {
  const base = sankey(ledger, { from: p.from, to: p.to });
  const nodes: FlowNode[] = base.nodes.map((n) => {
    const raw = n.id.replace(/^(grp|leaf):/, '');
    let groupId = 'income';
    if (n.id === 'leaf:saved') groupId = 'saved';
    else if (n.kind !== 'source' && n.id !== 'all')
      groupId = topLevel(ledger, raw).id;
    return { ...n, groupId };
  });
  const links: FlowLink[] = base.links.filter((l) => l.value > 0);
  const income = links
    .filter((l) => l.target === 'all')
    .reduce((s, l) => s + l.value, 0);
  const spent = links
    .filter((l) => l.source === 'all' && l.target !== 'leaf:saved')
    .reduce((s, l) => s + l.value, 0);
  if (spent > income) {
    nodes.push({
      id: 'src:savings',
      name: 'From savings',
      kind: 'source',
      groupId: 'drawn',
    });
    links.push({ source: 'src:savings', target: 'all', value: spent - income });
  }
  const saved = links.find((l) => l.target === 'leaf:saved')?.value ?? 0;
  return { nodes, links, income, spent, saved };
}

// Transactions --------------------------------------------------------------

export type Entry =
  | { kind: 'txn'; key: string; date: string; t: Transaction }
  | {
      kind: 'transfer';
      key: string;
      date: string;
      out: Transaction;
      in: Transaction | null;
    };

export function transferLegs(ledger: Ledger) {
  const legs = new Map<string, Transaction[]>();
  for (const t of ledger.transactions) {
    if (!t.transferId) continue;
    const l = legs.get(t.transferId) ?? [];
    l.push(t);
    legs.set(t.transferId, l);
  }
  return legs;
}

/** Collapse transfer legs into one entry and group entries by day, newest first. */
export function groupByDay(
  rows: Transaction[],
  legs: Map<string, Transaction[]>,
) {
  const seen = new Set<string>();
  const days: { date: string; entries: Entry[] }[] = [];
  const push = (e: Entry) => {
    const last = days[days.length - 1];
    if (last && last.date === e.date) last.entries.push(e);
    else days.push({ date: e.date, entries: [e] });
  };
  for (const t of rows) {
    if (t.transferId) {
      if (seen.has(t.transferId)) continue;
      seen.add(t.transferId);
      const pair = legs.get(t.transferId) ?? [t];
      const out = pair.find((x) => x.amount < 0) ?? t;
      const inn = pair.find((x) => x !== out) ?? null;
      push({ kind: 'transfer', key: t.transferId, date: t.date, out, in: inn });
    } else push({ kind: 'txn', key: t.id, date: t.date, t });
  }
  return days;
}

export function monogram(name: string) {
  const words = name
    .replace(/[^A-Za-z0-9 ]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return '?';
  if (words.length === 1) return words[0].slice(0, 1).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

// Accounts ------------------------------------------------------------------

export type SeriesPoint = { date: string; value: number };

export function accountSeries(
  ledger: Ledger,
  accountId: string,
  balances: ReturnType<typeof balancesByMonth>,
): SeriesPoint[] {
  const acct = ledger.accounts.find((a) => a.id === accountId);
  if (!acct) return [];
  if (acct.kind === 'investment')
    return ledger.holdings
      .filter((h) => h.accountId === accountId)
      .map((h) => ({ date: h.date, value: h.total }));
  if (acct.kind === 'asset')
    return ledger.valuations
      .filter((v) => v.accountId === accountId)
      .map((v) => ({ date: v.date, value: v.value }));
  if (acct.kind === 'mortgage')
    return ledger.assertions
      .filter((a) => a.accountId === accountId)
      .map((a) => ({ date: a.date, value: a.balance }));
  const last = lastActivity(ledger, accountId);
  const series = balances.get(accountId) ?? new Map<string, number>();
  return [...series.entries()]
    .filter(([m]) => !last || m <= last.slice(0, 7))
    .map(([m, value]) => ({ date: `${m}-01`, value }));
}

export function lastActivity(ledger: Ledger, accountId: string) {
  for (let i = ledger.transactions.length - 1; i >= 0; i--)
    if (ledger.transactions[i].accountId === accountId)
      return ledger.transactions[i].date;
  return null;
}

export function accountLabel(ledger: Ledger, accountId: string) {
  const a = ledger.accounts.find((x) => x.id === accountId);
  return a ? `${a.institution} ${a.name}` : accountId;
}
