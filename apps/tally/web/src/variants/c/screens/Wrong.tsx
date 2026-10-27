import {
  ArrowLeftRight,
  CalendarX2,
  Check,
  CircleCheck,
  Copy,
  type LucideIcon,
  Sparkles,
  Tags,
  Undo2,
} from 'lucide-react';
import type { ReactNode } from 'react';
import type { Finding } from '~/fixtures/types';
import {
  Answer,
  Aside,
  AsideSection,
  NumbersList,
  PrimaryButton,
  QuietButton,
} from '../bits';
import { actionsFor, FindingBody, useIssues } from '../findings';
import { categoryName, findingTitle, money, OUTCOME_TEXT } from '../model';
import { useTally } from '../store';

const ICON: Record<Finding['kind'], LucideIcon> = {
  duplicate: Copy,
  transfer: ArrowLeftRight,
  'missing-period': CalendarX2,
  'low-confidence': Sparkles,
};

function Shell({
  icon: Icon,
  title,
  tone,
  children,
  actions,
}: {
  icon: LucideIcon;
  title: string;
  tone: 'alert' | 'warm';
  children: ReactNode;
  actions: ReactNode;
}) {
  return (
    <article className="qc-in rounded-2xl bg-stone-50 p-4 ring-1 ring-stone-200/80 dark:bg-stone-900 dark:ring-stone-800">
      <header className="mb-3 flex items-center gap-2.5">
        <span
          className={`grid size-9 place-items-center rounded-xl ${
            tone === 'alert'
              ? 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300'
              : 'bg-amber-50 text-amber-700 dark:bg-amber-400/10 dark:text-amber-300'
          }`}
        >
          <Icon className="size-4.5" aria-hidden />
        </span>
        <h2 className="text-[1.05rem] font-semibold tracking-tight">{title}</h2>
      </header>
      {children}
      <div className="mt-4 flex gap-2">{actions}</div>
    </article>
  );
}

