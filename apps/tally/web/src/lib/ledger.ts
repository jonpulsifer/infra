import { accountValues, monthKey, topOf } from '~/fixtures/derive';
import type { Category, Finding, Ledger, Transaction } from '~/fixtures/types';
import { addMonths } from './dates';

export function topResolver(categories: Category[]) {
  return (id: string): Category => topOf(categories, id);
}

/** The rule pattern a correction proposes: the descriptor's first two words. */
export function patternFor(t: Transaction) {
  return t.descriptor.split(/\s+/).slice(0, 2).join(' ');
}

export function similarTo(
  ledger: Ledger,
  pattern: string,
  categoryId: string,
  exceptId: string,
) {
  const p = pattern.toLowerCase();
  return ledger.transactions.filter(
    (x) =>
      x.id !== exceptId &&
      !x.transferId &&
      x.categoryId !== categoryId &&
      x.descriptor.toLowerCase().includes(p),
  );
}

export function categoryOptions(categories: Category[]) {
  const out: { id: string; label: string; group: string }[] = [];
  for (const top of categories.filter((c) => !c.parentId)) {
    if (top.flow === 'transfer') continue;
    const kids = categories.filter((c) => c.parentId === top.id);
    if (!kids.length)
      out.push({ id: top.id, label: top.name, group: top.name });
    for (const k of kids)
      out.push({ id: k.id, label: k.name, group: top.name });
  }
  return out;
}

export type LedgerRow =
  | { kind: 'txn'; t: Transaction }
  | { kind: 'transfer'; out: Transaction; in: Transaction | null };

export function transferIndex(ledger: Ledger) {
  const idx = new Map<string, Transaction[]>();
  for (const t of ledger.transactions) {
    if (!t.transferId) continue;
    const legs = idx.get(t.transferId) ?? [];
    legs.push(t);
    idx.set(t.transferId, legs);
  }
  return idx;
}

/** Collapse transfer legs into one row, latest first. */
export function toRows(
  list: Transaction[],
  idx: Map<string, Transaction[]>,
  limit: number,
) {
  const seen = new Set<string>();
  const rows: LedgerRow[] = [];
  for (const t of list) {
    if (rows.length >= limit) break;
    if (!t.transferId) {
      rows.push({ kind: 'txn', t });
      continue;
    }
    if (seen.has(t.transferId)) continue;
    seen.add(t.transferId);
    const legs = idx.get(t.transferId) ?? [t];
    const out = legs.find((l) => l.amount < 0) ?? t;
    const inn = legs.find((l) => l.id !== out.id) ?? null;
    rows.push({ kind: 'transfer', out, in: inn });
  }
  return rows;
}

/** Month-end value of each account over every ledger month; null before it opened. */
export function accountSeries(ledger: Ledger) {
  const { months: ms, values } = accountValues(ledger);
  const series = new Map<string, (number | null)[]>();
  for (const a of ledger.accounts) {
    const v = values.get(a.id) ?? [];
    series.set(
      a.id,
      ms.map((m, i) =>
        monthKey(a.since) > m || !v[i]?.stated ? null : v[i].cents / 100,
      ),
    );
  }
  return { months: ms, series };
}

export type LadderRung = {
  month: string;
  inflow: number | null;
  outflow: number | null;
  close: number;
  gap: boolean;
  statement: number | null;
};

/** Month-end balances around a missing period, anchored on the ledger's balance at the gap. */
export function ladder(
  ledger: Ledger,
  f: Extract<Finding, { kind: 'missing-period' }>,
): LadderRung[] {
  const g0 = monthKey(f.from);
  const g1 = monthKey(f.to);
  const flows = new Map<string, { in: number; out: number }>();
  for (const t of ledger.transactions) {
    if (t.accountId !== f.accountId) continue;
    const m = monthKey(t.date);
    const r = flows.get(m) ?? { in: 0, out: 0 };
    if (t.amount > 0) r.in += t.amount;
    else r.out += t.amount;
    flows.set(m, r);
  }
  const before = [-3, -2, -1].map((n) => addMonths(g0, n));
  const gap: string[] = [];
  for (let m = g0; m <= g1; m = addMonths(m, 1)) gap.push(m);
  const after = [1, 2].map((n) => addMonths(g1, n));
  const rungs: LadderRung[] = [];
  let close = f.actualBalance;
  const pre: LadderRung[] = [];
  for (const m of [...before].reverse()) {
    pre.unshift({
      month: m,
      inflow: flows.get(m)?.in ?? 0,
      outflow: flows.get(m)?.out ?? 0,
      close,
      gap: false,
      statement: null,
    });
    const r = flows.get(m) ?? { in: 0, out: 0 };
    close -= r.in + r.out;
  }
  rungs.push(...pre);
  for (const m of gap)
    rungs.push({
      month: m,
      inflow: null,
      outflow: null,
      close: f.actualBalance,
      gap: true,
      statement: m === g1 ? f.expectedBalance : null,
    });
  close = f.actualBalance;
  for (const m of after) {
    const r = flows.get(m) ?? { in: 0, out: 0 };
    close += r.in + r.out;
    rungs.push({
      month: m,
      inflow: r.in,
      outflow: r.out,
      close,
      gap: false,
      statement: null,
    });
  }
  return rungs;
}
