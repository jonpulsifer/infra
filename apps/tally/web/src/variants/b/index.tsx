import { useEffect, useMemo, useState } from 'react';
import type { Rule } from '~/fixtures/types';
import type { Variant, VariantProps } from '~/prototype/variants';
import { Accounts } from './Accounts';
import { Segmented } from './bits';
import { Import } from './Import';
import { longDate, PERIOD_KEYS, type PeriodKey, periodFor } from './model';
import { Overview } from './Overview';
import { type Recategorise, Transactions } from './Transactions';
import { ThemeStyle } from './theme';

type Screen = 'dashboard' | 'transactions' | 'import' | 'accounts';

const NAV: { key: Screen; label: string }[] = [
  { key: 'dashboard', label: 'Overview' },
  { key: 'transactions', label: 'Transactions' },
  { key: 'import', label: 'Import' },
  { key: 'accounts', label: 'Accounts' },
];

function readScreen(): Screen {
  const s = new URLSearchParams(window.location.search).get('screen');
  return NAV.some((n) => n.key === s) ? (s as Screen) : 'dashboard';
}

function Editorial({ ledger: initial }: VariantProps) {
  const [ledger, setLedger] = useState(initial);
  const [screen, setScreen] = useState<Screen>(readScreen);
  const [periodKey, setPeriodKey] = useState<PeriodKey>(() => {
    const q = new URLSearchParams(window.location.search).get('period');
    return PERIOD_KEYS.includes(q as PeriodKey) ? (q as PeriodKey) : 'quarter';
  });
  const [txnFilter, setTxnFilter] = useState<{ category?: string; n: number }>({
    n: 0,
  });
  const [sessionRules, setSessionRules] = useState<Rule[]>([]);
  const [booted, setBooted] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setBooted(true), 400);
    return () => window.clearTimeout(t);
  }, []);
  const period = useMemo(
    () => periodFor(ledger, periodKey),
    [ledger, periodKey],
  );
  const periodOptions = useMemo(
    () => PERIOD_KEYS.map((k) => ({ key: k, label: periodFor(ledger, k).tab })),
    [ledger],
  );

  const go = (s: Screen) => {
    setScreen(s);
    window.scrollTo({ top: 0 });
  };

  const recategorise: Recategorise = (id, categoryId, always) => {
    const target = ledger.transactions.find((t) => t.id === id);
    if (!target) return 0;
    let moved = 0;
    const transactions = ledger.transactions.map((t) => {
      const same =
        always &&
        t.id !== id &&
        !t.transferId &&
        t.descriptor === target.descriptor &&
        t.categoryId !== categoryId;
      if (t.id === id) {
        if (t.categoryId !== categoryId) moved++;
        return {
          ...t,
          categoryId,
          source: 'manual' as const,
          confidence: null,
        };
      }
      if (same) {
        moved++;
        return { ...t, categoryId, source: 'rule' as const, confidence: null };
      }
      return t;
    });
    let rules = ledger.rules;
    if (always) {
      const rule: Rule = {
        id: `session-${target.descriptor}`,
        match: target.descriptor,
        categoryId,
        merchant: target.merchant,
        createdFrom: 'correction',
        hits: transactions.filter((t) => t.descriptor === target.descriptor)
          .length,
      };
      rules = [rule, ...ledger.rules.filter((r) => r.match !== rule.match)];
      setSessionRules((cur) => [
        rule,
        ...cur.filter((r) => r.match !== rule.match),
      ]);
    }
    setLedger({ ...ledger, transactions, rules });
    return moved;
  };

  return (
    <div
      className={`vb min-h-screen font-sans antialiased ${booted ? '' : 'vb-boot'}`}
    >
      <ThemeStyle />
      <header className="mx-auto flex max-w-[1240px] flex-wrap items-end justify-between gap-x-8 gap-y-2 px-5 pt-8 pb-5 sm:px-10">
        <button
          type="button"
          onClick={() => go('dashboard')}
          className="serif text-[32px] leading-none tracking-[-0.02em] text-(--ink)"
        >
          tally<span className="text-(--s1)">.</span>
        </button>
        <div className="text-[13px] leading-relaxed text-(--muted) sm:text-right">
          The household ledger of{' '}
          <span className="text-(--ink2)">{ledger.owner}</span>
          {ledger.viewers.length ? (
            <>
              , shared with{' '}
              <span className="text-(--ink2)">{ledger.viewers.join(', ')}</span>
            </>
          ) : null}
          <span className="mx-2 text-(--axis)">·</span>
          as of {longDate(ledger.asOf)}
        </div>
      </header>

      <nav className="sticky top-0 z-30 border-y border-(--hair) bg-(--page)/85 backdrop-blur-xl backdrop-saturate-150">
        <div className="mx-auto flex h-[68px] max-w-[1240px] items-center justify-between gap-4 px-5 sm:px-10">
          <div className="-mx-1 flex min-w-0 overflow-x-auto px-1 [scrollbar-width:none]">
            <div className="inline-flex rounded-full bg-(--sunk) p-1 ring-1 ring-(--hair)">
              {NAV.map((n) => {
                const on = n.key === screen;
                return (
                  <button
                    key={n.key}
                    type="button"
                    aria-current={on ? 'page' : undefined}
                    onClick={() => go(n.key)}
                    className={`rounded-full px-4 py-1.5 text-[14px] font-medium whitespace-nowrap transition-all duration-200 ${
                      on
                        ? 'bg-(--ink) text-(--page) shadow-[0_2px_8px_-2px_rgba(0,0,0,0.3)]'
                        : 'text-(--ink2) hover:text-(--ink)'
                    }`}
                  >
                    {n.label}
                  </button>
                );
              })}
            </div>
          </div>
          {screen === 'dashboard' ? (
            <div className="hidden md:block">
              <Segmented
                label="Period"
                options={periodOptions}
                value={periodKey}
                onChange={setPeriodKey}
              />
            </div>
          ) : null}
        </div>
      </nav>

      <main key={screen}>
        {screen === 'dashboard' ? (
          <>
            <div className="mx-auto max-w-[1240px] px-5 pt-6 md:hidden">
              <Segmented
                label="Period"
                options={periodOptions}
                value={periodKey}
                onChange={setPeriodKey}
              />
            </div>
            <Overview
              ledger={ledger}
              period={period}
              onReviewUncategorised={() => {
                setTxnFilter((f) => ({
                  category: 'uncategorized',
                  n: f.n + 1,
                }));
                go('transactions');
              }}
            />
          </>
        ) : null}
        {screen === 'transactions' ? (
          <Transactions
            key={txnFilter.n}
            ledger={ledger}
            sessionRules={sessionRules}
            initialCategory={txnFilter.category}
            onRecategorise={recategorise}
          />
        ) : null}
        {screen === 'import' ? (
          <Import
            ledger={ledger}
            onSeeTransactions={() => go('transactions')}
          />
        ) : null}
        {screen === 'accounts' ? <Accounts ledger={ledger} /> : null}
      </main>

      <footer className="border-t border-(--hair)">
        <div className="mx-auto flex max-w-[1240px] flex-wrap items-baseline justify-between gap-4 px-5 pt-8 pb-24 text-[13px] text-(--muted) sm:px-10">
          <span className="serif text-[18px] text-(--ink2)">tally.</span>
          <span>
            Synthetic ledger. Every figure here is invented; nothing leaves this
            page.
          </span>
        </div>
      </footer>
    </div>
  );
}

const variant: Variant = { name: 'Editorial', Component: Editorial };

export default variant;
