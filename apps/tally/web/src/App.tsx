import {
  BookOpen,
  Inbox,
  Landmark,
  ListTree,
  Moon,
  Rows3,
  Search,
  Sun,
  X,
} from 'lucide-react';
import {
  type Dispatch,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import { type Api, connect, type Me } from '~/api/client';
import { Kbd, Segmented } from '~/components/bits';
import { CSS, serif } from '~/components/ui';
import { months, UNCATEGORIZED } from '~/fixtures/derive';
import type { Ledger, Rule, Transaction } from '~/fixtures/types';
import { today } from '~/lib/dates';
import { isTyping } from '~/lib/keys';
import {
  PERIOD_KEYS,
  type PeriodKey,
  periodOptions,
  resolvePeriod,
} from '~/lib/period';
import {
  type Action,
  decisionsFor,
  initState,
  liveLedger,
  reduce,
  type Screen,
  type State,
} from '~/lib/store';
import { cx, palette, tw } from '~/lib/theme';
import { type AccountOps, Accounts } from '~/screens/Accounts';
import { Import } from '~/screens/Import';
import { Reader } from '~/screens/Reader';
import { Rules } from '~/screens/Rules';
import { Transactions } from '~/screens/Transactions';

const NAV: { key: Screen; label: string; key2: string; icon: typeof Rows3 }[] =
  [
    { key: 'dashboard', label: 'Reader', key2: 'd', icon: BookOpen },
    { key: 'transactions', label: 'Transactions', key2: 't', icon: Rows3 },
    { key: 'import', label: 'Import', key2: 'i', icon: Inbox },
    { key: 'accounts', label: 'Accounts', key2: 'a', icon: Landmark },
    { key: 'rules', label: 'Rules', key2: 'r', icon: ListTree },
  ];

const PLACEHOLDER: Record<Screen, string> = {
  dashboard: 'Scope the reader: merchant or descriptor',
  transactions: 'Search merchant or descriptor',
  import: 'Search is off while reviewing an import',
  accounts: 'Filter accounts',
  rules: 'Filter rules',
};

function param(name: string) {
  return new URLSearchParams(window.location.search).get(name);
}

function setParam(name: string, value: string | null) {
  const url = new URL(window.location.href);
  if (value === null) url.searchParams.delete(name);
  else url.searchParams.set(name, value);
  window.history.replaceState(null, '', url);
}

function stored(key: string) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key: string, value: string | null) {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Storage can be blocked; the theme then lasts only this visit.
  }
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Follows the OS until the viewer picks; ?theme= wins for one visit. */
function useDark() {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const [choice, setChoice] = useState<string | null>(
    () => param('theme') ?? stored('tally:theme'),
  );
  const [os, setOs] = useState(media.matches);
  useEffect(() => {
    const on = (e: MediaQueryListEvent) => setOs(e.matches);
    media.addEventListener('change', on);
    return () => media.removeEventListener('change', on);
  }, [media]);
  const dark = choice ? choice === 'dark' : os;
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
  }, [dark]);
  const toggle = () => {
    const next = dark ? 'light' : 'dark';
    setChoice(next);
    store('tally:theme', next);
    setParam('theme', null);
  };
  return [dark, toggle] as const;
}

type Boot =
  | { phase: 'loading' }
  | { phase: 'failed'; error: string }
  | { phase: 'ready'; api: Api; me: Me; ledger: Ledger };

export function App() {
  const [boot, setBoot] = useState<Boot>({ phase: 'loading' });
  const [dark, toggleDark] = useDark();

  useEffect(() => {
    let live = true;
    connect()
      .then(async ({ api, me }) => {
        const ledger = await api.ledger();
        if (live) setBoot({ phase: 'ready', api, me, ledger });
      })
      .catch((e) => live && setBoot({ phase: 'failed', error: message(e) }));
    return () => {
      live = false;
    };
  }, []);

  if (boot.phase === 'ready')
    return (
      <Shell
        api={boot.api}
        me={boot.me}
        ledger={boot.ledger}
        dark={dark}
        toggleDark={toggleDark}
      />
    );
  return (
    <div
      className={cx(
        'flex h-screen items-center justify-center px-4 text-[13px]',
        tw.surface,
        tw.ink2,
      )}
    >
      <style>{CSS}</style>
      {boot.phase === 'loading' ? (
        <span className={cx(serif, 'text-[18px] italic', tw.ink3)}>
          Opening the ledger…
        </span>
      ) : (
        <div className="max-w-[440px]">
          <div className={cx(serif, 'text-[24px]', tw.ink)}>
            The ledger did not open.
          </div>
          <p className="mt-2 font-mono text-[12px]">{boot.error}</p>
          <p className="mt-4">
            <a className={cx('hover:underline', tw.accent)} href="?synthetic=1">
              Open the synthetic ledger instead
            </a>
          </p>
        </div>
      )}
    </div>
  );
}

