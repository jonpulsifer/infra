// Pure derivations for Reader and inspector. The ledger reducer, periods and
// tokens come from the Desk variant; the narrative and the inspector's
// subjects live here.

import {
  categoryById,
  isIncome,
  isSpend,
  monthKey,
  months,
  type NetWorthPoint,
  netWorthSeries,
  sankey,
  topLevel,
  topMerchants,
} from '~/fixtures/derive';
import type { Ledger, Rule, Transaction } from '~/fixtures/types';
import type { Period, PeriodKey } from '~/variants/a/period';
import { money } from '~/variants/a/theme';

export type Screen =
  | 'dashboard'
  | 'transactions'
  | 'import'
  | 'accounts'
  | 'rules';

/** What the inspector is showing. */
export type Subject =
  | { kind: 'month'; month: string }
  | { kind: 'category'; id: string }
  | { kind: 'source'; merchant: string }
  | { kind: 'merchant'; merchant: string }
  | { kind: 'flow'; month: string }
  | { kind: 'kept' };

export function sameSubject(a: Subject | null, b: Subject | null) {
  if (!a || !b) return a === b;
  return subjectKey(a) === subjectKey(b);
}

export function subjectKey(s: Subject) {
  switch (s.kind) {
    case 'month':
    case 'flow':
      return `${s.kind}:${s.month}`;
    case 'category':
      return `category:${s.id}`;
    case 'source':
    case 'merchant':
      return `${s.kind}:${s.merchant}`;
    case 'kept':
      return 'kept';
  }
}

// Dates ---------------------------------------------------------------------

const MONTHS_LONG =
  'January February March April May June July August September October November December'.split(
    ' ',
  );

function daysIn(y: number, m: number) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Shift an ISO date by whole months, clamping the day. */
export function shiftIso(iso: string, n: number) {
  const [y, m, d] = iso.split('-').map(Number);
  const idx = y * 12 + (m - 1) + n;
  const ny = Math.floor(idx / 12);
  const nm = (idx % 12) + 1;
  const day = Math.min(d || 1, daysIn(ny, nm));
  return `${ny}-${String(nm).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function longDate(iso: string) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${MONTHS_LONG[m - 1].slice(0, 3)} ${d}, ${y}`;
}

export function monthName(ym: string) {
  return MONTHS_LONG[Number(ym.slice(5, 7)) - 1];
}

function ordinal(n: number) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/** How a period reads in running text. */
export function periodPhrase(p: Period, asOf: string) {
  const day = Number(asOf.slice(8, 10));
  const partial =
    day < daysIn(Number(asOf.slice(0, 4)), Number(asOf.slice(5, 7)));
  switch (p.key) {
    case 'month':
      return {
        subject: partial
          ? `${monthName(p.toM)}, through the ${ordinal(day)},`
          : monthName(p.toM),
        title: monthName(p.toM),
        inline: `in ${monthName(p.toM)}`,
      };
    case 'last3':
      return {
        subject: 'The last three months',
        title: 'The last three months',
        inline: 'over the last three months',
      };
    case 'ytd':
      return {
        subject: `${asOf.slice(0, 4)} so far`,
        title: `${asOf.slice(0, 4)} so far`,
        inline: `in ${asOf.slice(0, 4)} so far`,
      };
    case 'y2025':
      return { subject: '2025', title: '2025', inline: 'in 2025' };
    default:
      return {
        subject: `Since ${monthName(p.fromM)} ${p.fromM.slice(0, 4)}`,
        title: 'Everything on record',
        inline: 'since the ledger began',
      };
  }
}

/** How far back the "period before" sits, in months. */
const SHIFT: Record<PeriodKey, number> = {
  month: 1,
  last3: 3,
  ytd: 12,
  y2025: 12,
  all: 0,
};

function baselineWindows(ledger: Ledger, p: Period) {
  const first = `${months(ledger)[0]}-01`;
  const n = p.key === 'month' ? 12 : p.key === 'last3' ? 4 : 1;
  if (p.key === 'all') return [];
  return Array.from({ length: n }, (_, i) => ({
    from: shiftIso(p.from, -SHIFT[p.key] * (i + 1)),
    to: shiftIso(p.to, -SHIFT[p.key] * (i + 1)),
  })).filter((w) => w.from >= first);
}

const BASELINE_NAME: Record<PeriodKey, string> = {
  month: 'its trailing twelve-month average',
  last3: 'the four quarters before it',
  ytd: 'the same stretch of last year',
  y2025: '2024',
  all: '',
};

// Totals --------------------------------------------------------------------