export function Wrong() {
  const { eff, base, go, resolve, unresolve, outcomes } = useTally();
  const issues = useIssues();
  const cat = (id: string) => categoryName(base, id);
  const uncTotal = issues.uncategorized.reduce((s, t) => s - t.amount, 0);
  const uncSample = Array.from(
    new Set(issues.uncategorized.slice(-12).map((t) => t.descriptor)),
  ).slice(0, 3);

  return (
    <div>
      <Answer
        question="Is anything wrong?"
        onBack={() => go({ question: null })}
        line={
          issues.count
            ? `${issues.count} thing${issues.count === 1 ? '' : 's'} need${issues.count === 1 ? 's' : ''} a look`
            : 'Nothing looks wrong'
        }
        sub={
          issues.count
            ? 'Each card has one thing to do. Nothing changes until you tap it.'
            : 'Every statement reconciles and every row has a home.'
        }
      />
      <div className="space-y-3 px-4">
        {issues.open.map((f) => {
          const { primary, secondary } = actionsFor(f, cat);
          return (
            <Shell
              key={f.id}
              icon={ICON[f.kind]}
              title={findingTitle(f)}
              tone={f.kind === 'missing-period' ? 'alert' : 'warm'}
              actions={
                <>
                  <PrimaryButton
                    className="flex-1"
                    onClick={() => resolve(f, primary.outcome)}
                  >
                    <Check className="size-4" aria-hidden />
                    {primary.label}
                  </PrimaryButton>
                  {f.kind === 'missing-period' ? (
                    <QuietButton
                      onClick={() =>
                        go({
                          tab: 'import',
                          question: null,
                          importStep: 'pick',
                        })
                      }
                    >
                      Find the export
                    </QuietButton>
                  ) : (
                    <QuietButton onClick={() => resolve(f, secondary.outcome)}>
                      {secondary.label}
                    </QuietButton>
                  )}
                </>
              }
            >
              <FindingBody f={f} />
            </Shell>
          );
        })}

        {issues.uncategorized.length ? (
          <Shell
            icon={Tags}
            tone="warm"
            title={`${issues.uncategorized.length} rows have no category`}
            actions={
              <PrimaryButton
                className="flex-1"
                onClick={() =>
                  go({
                    tab: 'ledger',
                    question: null,
                    ledgerCategory: 'uncategorized',
                    ledgerText: '',
                  })
                }
              >
                Sort them in the ledger
              </PrimaryButton>
            }
          >
            <p className="text-sm text-stone-600 dark:text-stone-400">
              {money(uncTotal)} of spending isn't counted in any group. Fixing
              one with “always” fixes the rest that look like it.
            </p>
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {uncSample.map((d) => (
                <li
                  key={d}
                  className="rounded-lg bg-white px-2 py-1 font-mono text-xs ring-1 ring-stone-200 dark:bg-stone-950/60 dark:ring-stone-800"
                >
                  {d}
                </li>
              ))}
            </ul>
          </Shell>
        ) : null}

        {issues.guesses.length ? (
          <button
            type="button"
            onClick={() =>
              go({ tab: 'import', question: null, importStep: 'review' })
            }
            className="flex min-h-14 w-full items-center gap-3 rounded-2xl px-4 text-left text-sm text-stone-600 ring-1 ring-stone-200 hover:bg-white dark:text-stone-400 dark:ring-stone-800 dark:hover:bg-stone-900"
          >
            <Sparkles
              className="size-4 text-amber-600 dark:text-amber-300"
              aria-hidden
            />
            <span className="flex-1">
              {issues.guesses.length} model guesses wait in the import review
            </span>
          </button>
        ) : null}

        {!issues.count ? (
          <div className="qc-in flex flex-col items-center rounded-2xl bg-white px-6 py-10 text-center ring-1 ring-stone-200 dark:bg-stone-900 dark:ring-stone-800">
            <CircleCheck className="size-10 text-[#0ca30c]" aria-hidden />
            <p className="mt-3 font-semibold">All clear</p>
            <p className="mt-1 text-sm text-stone-500">
              New findings show up here after the next import.
            </p>
          </div>
        ) : null}

        {issues.done.length ? (
          <section className="pt-4">
            <h2 className="mb-2 text-xs font-semibold tracking-wide text-stone-500 uppercase">
              Handled
            </h2>
            <ul className="divide-y divide-stone-200 rounded-2xl bg-white ring-1 ring-stone-200 dark:divide-stone-800 dark:bg-stone-900 dark:ring-stone-800">
              {issues.done.map((f) => (
                <li key={f.id} className="flex items-center gap-3 px-4 py-2.5">
                  <Check className="size-4 text-[#0ca30c]" aria-hidden />
                  <span className="min-w-0 flex-1 text-sm">
                    <span className="block truncate">{findingTitle(f)}</span>
                    <span className="text-xs text-stone-500">
                      {OUTCOME_TEXT[outcomes[f.id]]}
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => unresolve(f)}
                    className="inline-flex h-10 items-center gap-1 rounded-full px-3 text-xs font-medium text-stone-600 hover:bg-stone-100 dark:text-stone-400 dark:hover:bg-stone-800"
                  >
                    <Undo2 className="size-3.5" aria-hidden />
                    Undo
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
      <Aside>
        <AsideSection title="Health">
          <NumbersList
            rows={[
              { label: 'Open findings', value: String(issues.open.length) },
              {
                label: 'Uncategorised rows',
                value: String(issues.uncategorized.length),
              },
              {
                label: 'Model guesses waiting',
                value: String(issues.guesses.length),
              },
              {
                label: 'Handled this session',
                value: String(issues.done.length),
              },
              {
                label: 'Statements that reconcile',
                value: `${eff.assertions.filter((a) => a.ok).length} of ${eff.assertions.length}`,
              },
            ]}
          />
        </AsideSection>
      </Aside>
    </div>
  );
}
