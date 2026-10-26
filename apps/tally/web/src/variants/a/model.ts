import { balancesByMonth, monthKey, months } from '~/fixtures/derive';
import type {
  Account,
  Category,
  Finding,
  Ledger,
  PreviewFile,
  Rule,
  Transaction,
} from '~/fixtures/types';
import { addMonths } from './period';

export type Screen =
  | 'dashboard'
  | 'transactions'
  | 'import'
  | 'accounts'
  | 'rules';

export type Resolution = 'accepted' | 'dismissed';

export type DeskState = {
  overrides: Record<string, string>;
  rules: Rule[];
  freshRules: string[];
  resolutions: Record<string, Resolution>;
  withheld: string[];
  fileAccounts: Record<string, string>;
  addedFiles: PreviewFile[];
  committed: boolean;
};

export type Action =
  | { type: 'recategorise'; ids: string[]; categoryId: string }
  | { type: 'addRule'; rule: Rule; ids: string[] }
  | { type: 'resolve'; id: string; resolution: Resolution | null }
  | { type: 'withhold'; value: string }
  | { type: 'assignFile'; name: string; accountId: string }
  | { type: 'addFiles'; files: PreviewFile[] }
  | { type: 'commit' };

export function initState(ledger: Ledger): DeskState {
  return {
    overrides: {},
    rules: ledger.rules,
    freshRules: [],
    resolutions: {},
    withheld: [],
    fileAccounts: {},
    addedFiles: [],
    committed: false,
  };
}

function assign(
  overrides: Record<string, string>,
  ids: string[],
  categoryId: string,
) {
  const next = { ...overrides };
  for (const id of ids) next[id] = categoryId;
  return next;
}

export function reduce(state: DeskState, action: Action): DeskState {
  switch (action.type) {
    case 'recategorise':
      return {
        ...state,
        overrides: assign(state.overrides, action.ids, action.categoryId),
      };
    case 'addRule':
      return {
        ...state,
        rules: [action.rule, ...state.rules],
        freshRules: [action.rule.id, ...state.freshRules],
        overrides: assign(state.overrides, action.ids, action.rule.categoryId),
      };
    case 'resolve': {
      const resolutions = { ...state.resolutions };
      if (action.resolution) resolutions[action.id] = action.resolution;
      else delete resolutions[action.id];
      return { ...state, resolutions };
    }
    case 'withhold':
      return {
        ...state,
        withheld: state.withheld.includes(action.value)
          ? state.withheld.filter((s) => s !== action.value)
          : [...state.withheld, action.value],
      };
    case 'assignFile':
      return {
        ...state,
        fileAccounts: {
          ...state.fileAccounts,
          [action.name]: action.accountId,
        },
      };
    case 'addFiles':
      return { ...state, addedFiles: [...state.addedFiles, ...action.files] };
    case 'commit':
      return { ...state, committed: true };
  }
}

export function liveLedger(ledger: Ledger, state: DeskState): Ledger {
  const ids = Object.keys(state.overrides);
  if (!ids.length && state.rules === ledger.rules) return ledger;
  return {
    ...ledger,
    rules: state.rules,
    transactions: ledger.transactions.map((t) => {
      const c = state.overrides[t.id];
      return c && c !== t.categoryId
        ? { ...t, categoryId: c, source: 'manual' as const, confidence: null }
        : t;
    }),
  };
}

export function topResolver(categories: Category[]) {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const cache = new Map<string, Category>();
  return (id: string): Category => {
    const hit = cache.get(id);
    if (hit) return hit;
    let c = byId.get(id) ?? byId.get('uncategorized')!;
    while (c.parentId) c = byId.get(c.parentId)!;
    cache.set(id, c);
    return c;
  };
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

/** Month-end value of each account over every ledger month. */
export function accountSeries(ledger: Ledger) {
  const ms = months(ledger);
  const bal = balancesByMonth(ledger);
  const out = new Map<string, (number | null)[]>();
  const carry = (
    acct: Account,
    points: { date: string; value: number }[],
  ): (number | null)[] => {
    let i = 0;
    let last: number | null = null;
    return ms.map((m) => {
      while (i < points.length && monthKey(points[i].date) <= m) {
        last = points[i].value;
        i++;
      }
      return monthKey(acct.since) > m ? null : last;
    });
  };
  for (const a of ledger.accounts) {
    if (a.kind === 'investment') {
      out.set(
        a.id,
        carry(
          a,
          ledger.holdings
            .filter((h) => h.accountId === a.id)
            .map((h) => ({ date: h.date, value: h.total })),
        ),
      );
    } else if (a.kind === 'asset') {
      out.set(
        a.id,
        carry(
          a,
          ledger.valuations
            .filter((v) => v.accountId === a.id)
            .map((v) => ({ date: v.date, value: v.value })),
        ),
      );
    } else if (a.kind === 'mortgage') {
      out.set(
        a.id,
        carry(
          a,
          ledger.assertions
            .filter((x) => x.accountId === a.id)
            .map((x) => ({ date: x.date, value: x.balance })),
        ),
      );
    } else {
      const s = bal.get(a.id)!;
      out.set(
        a.id,
        ms.map((m) => s.get(m) ?? null),
      );
    }
  }
  return { months: ms, series: out };
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
