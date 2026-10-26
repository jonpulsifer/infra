import { ArrowDown, Sparkles } from 'lucide-react';
import { useMemo } from 'react';
import type { Finding, Transaction } from '~/fixtures/types';
import { GapTimeline } from './charts/Small';
import {
  accountName,
  categoryName,
  dayLabel,
  money,
  moneyCents,
  pct,
  txById,
} from './model';
import { type Outcome, useTally } from './store';

export type Action = { outcome: Outcome; label: string };

export function actionsFor(
  f: Finding,
  catName: (id: string) => string,
): { primary: Action; secondary: Action } {
  switch (f.kind) {
    case 'duplicate':
      return {
        primary: { outcome: 'merged', label: 'Merge' },
        secondary: { outcome: 'kept', label: 'Keep both' },
      };
    case 'transfer':
      return {
        primary: { outcome: 'linked', label: 'Link as transfer' },
        secondary: { outcome: 'kept', label: 'Keep separate' },
      };
    case 'missing-period':
      return {
        primary: { outcome: 'reviewed', label: 'Mark reviewed' },
        secondary: { outcome: 'skipped', label: 'Later' },
      };
    case 'low-confidence':
      return {
        primary: {
          outcome: 'accepted',
          label: `It's ${catName(f.suggestedCategoryId)}`,
        },
        secondary: { outcome: 'skipped', label: 'Leave it' },
      };
  }
}

export function useIssues() {
  const { base, eff, outcomes } = useTally();
  return useMemo(() => {
    const findings = base.preview.findings;
    const ledgerKinds = findings.filter((f) => f.kind !== 'low-confidence');
    const open = ledgerKinds.filter((f) => !outcomes[f.id]);
    const done = findings.filter((f) => outcomes[f.id]);
    const guesses = findings.filter(
      (f) => f.kind === 'low-confidence' && !outcomes[f.id],
    );
    const uncategorized = eff.transactions.filter(
      (t) => t.categoryId === 'uncategorized',
    );
    return {
      open,
      done,
      guesses,
      uncategorized,
      count: open.length + (uncategorized.length ? 1 : 0),
    };
  }, [base, eff, outcomes]);
}

function TxLine({ t, tag }: { t: Transaction; tag: string }) {
  const { base } = useTally();
  return (
    <div className="rounded-xl bg-white p-3 ring-1 ring-stone-200 dark:bg-stone-950/60 dark:ring-stone-800">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[11px] font-semibold tracking-wide text-stone-500 uppercase">
          {tag}
        </span>
        <span className="text-[0.95rem] font-semibold text-stone-900 tabular-nums dark:text-stone-50">
          {moneyCents(t.amount)}
        </span>
      </div>
      <div className="mt-1 truncate font-mono text-[13px] text-stone-800 dark:text-stone-200">
        {t.descriptor}
      </div>
      <div className="mt-0.5 text-xs text-stone-500">
        {dayLabel(t.date, true)} · {accountName(base, t.accountId)}
      </div>
    </div>
  );
}

export function FindingBody({ f }: { f: Finding }) {
  const { base } = useTally();
  const tx = useMemo(() => txById(base), [base]);
  switch (f.kind) {
    case 'duplicate': {
      const a = tx.get(f.transactionId);
      const b = tx.get(f.matchesId);
      return (
        <div className="space-y-2">
          <p className="text-sm text-stone-600 dark:text-stone-400">
            {f.reason}.
          </p>
          {a ? <TxLine t={a} tag="In this import" /> : null}
          {b ? <TxLine t={b} tag="Already in the ledger" /> : null}
        </div>
      );
    }
    case 'transfer': {
      const a = tx.get(f.outId);
      const b = tx.get(f.inId);
      return (
        <div className="space-y-2">
          <p className="text-sm text-stone-600 dark:text-stone-400">
            Same amount, opposite signs, {f.daysApart} day
            {f.daysApart === 1 ? '' : 's'} apart. Linked, it stops counting as
            spending.
          </p>
          {a ? (
            <TxLine t={a} tag={`Out of ${accountName(base, a.accountId)}`} />
          ) : null}
          <div className="flex justify-center text-stone-400">
            <ArrowDown className="size-4" aria-hidden />
          </div>
          {b ? (
            <TxLine t={b} tag={`Into ${accountName(base, b.accountId)}`} />
          ) : null}
        </div>
      );
    }
    case 'missing-period': {
      const acct = base.accounts.find((x) => x.id === f.accountId);
      const diff = f.expectedBalance - f.actualBalance;
      return (
        <div className="space-y-3">
          <p className="text-sm text-stone-600 dark:text-stone-400">
            The {acct?.institution} {acct?.name.toLowerCase()} statement says{' '}
            <strong className="font-semibold text-stone-900 dark:text-stone-100">
              {money(f.expectedBalance)}
            </strong>{' '}
            but the ledger adds up to{' '}
            <strong className="font-semibold text-stone-900 dark:text-stone-100">
              {money(f.actualBalance)}
            </strong>
            . {money(diff)} is unaccounted for.
          </p>
          <GapTimeline
            since={acct?.since ?? base.asOf}
            asOf={base.asOf}
            from={f.from}
            to={f.to}
          />
        </div>
      );
    }
    case 'low-confidence': {
      const t = tx.get(f.transactionId);
      if (!t) return null;
      return (
        <div className="space-y-3">
          <TxLine t={t} tag="New row" />
          <div className="flex items-center gap-2 rounded-xl bg-amber-50 px-3 py-2.5 text-sm text-amber-900 dark:bg-amber-400/10 dark:text-amber-100">
            <Sparkles className="size-4 shrink-0" aria-hidden />
            <span>
              The model guessed{' '}
              <strong className="font-semibold">
                {categoryName(base, f.suggestedCategoryId)}
              </strong>
              , {pct(f.confidence)} sure. No rule matched.
            </span>
          </div>
        </div>
      );
    }
  }
}
