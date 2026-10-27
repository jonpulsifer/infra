import {
  Inbox,
  Landmark,
  LayoutGrid,
  ListTree,
  Rows3,
  Search,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { months } from '~/fixtures/derive';
import type { Variant, VariantProps } from '~/prototype/variants';
import { Accounts } from './Accounts';
import { isTyping, Kbd, Segmented } from './bits';
import { Dashboard } from './Dashboard';
import { Import } from './Import';
import {
  initState,
  liveLedger,
  PERIODS,
  type PeriodKey,
  reduce,
  resolvePeriod,
  type Screen,
} from './model';
import { Rules } from './Rules';
import { Transactions } from './Transactions';
import { CSS, cx, palette, tw } from './theme';

const NAV: { key: Screen; label: string; key2: string; icon: typeof Rows3 }[] =
  [
    { key: 'dashboard', label: 'Dashboard', key2: 'd', icon: LayoutGrid },
    { key: 'transactions', label: 'Transactions', key2: 't', icon: Rows3 },
    { key: 'import', label: 'Import', key2: 'i', icon: Inbox },
    { key: 'accounts', label: 'Accounts', key2: 'a', icon: Landmark },
    { key: 'rules', label: 'Rules', key2: 'r', icon: ListTree },
  ];

const PLACEHOLDER: Record<Screen, string> = {
  dashboard: 'Filter the ledger: merchant or descriptor',
  transactions: 'Search merchant or descriptor',
  import: 'Search is off while reviewing an import',
  accounts: 'Filter accounts',
  rules: 'Filter rules',
};

function param(name: string) {
  return new URLSearchParams(window.location.search).get(name);
}

function DeskWritten({ ledger, dark }: VariantProps) {
  const [screen, setScreen] = useState<Screen>(() => {
    const s = param('screen');
    return NAV.some((n) => n.key === s) ? (s as Screen) : 'dashboard';
  });
  const [account] = useState(() => param('account') ?? undefined);
  const [periodKey, setPeriodKey] = useState<PeriodKey>(() => {
    const p = param('period');
    return PERIODS.some((x) => x.key === p) ? (p as PeriodKey) : 'ytd';
  });
  const [query, setQuery] = useState('');
  const [preset, setPreset] = useState<{ categoryId?: string }>({});
  const [state, dispatch] = useReducer(reduce, ledger, initState);
  const search = useRef<HTMLInputElement>(null);
  const chord = useRef<number>(0);
  const pal = palette(dark);

  const live = useMemo(
    () => liveLedger(ledger, state),
    [ledger, state.overrides, state.rules],
  );
  const allMonths = useMemo(() => months(ledger), [ledger]);
  const period = useMemo(
    () => resolvePeriod(periodKey, ledger.asOf, allMonths),
    [periodKey, ledger.asOf, allMonths],
  );

  const uncategorised = useMemo(
    () =>
      live.transactions.filter((t) => t.categoryId === 'uncategorized').length,
    [live],
  );
  const openFindings = ledger.preview.findings.filter(
    (f) => !state.resolutions[f.id],
  ).length;

  const go = (s: Screen) => {
    setScreen(s);
    if (s === 'import') setQuery('');
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '/' && !isTyping(e)) {
        e.preventDefault();
        search.current?.focus();
        search.current?.select();
        return;
      }
      if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'g') {
        chord.current = Date.now();
        return;
      }
      if (Date.now() - chord.current < 900) {
        const n = NAV.find((x) => x.key2 === e.key);
        chord.current = 0;
        if (n) {
          e.preventDefault();
          go(n.key);
          return;
        }
      }
      if (e.key === '[' || e.key === ']') {
        const i = PERIODS.findIndex((p) => p.key === periodKey);
        const next =
          PERIODS[
            (i + (e.key === ']' ? 1 : PERIODS.length - 1)) % PERIODS.length
          ];
        setPeriodKey(next.key);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const periodApplies = screen === 'dashboard' || screen === 'transactions';
  const counts: Partial<Record<Screen, number>> = {
    transactions: uncategorised,
    import: state.committed ? 0 : openFindings,
    rules: state.freshRules.length,
  };

  return (
    <div
      className={cx(
        'flex h-screen overflow-hidden text-[13px] antialiased',
        tw.surface,
        tw.ink,
      )}
    >
      <style>{CSS}</style>
      <nav
        className={cx(
          'flex w-[52px] shrink-0 flex-col border-r md:w-[188px]',
          tw.rail,
          tw.rule,
        )}
      >
        <div className="flex h-10 items-center gap-2 px-3">
          <span className="flex h-5 w-5 items-center justify-center rounded-[3px] bg-[#0b0b0b] dw-serif text-[14px] italic leading-none text-[#fcfcfb] dark:bg-[#f0efec] dark:text-[#141413]">
            t
          </span>
          <span className="hidden font-mono text-[12px] font-semibold tracking-tight md:inline">
            tally<span className={tw.ink3}>/written</span>
          </span>
        </div>
        <div className="flex flex-col gap-px px-2 pt-1">
          {NAV.map((n) => {
            const on = n.key === screen;
            const c = counts[n.key];
            return (
              <button
                type="button"
                key={n.key}
                onClick={() => go(n.key)}
                aria-current={on ? 'page' : undefined}
                className={cx(
                  'group flex h-7 items-center gap-2.5 rounded-[3px] px-2 text-left text-[12px] transition-colors',
                  on
                    ? 'bg-[#e6e5df] text-[#0b0b0b] dark:bg-[#232321] dark:text-[#f0efec]'
                    : cx(tw.ink2, 'hover:bg-[#ebeae5] dark:hover:bg-[#1a1a19]'),
                )}
              >
                <n.icon
                  size={14}
                  strokeWidth={on ? 2.2 : 1.8}
                  className="shrink-0"
                />
                <span className="hidden flex-1 md:inline">{n.label}</span>
                {c ? (
                  <span
                    className={cx(
                      'hidden rounded-[3px] px-1 font-mono text-[10px] tabular-nums md:inline',
                      n.key === 'rules'
                        ? 'bg-[#e3f1e3] text-[#006300] dark:bg-[#132313] dark:text-[#0ca30c]'
                        : 'bg-[#f8ecd0] text-[#7a5200] dark:bg-[#33280f] dark:text-[#fab219]',
                    )}
                  >
                    {n.key === 'rules' ? `+${c}` : c}
                  </span>
                ) : (
                  <span className="hidden opacity-0 transition-opacity group-hover:opacity-100 md:inline">
                    <Kbd>g {n.key2}</Kbd>
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <div
          className={cx(
            'mt-auto hidden border-t px-3 py-3 text-[11px] md:block',
            tw.rule,
            tw.ink3,
          )}
        >
          <div className={cx(tw.label, 'mb-1.5')}>Keys</div>
          <dl className="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1">
            {(
              [
                ['/', 'search'],
                ['g d…', 'go to'],
                ['[ ]', 'period'],
                ['j k', 'move'],
                ['a x', 'accept, dismiss'],
                ['esc', 'close'],
              ] as const
            ).map(([k, v]) => (
              <div key={k} className="contents">
                <dt>
                  <Kbd>{k}</Kbd>
                </dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
          <div className={cx('mt-3 border-t pt-2 leading-4', tw.rule)}>
            <div className={tw.ink2}>{ledger.owner}</div>
            <div>
              + {ledger.viewers.length} viewer · as of{' '}
              <span className={tw.num}>{ledger.asOf}</span>
            </div>
            <div>Synthetic ledger</div>
          </div>
        </div>
      </nav>

      <div className="flex min-w-0 flex-1 flex-col">
        <header
          className={cx(
            'flex h-10 shrink-0 items-center gap-3 border-b px-3',
            tw.rule,
          )}
        >
          <div className="relative flex max-w-[520px] flex-1 items-center">
            <Search
              size={13}
              className={cx('pointer-events-none absolute left-2', tw.ink3)}
            />
            <input
              ref={search}
              value={query}
              disabled={screen === 'import'}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  if (query) setQuery('');
                  else e.currentTarget.blur();
                }
                if (
                  e.key === 'Enter' &&
                  screen === 'dashboard' &&
                  query.trim()
                ) {
                  go('transactions');
                }
              }}
              placeholder={PLACEHOLDER[screen]}
              aria-label="Search"
              className={cx(tw.input, 'w-full pr-14 pl-7 disabled:opacity-50')}
            />
            <span className="absolute right-1.5 flex items-center gap-1">
              {query ? (
                <button
                  type="button"
                  aria-label="Clear search"
                  onClick={() => setQuery('')}
                  className={cx('rounded-[2px] p-0.5', tw.ink3, tw.hover)}
                >
                  <X size={12} />
                </button>
              ) : (
                <Kbd>/</Kbd>
              )}
            </span>
          </div>
          <div
            className={cx(
              'transition-opacity',
              !periodApplies && 'pointer-events-none opacity-35',
            )}
            title={
              periodApplies
                ? 'Period, [ and ] to step'
                : 'The period applies to Dashboard and Transactions'
            }
          >
            <Segmented
              options={PERIODS}
              value={periodKey}
              onChange={setPeriodKey}
            />
          </div>
          <div
            className={cx(
              'ml-auto hidden items-center gap-3 text-[11px] lg:flex',
              tw.ink3,
            )}
          >
            <span className={tw.num}>
              {live.transactions.length.toLocaleString('en-CA')} rows ·{' '}
              {ledger.accounts.length} accounts
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-[#0ca30c]" />
              in the lab
            </span>
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-auto">
          {screen === 'dashboard' ? (
            <div className="pb-16">
              <Dashboard
                ledger={live}
                pal={pal}
                period={period}
                query={query}
                openTransactions={(q) => {
                  if (q.text !== undefined) setQuery(q.text);
                  setPreset({ categoryId: q.categoryId });
                  go('transactions');
                }}
              />
            </div>
          ) : null}
          {screen === 'transactions' ? (
            <Transactions
              ledger={live}
              pal={pal}
              period={period}
              query={query}
              preset={preset}
              dispatch={dispatch}
              showRules={() => go('rules')}
            />
          ) : null}
          {screen === 'import' ? (
            <Import ledger={live} pal={pal} state={state} dispatch={dispatch} />
          ) : null}
          {screen === 'accounts' ? (
            <Accounts ledger={live} pal={pal} query={query} initial={account} />
          ) : null}
          {screen === 'rules' ? (
            <Rules
              ledger={live}
              pal={pal}
              query={query}
              fresh={state.freshRules}
            />
          ) : null}
        </main>
      </div>
    </div>
  );
}

const variant: Variant = { name: 'Desk, written', Component: DeskWritten };

export default variant;