function scope(ledger: Ledger, query: string): Ledger {
  const q = query.trim().toLowerCase();
  if (!q) return ledger;
  return {
    ...ledger,
    transactions: ledger.transactions.filter(
      (t) =>
        t.descriptor.toLowerCase().includes(q) ||
        t.merchant.toLowerCase().includes(q),
    ),
  };
}

/** The calls that change the ledger: optimistic first, then the server's answer. */
function useOps(api: Api, state: State, dispatch: Dispatch<Action>) {
  const fail = (e: unknown) => dispatch({ type: 'error', error: message(e) });
  const recategorise = (t: Transaction, categoryId: string) => {
    dispatch({ type: 'recategorise', ids: [t.id], categoryId });
    api
      .setCategory(t.id, categoryId)
      .then((fresh) =>
        dispatch({ type: 'settle', ids: [t.id], transactions: [fresh] }),
      )
      .catch((e) =>
        dispatch({ type: 'revert', ids: [t.id], error: message(e) }),
      );
  };
  const makeRule = (rule: Rule, ids: string[]) => {
    dispatch({ type: 'addRule', rule, ids });
    api
      .createRule({
        match: rule.match,
        categoryId: rule.categoryId,
        merchant: rule.merchant,
        accountId: rule.accountId ?? null,
      })
      .then(async ({ rule: saved, moved }) => {
        dispatch({ type: 'settleRule', tempId: rule.id, rule: saved });
        const fresh =
          moved ??
          (await Promise.all(
            ids.map((id) => api.setCategory(id, rule.categoryId)),
          ));
        dispatch({ type: 'settle', ids, transactions: fresh });
      })
      .catch((e) =>
        dispatch({ type: 'revert', ids, ruleId: rule.id, error: message(e) }),
      );
  };
  const upload = (files: File[]) => {
    dispatch({ type: 'uploading', names: files.map((f) => f.name) });
    api
      .previewImport(files)
      .then((preview) => dispatch({ type: 'preview', preview }))
      .catch(fail);
  };
  const apply = () => {
    if (state.imp.phase !== 'review') return;
    const { preview, review } = state.imp;
    const rows = state.imp.preview.newTransactions.length;
    dispatch({ type: 'applying' });
    api
      .applyPreview(preview.id, decisionsFor(preview, review))
      .then(({ ledger, batch }) =>
        dispatch({
          type: 'applied',
          ledger,
          rows: batch?.rows ?? rows,
          batchId: batch?.id ?? null,
        }),
      )
      .catch(fail);
  };
  const accounts: AccountOps = {
    createAccount: (draft) =>
      api
        .createAccount(draft)
        .then((account) => {
          dispatch({ type: 'addAccount', account });
          return account;
        })
        .catch((e) => {
          fail(e);
          return null;
        }),
    addValuation: (v) =>
      api
        .addValuation(v)
        .then((valuation) => {
          dispatch({ type: 'addValuation', valuation });
          return true;
        })
        .catch((e) => {
          fail(e);
          return false;
        }),
  };
  return { recategorise, makeRule, upload, apply, accounts };
}