export function totals(ledger: Ledger, from: string, to: string) {
  let spend = 0;
  let income = 0;
  const byLeaf = new Map<string, number>();
  for (const t of ledger.transactions) {
    if (t.date < from || t.date > to) continue;
    if (isSpend(t, ledger)) {
      spend -= t.amount;
      byLeaf.set(t.categoryId, (byLeaf.get(t.categoryId) ?? 0) - t.amount);
    } else if (isIncome(t, ledger)) income += t.amount;
  }
  return { spend, income, byLeaf };
}

// Narrative -----------------------------------------------------------------

export type Brief = {
  pull: { value: string; caption: string } | null;
  sentences: string[];
};

function listJoin(items: string[]) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

const whole = (n: number) => money(Math.round(n), false);

export function brief(ledger: Ledger, p: Period): Brief {
  const now = totals(ledger, p.from, p.to);
  const byId = categoryById(ledger);
  const windows = baselineWindows(ledger, p);
  const phrase = periodPhrase(p, ledger.asOf);
  const sentences: string[] = [];
  let pull: Brief['pull'] = null;

  if (windows.length) {
    const base = windows.map((w) => totals(ledger, w.from, w.to));
    const avg = base.reduce((s, b) => s + b.spend, 0) / base.length;
    const pct = avg ? ((now.spend - avg) / avg) * 100 : 0;
    const r = Math.round(Math.abs(pct));
    const how =
      r < 1 ? 'ran level with' : `ran ${r}% ${pct < 0 ? 'under' : 'over'}`;
    sentences.push(
      `${phrase.subject} ${how} ${BASELINE_NAME[p.key]}: ${whole(now.spend)} spent against a typical ${whole(avg)}.`,
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
        ? `${m.name} ran ${whole(m.delta)} above the usual`
        : `${m.name.toLowerCase()} ${whole(m.delta)}`,
    );
    const gone = downs.filter((m) => m.was > 0 && -m.delta / m.was > 0.9);
    const lighter = downs.filter((m) => !gone.includes(m));
    const down = [
      ...lighter.map(
        (m) => `${m.name.toLowerCase()} came in ${whole(-m.delta)} lighter`,
      ),
      ...(gone.length
        ? [
            `${listJoin(gone.map((m) => m.name.toLowerCase()))} all but vanished`,
          ]
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
  if (now.income > 0 && kept > 0)
    sentences.push(
      `Of the ${whole(now.income)} that came in, ${whole(kept)} stayed: ${Math.round((kept / now.income) * 100)}% of income.`,
    );
  else if (now.income > 0)
    sentences.push(
      `Spending ran ${whole(-kept)} ahead of income${p.key === 'month' ? ', with the month’s later paycheques still to land' : ''}.`,
    );

  const [top] = topMerchants(ledger, { from: p.from, to: p.to, limit: 1 });
  if (top && now.spend > 0) {
    const name = top.merchant === 'Mortgage' ? 'The mortgage' : top.merchant;
    sentences.push(
      `${name} was the largest single line at ${whole(top.total)}, ${Math.round((top.total / now.spend) * 100)}% of everything spent.`,
    );
  }
  return { pull, sentences };
}

// Rankings ------------------------------------------------------------------

export type Ranked = {
  id: string;
  name: string;
  groupId: string;
  amount: number;
  prior: number | null;
};

export function rankCategories(ledger: Ledger, p: Period, limit = 9) {
  const now = totals(ledger, p.from, p.to);
  const shift = SHIFT[p.key];
  const then = shift
    ? totals(ledger, shiftIso(p.from, -shift), shiftIso(p.to, -shift))
    : null;
  const byId = categoryById(ledger);
  const rows: Ranked[] = [...now.byLeaf.entries()]
    .map(([id, amount]) => ({
      id,
      name: byId.get(id)?.name ?? id,
      groupId: topLevel(ledger, id).id,
      amount,
      prior: then ? (then.byLeaf.get(id) ?? 0) : null,
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
      prior: then ? tail.reduce((s, r) => s + (r.prior ?? 0), 0) : null,
    });
  const priorLabel =
    p.key === 'month'
      ? `vs ${monthName(shiftIso(p.from, -1))}, same days`
      : p.key === 'last3'
        ? 'vs the three months before'
        : p.key === 'ytd'
          ? `vs the same months of ${Number(p.toM.slice(0, 4)) - 1}`
          : p.key === 'y2025'
            ? 'vs 2024'
            : '';
  return { rows: head, priorLabel };
}

export function merchantList(ledger: Ledger, p: Period, limit = 10) {
  const byId = categoryById(ledger);
  return topMerchants(ledger, { from: p.from, to: p.to, limit }).map((m) => ({
    ...m,
    categoryName: byId.get(m.categoryId)?.name ?? '',
    groupId: topLevel(ledger, m.categoryId).id,
  }));
}

// The flow ------------------------------------------------------------------

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

/** Which inspector subject a Sankey node stands for. */
export function nodeSubject(id: string): Subject {
  if (id === 'all' || id === 'leaf:saved' || id === 'src:savings')
    return { kind: 'kept' };
  if (id.startsWith('src:')) return { kind: 'source', merchant: id.slice(4) };
  return { kind: 'category', id: id.replace(/^(grp|leaf):/, '') };
}

/** A ribbon stands for whatever it flows into, or its source when it feeds income. */
export function linkSubject(source: string, target: string): Subject {
  return target === 'all' ? nodeSubject(source) : nodeSubject(target);
}

// Net worth -----------------------------------------------------------------

export const NW_PARTS = [
  { key: 'house', label: 'House' },
  { key: 'investments', label: 'Investments' },
  { key: 'cash', label: 'Cash & credit' },
  { key: 'mortgage', label: 'Mortgage' },
] as const;

export type NwKey = (typeof NW_PARTS)[number]['key'];

export function netWorthWindow(ledger: Ledger, p: Period) {
  const start = p.window[0];
  return netWorthSeries(ledger).filter(
    (pt) => pt.month >= start && pt.month <= p.toM,
  );
}

/** Where each net-worth component comes from at a month end. */
export function provenance(ledger: Ledger, month: string) {
  const end = `${month}-31`;
  const out: Record<NwKey, { date: string | null; note: string }> = {
    house: { date: null, note: '' },
    investments: { date: null, note: '' },
    cash: { date: null, note: '' },
    mortgage: { date: null, note: '' },
  };
  const v = ledger.valuations.filter((x) => x.date <= end).slice(-1)[0];
  if (v) out.house = { date: v.date, note: v.source };
  const inv = ledger.holdings.filter((h) => h.date <= end);
  const last = inv[inv.length - 1];
  if (last)
    out.investments = {
      date: last.date,
      note: last.origin === 'statement-pdf' ? 'scanned statement' : 'export',
    };
  const m = ledger.assertions
    .filter((a) => a.accountId === 'mortgage' && a.date <= end)
    .slice(-1)[0];
  if (m) out.mortgage = { date: m.date, note: 'statement' };
  out.cash = { date: null, note: 'running balance' };
  return out;
}

export function pointFor(points: NetWorthPoint[], month: string) {
  const i = points.findIndex((p) => p.month === month);
  return { now: points[i] ?? null, prev: i > 0 ? points[i - 1] : null };
}

// Rows behind a subject ------------------------------------------------------

export function categoryRows(
  ledger: Ledger,
  id: string,
  from: string,
  to: string,
  top: (id: string) => { id: string },
) {
  return ledger.transactions.filter(
    (t) =>
      isSpend(t, ledger) &&
      (t.categoryId === id || top(t.categoryId).id === id) &&
      t.date >= from &&
      t.date <= to,
  );
}

export function merchantRows(
  ledger: Ledger,
  merchant: string,
  from: string,
  to: string,
  income = false,
) {
  return ledger.transactions.filter(
    (t) =>
      t.merchant === merchant &&
      !t.transferId &&
      (income ? isIncome(t, ledger) : isSpend(t, ledger)) &&
      t.date >= from &&
      t.date <= to,
  );
}

/** Sum of -amount (or +amount) per month over a window. */
export function byMonth(rows: Transaction[], window: string[], sign = -1) {
  const m = new Map<string, number>();
  for (const t of rows)
    m.set(monthKey(t.date), (m.get(monthKey(t.date)) ?? 0) + sign * t.amount);
  return window.map((k) => ({ month: k, value: m.get(k) ?? 0 }));
}

/** The first rule, top to bottom, whose pattern the descriptor contains. */
export function ruleFor(ledger: Ledger, t: Transaction): Rule | null {
  const d = t.descriptor.toLowerCase();
  return ledger.rules.find((r) => d.includes(r.match.toLowerCase())) ?? null;
}

export function rowsMatching(ledger: Ledger, rule: Rule) {
  const p = rule.match.toLowerCase();
  return ledger.transactions.filter((t) =>
    t.descriptor.toLowerCase().includes(p),
  );
}

export function latestFirst(rows: Transaction[]) {
  return [...rows].sort((a, b) =>
    a.date < b.date ? 1 : a.date > b.date ? -1 : 0,
  );
}
