import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  cashFlow,
  categoryById,
  months as ledgerMonths,
  netWorthSeries,
} from '~/fixtures/derive';
import type { Finding, ImportBatch, Ledger, Rule } from '~/fixtures/types';
import {
  currentMonth,
  matchesRule,
  type Question,
  ruleMatchFor,
  spendByMonth,
  type Tab,
} from './model';
import { type Palette, palette } from './theme';

export type Outcome =
  | 'merged'
  | 'kept'
  | 'linked'
  | 'reviewed'
  | 'accepted'
  | 'skipped';

export type ImportStep = 'pick' | 'parse' | 'review' | 'summary' | null;

export type Nav = {
  tab: Tab;
  question: Question | null;
  importStep: ImportStep;
  ledgerCategory: string | null;
  ledgerText: string;
  account: string;
};

type Toast = { id: number; text: string };

function useTallyState(ledger: Ledger, dark: boolean, initial: Nav) {
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [userRules, setUserRules] = useState<Rule[]>([]);
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  const [removed, setRemoved] = useState<string[]>([]);
  const [imported, setImported] = useState<ImportBatch | null>(null);
  const [withheld, setWithheld] = useState<string[]>([]);
  const [toast, setToast] = useState<Toast | null>(null);
  const [flash, setFlash] = useState<string[]>([]);
  const [month, setMonth] = useState(() => currentMonth(ledger));
  const [nav, setNav] = useState<Nav>(initial);
  const toastTimer = useRef<number | undefined>(undefined);

  const eff = useMemo<Ledger>(() => {
    const gone = new Set(removed);
    return {
      ...ledger,
      transactions: ledger.transactions
        .filter((t) => !gone.has(t.id))
        .map((t) =>
          overrides[t.id]
            ? {
                ...t,
                categoryId: overrides[t.id],
                source: 'manual' as const,
                confidence: null,
              }
            : t,
        ),
      rules: [...userRules, ...ledger.rules],
      batches: imported ? [imported, ...ledger.batches] : ledger.batches,
    };
  }, [ledger, overrides, removed, userRules, imported]);

  const nw = useMemo(() => netWorthSeries(eff), [eff]);
  const spendMonths = useMemo(() => spendByMonth(eff), [eff]);
  const flows = useMemo(() => cashFlow(eff), [eff]);
  const months = useMemo(() => ledgerMonths(eff), [eff]);

  const say = useCallback((text: string) => {
    window.clearTimeout(toastTimer.current);
    setToast({ id: Date.now(), text });
    toastTimer.current = window.setTimeout(() => setToast(null), 3600);
  }, []);

  const markFlash = useCallback((ids: string[]) => {
    setFlash(ids);
    window.setTimeout(() => setFlash([]), 1600);
  }, []);

  const similar = useCallback(
    (descriptor: string) => {
      const match = ruleMatchFor(descriptor);
      return eff.transactions.filter((t) => matchesRule(t, match)).length;
    },
    [eff],
  );

  const recategorise = useCallback(
    (txId: string, categoryId: string, always: boolean) => {
      const tx = eff.transactions.find((t) => t.id === txId);
      if (!tx) return;
      const name = categoryById(eff).get(categoryId)?.name ?? categoryId;
      if (!always) {
        setOverrides((o) => ({ ...o, [txId]: categoryId }));
        markFlash([txId]);
        say(`${tx.merchant} is now ${name}`);
        return;
      }
      const match = ruleMatchFor(tx.descriptor);
      const hits = eff.transactions.filter((t) => matchesRule(t, match));
      setOverrides((o) => {
        const next = { ...o };
        for (const t of hits) next[t.id] = categoryId;
        return next;
      });
      setUserRules((r) => [
        {
          id: `u${Date.now()}`,
          match,
          categoryId,
          merchant: tx.merchant,
          createdFrom: 'correction',
          hits: hits.length,
        },
        ...r.filter((x) => x.match !== match),
      ]);
      markFlash(hits.map((t) => t.id));
      say(
        `Rule added: “${match}” → ${name}. ${hits.length} row${hits.length === 1 ? '' : 's'} changed`,
      );
    },
    [eff, say, markFlash],
  );

  const resolve = useCallback((f: Finding, o: Outcome) => {
    setOutcomes((x) => ({ ...x, [f.id]: o }));
    if (f.kind === 'duplicate' && o === 'merged')
      setRemoved((r) => [...r, f.transactionId]);
    if (f.kind === 'low-confidence' && o === 'accepted')
      setOverrides((x) => ({ ...x, [f.transactionId]: f.suggestedCategoryId }));
  }, []);

  const unresolve = useCallback((f: Finding) => {
    setOutcomes((x) => {
      const { [f.id]: _, ...rest } = x;
      return rest;
    });
    if (f.kind === 'duplicate')
      setRemoved((r) => r.filter((id) => id !== f.transactionId));
    if (f.kind === 'low-confidence')
      setOverrides((x) => {
        const { [f.transactionId]: _, ...rest } = x;
        return rest;
      });
  }, []);

  const toggleWithheld = useCallback((s: string) => {
    setWithheld((w) => (w.includes(s) ? w.filter((x) => x !== s) : [...w, s]));
  }, []);

  const doImport = useCallback(
    (rows: number, files: number) => {
      setImported({
        id: 'b-2026-10',
        importedAt: ledger.asOf,
        files,
        rows,
        note: 'October exports and a scanned Questrade statement',
      });
      say(`Imported ${rows} rows from ${files} files`);
    },
    [ledger.asOf, say],
  );

  const go = useCallback((next: Partial<Nav>) => {
    setNav((n) => ({ ...n, importStep: null, ...next }));
    window.scrollTo({ top: 0 });
  }, []);

  return {
    base: ledger,
    eff,
    dark,
    pal: palette(dark) as Palette,
    nw,
    spendMonths,
    flows,
    months,
    month,
    setMonth,
    overrides,
    userRules,
    outcomes,
    resolve,
    unresolve,
    recategorise,
    similar,
    imported,
    doImport,
    withheld,
    toggleWithheld,
    toast,
    say,
    flash,
    nav,
    go,
  };
}

export type Tally = ReturnType<typeof useTallyState>;

const Ctx = createContext<Tally | null>(null);

export function TallyProvider({
  ledger,
  dark,
  initial,
  children,
}: {
  ledger: Ledger;
  dark: boolean;
  initial: Nav;
  children: ReactNode;
}) {
  const value = useTallyState(ledger, dark, initial);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTally() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useTally outside TallyProvider');
  return v;
}