function Shell({
  api,
  me,
  ledger,
  dark,
  toggleDark,
}: {
  api: Api;
  me: Me;
  ledger: Ledger;
  dark: boolean;
  toggleDark: () => void;
}) {
  const [screen, setScreen] = useState<Screen>(() => {
    const s = param('screen');
    return NAV.some((n) => n.key === s) ? (s as Screen) : 'dashboard';
  });
  const [account] = useState(() => param('account') ?? undefined);
  const [periodKey, setPeriodKey] = useState<PeriodKey>('ytd');
  const [query, setQuery] = useState('');
  const [preset, setPreset] = useState<{ categoryId?: string; n: number }>({
    n: 0,
  });
  const [state, dispatch] = useReducer(reduce, ledger, initState);
  const ops = useOps(api, state, dispatch);
  const search = useRef<HTMLInputElement>(null);
  const chord = useRef(0);
  const pal = palette(dark);
  const readOnly = me.role === 'viewer';
  const synthetic = api.source === 'synthetic';

  const live = useMemo(
    () => liveLedger(state),
    [state.base, state.overrides, state.pendingRules],
  );
  const asOf = live.asOf || today();
  const scoped = useMemo(() => scope(live, query), [live, query]);
  const allMonths = useMemo(() => months(live), [live.transactions]);
  const period = useMemo(
    () => resolvePeriod(periodKey, asOf, allMonths),
    [periodKey, asOf, allMonths],
  );
  const uncategorised = useMemo(
    () =>
      live.transactions.filter((t) => t.categoryId === UNCATEGORIZED).length,
    [live],
  );
  const openFindings =
    state.imp.phase === 'review'
      ? state.imp.preview.findings.filter(
          (f) =>
            state.imp.phase === 'review' && !state.imp.review.resolutions[f.id],
        ).length
      : 0;

  useEffect(() => {
    const id = param('preview') ?? api.pendingPreviewId;
    if (!id) return;
    api
      .getPreview(id)
      .then((preview) => dispatch({ type: 'preview', preview }))
      .catch(() => setParam('preview', null));
  }, [api]);

  useEffect(() => {
    const open =
      state.imp.phase === 'review' || state.imp.phase === 'applying'
        ? state.imp.preview.id
        : null;
    if (!api.pendingPreviewId || open !== api.pendingPreviewId)
      setParam('preview', open);
  }, [state.imp, api]);

  useEffect(() => {
    setParam('screen', screen === 'dashboard' ? null : screen);
  }, [screen]);

  const go = (s: Screen) => {
    setScreen(s);
    if (s === 'import') setQuery('');
  };

  // Capture phase, so a g-chord wins over a screen's single-key binding.
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
        e.preventDefault();
        return;
      }
      if (Date.now() - chord.current < 900) {
        chord.current = 0;
        const n = NAV.find((x) => x.key2 === e.key);
        if (n) {
          e.preventDefault();
          go(n.key);
          return;
        }
      }
      if (e.key === '[' || e.key === ']') {
        e.preventDefault();
        const i = PERIOD_KEYS.indexOf(periodKey);
        const n = PERIOD_KEYS.length;
        setPeriodKey(PERIOD_KEYS[(i + (e.key === ']' ? 1 : n - 1)) % n]);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  const periodApplies = screen === 'dashboard' || screen === 'transactions';
  const counts: Partial<Record<Screen, number>> = {
    transactions: uncategorised,
    import: openFindings,
    rules: state.freshRules.length,
  };
  const empty = live.transactions.length === 0;

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
          <span
            className={cx(
              serif,
              'flex h-5 w-5 items-center justify-center rounded-[3px] bg-[#0b0b0b] text-[13px] leading-none text-[#fcfcfb] italic dark:bg-[#f0efec] dark:text-[#141413]',
            )}
          >
            t
          </span>
          <span className="hidden font-mono text-[12px] font-semibold tracking-tight md:inline">
            tally<span className={tw.ink3}>/reader</span>
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
                title={n.label}
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
                ['j k', 'move focus'],
                ['h l', 'step within'],
                ['↵', 'pin inspector'],
                ['a x', 'accept, dismiss'],
                ['esc', 'unpin, close'],
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
            <div className={cx('truncate', tw.ink2)} title={me.login}>
              {me.login}
              {readOnly ? ' · viewer' : ''}
            </div>
            <div>
              {live.owner === me.login
                ? `+ ${live.viewers.length} ${live.viewers.length === 1 ? 'viewer' : 'viewers'}`
                : `${live.owner}'s ledger`}
              {live.asOf ? (
                <>
                  {' '}
                  · as of <span className={tw.num}>{live.asOf}</span>
                </>
              ) : null}
            </div>
            <div>{synthetic ? 'Synthetic ledger' : 'Served from the lab'}</div>
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
          <div className="relative flex max-w-[420px] min-w-0 flex-1 items-center">
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
                if (e.key === 'Enter' && screen === 'dashboard' && query.trim())
                  go('transactions');
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
              'hidden transition-opacity sm:block',
              !periodApplies && 'pointer-events-none opacity-35',
            )}
            title={
              periodApplies
                ? 'Period, [ and ] to step'
                : 'The period applies to the Reader and Transactions'
            }
          >
            <Segmented
              options={periodOptions(asOf)}
              value={periodKey}
              onChange={setPeriodKey}
            />
          </div>
          <div
            className={cx(
              'ml-auto hidden items-center gap-3 text-[11px] xl:flex',
              tw.ink3,
            )}
          >
            <span className={tw.num}>
              {live.transactions.length.toLocaleString('en-CA')} rows ·{' '}
              {live.accounts.length} accounts
            </span>
            <span className="flex items-center gap-1.5">
              <span
                className={cx(
                  'h-1.5 w-1.5 rounded-full',
                  synthetic ? 'bg-[#b77c00]' : 'bg-[#0ca30c]',
                )}
              />
              {synthetic ? 'synthetic' : 'in the lab'}
            </span>
          </div>
          <button
            type="button"
            onClick={toggleDark}
            aria-label={dark ? 'Use the light theme' : 'Use the dark theme'}
            title={dark ? 'Light theme' : 'Dark theme'}
            className={cx(
              'ml-auto rounded-[3px] p-1.5 xl:ml-0',
              tw.ink3,
              tw.hover,
            )}
          >
            {dark ? <Sun size={14} /> : <Moon size={14} />}
          </button>
        </header>

        <main className="flex min-h-0 flex-1 flex-col">
          {empty && (screen === 'dashboard' || screen === 'transactions') ? (
            <EmptyLedger goImport={() => go('import')} readOnly={readOnly} />
          ) : null}
          {!empty && screen === 'dashboard' ? (
            <Reader
              ledger={scoped}
              full={live}
              pal={pal}
              dark={dark}
              period={period}
              query={query}
              openFindings={openFindings}
              goImport={() => go('import')}
              synthetic={synthetic}
              openTransactions={(q) => {
                setQuery(q.text ?? '');
                setPreset((p) => ({ categoryId: q.categoryId, n: p.n + 1 }));
                go('transactions');
              }}
            />
          ) : null}
          {!empty && screen === 'transactions' ? (
            <Transactions
              ledger={live}
              pal={pal}
              period={period}
              query={query}
              preset={preset}
              ops={ops}
              readOnly={readOnly}
              showRules={() => go('rules')}
            />
          ) : null}
          {screen === 'import' ? (
            <Import
              ledger={live}
              pal={pal}
              imp={state.imp}
              dispatch={dispatch}
              upload={ops.upload}
              apply={ops.apply}
              readOnly={readOnly}
              synthetic={synthetic}
            />
          ) : null}
          {screen === 'accounts' ? (
            <Accounts
              ledger={live}
              pal={pal}
              query={query}
              initial={account}
              ops={ops.accounts}
              readOnly={readOnly}
            />
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
      {state.error ? (
        <div
          role="alert"
          className={cx(
            'fixed right-4 bottom-4 z-50 flex max-w-[420px] items-start gap-3 rounded-[4px] border px-3 py-2 text-[12px] shadow-[0_6px_20px_rgba(0,0,0,0.12)]',
            tw.surface,
            tw.rule,
          )}
        >
          <span className={cx('flex-1', tw.bad)}>
            The server said no: {state.error}. The change was undone.
          </span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => dispatch({ type: 'error', error: null })}
            className={cx('rounded-[2px] p-0.5', tw.ink3, tw.hover)}
          >
            <X size={12} />
          </button>
        </div>
      ) : null}
    </div>
  );
}

function EmptyLedger({
  goImport,
  readOnly,
}: {
  goImport: () => void;
  readOnly: boolean;
}) {
  return (
    <div className="mx-auto max-w-[560px] px-5 pt-24 sm:px-10">
      <div className={cx(tw.label, tw.ink3)}>An empty ledger</div>
      <h1 className={cx(serif, 'mt-2 text-[34px] leading-tight', tw.ink)}>
        Nothing to read yet
      </h1>
      <p className={cx('mt-3 text-[15px] leading-relaxed', tw.ink2)}>
        {readOnly
          ? 'The owner has not imported anything into this ledger.'
          : 'Bring in a bank export or a statement and the reader writes itself from what it finds.'}
      </p>
      {readOnly ? null : (
        <button
          type="button"
          onClick={goImport}
          className={cx(tw.btnPrimary, 'mt-6 h-7')}
        >
          Import files <Kbd>g i</Kbd>
        </button>
      )}
    </div>
  );
}
