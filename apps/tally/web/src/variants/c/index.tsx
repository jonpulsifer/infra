import {
  CircleCheck,
  House,
  Inbox,
  type LucideIcon,
  ReceiptText,
  Wallet,
} from 'lucide-react';
import { useState } from 'react';
import type { Variant, VariantProps } from '~/prototype/variants';
import {
  AsideCtx,
  CHROME_PAD,
  ColumnFrame,
  CSS,
  SCRUB_H,
  Scrubber,
  TAB_H,
} from './bits';
import type { Question, Tab } from './model';
import { Accounts } from './screens/Accounts';
import { Home } from './screens/Home';
import { ImportFlow, ImportScreen } from './screens/Import';
import { LedgerScreen } from './screens/Ledger';
import { Payees } from './screens/Payees';
import { Saving } from './screens/Saving';
import { Spend } from './screens/Spend';
import { Worth } from './screens/Worth';
import { Wrong } from './screens/Wrong';
import { type Nav, TallyProvider, useTally } from './store';

const QUESTIONS: Question[] = ['worth', 'spend', 'payees', 'saving', 'wrong'];

function readInitial(): Nav {
  const nav: Nav = {
    tab: 'home',
    question: null,
    importStep: null,
    ledgerCategory: null,
    ledgerText: '',
    account: 'rbc-chq',
  };
  const s = new URLSearchParams(window.location.search).get('screen') ?? '';
  if (s === 'transactions' || s === 'ledger') nav.tab = 'ledger';
  else if (s === 'accounts') nav.tab = 'accounts';
  else if (s === 'house')
    Object.assign(nav, { tab: 'accounts', account: 'house' });
  else if (s === 'import') nav.tab = 'import';
  else if (s.startsWith('import-')) {
    const step = s.slice(7);
    if (
      step === 'pick' ||
      step === 'parse' ||
      step === 'review' ||
      step === 'summary'
    )
      Object.assign(nav, { tab: 'import', importStep: step });
  } else if ((QUESTIONS as string[]).includes(s)) nav.question = s as Question;
  return nav;
}

const TABS: { key: Tab; label: string; icon: LucideIcon }[] = [
  { key: 'home', label: 'Home', icon: House },
  { key: 'ledger', label: 'Ledger', icon: ReceiptText },
  { key: 'import', label: 'Import', icon: Inbox },
  { key: 'accounts', label: 'Accounts', icon: Wallet },
];

function TabBar() {
  const { nav, go, imported, base } = useTally();
  return (
    <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-40">
      <ColumnFrame>
        <div
          className="border-t border-stone-200/80 bg-stone-50/95 backdrop-blur-md dark:border-stone-800 dark:bg-stone-900/95"
          style={{ paddingBottom: CHROME_PAD }}
        >
          <ul className="flex" style={{ height: TAB_H }}>
            {TABS.map((t) => {
              const on = nav.tab === t.key;
              const badge =
                t.key === 'import' && !imported ? base.preview.files.length : 0;
              return (
                <li key={t.key} className="flex-1">
                  <button
                    type="button"
                    aria-current={on ? 'page' : undefined}
                    onClick={() => go({ tab: t.key, question: null })}
                    className={`relative flex h-full w-full flex-col items-center justify-center gap-1 text-[11px] font-medium transition ${
                      on
                        ? 'text-amber-700 dark:text-amber-300'
                        : 'text-stone-500 hover:text-stone-800 dark:text-stone-400 dark:hover:text-stone-200'
                    }`}
                  >
                    <span
                      className={`grid h-8 w-14 place-items-center rounded-full transition ${on ? 'bg-amber-100 dark:bg-amber-400/15' : ''}`}
                    >
                      <t.icon className="size-5" aria-hidden />
                    </span>
                    {t.label}
                    {badge ? (
                      <span className="absolute top-1.5 left-1/2 ml-3 grid h-4.5 min-w-4.5 place-items-center rounded-full bg-amber-500 px-1 text-[10px] font-bold text-stone-950">
                        {badge}
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </ColumnFrame>
    </nav>
  );
}

function Toast({ bottom }: { bottom: number }) {
  const { toast } = useTally();
  if (!toast) return null;
  return (
    <div
      className="pointer-events-none fixed inset-x-0 z-[45] px-4"
      style={{ bottom }}
    >
      <ColumnFrame>
        <div
          key={toast.id}
          role="status"
          className="qc-in mx-auto flex w-fit max-w-full items-center gap-2 rounded-2xl bg-stone-900 px-4 py-3 text-sm text-stone-50 shadow-xl dark:bg-stone-100 dark:text-stone-900"
        >
          <CircleCheck
            className="size-4 shrink-0 text-amber-400 dark:text-amber-600"
            aria-hidden
          />
          {toast.text}
        </div>
      </ColumnFrame>
    </div>
  );
}

function Screen() {
  const { nav } = useTally();
  if (nav.tab === 'ledger') return <LedgerScreen />;
  if (nav.tab === 'import') return <ImportScreen />;
  if (nav.tab === 'accounts') return <Accounts />;
  switch (nav.question) {
    case 'worth':
      return <Worth />;
    case 'spend':
      return <Spend />;
    case 'payees':
      return <Payees />;
    case 'saving':
      return <Saving />;
    case 'wrong':
      return <Wrong />;
    default:
      return <Home />;
  }
}

function Shell() {
  const { nav, months, month, setMonth } = useTally();
  const [aside, setAside] = useState<HTMLElement | null>(null);
  const scrub =
    nav.tab === 'home' && !!nav.question && nav.question !== 'wrong';
  const chrome = TAB_H + CHROME_PAD + (scrub ? SCRUB_H : 0);
  return (
    <AsideCtx.Provider value={aside}>
      <div className="min-h-screen bg-stone-100 text-stone-900 antialiased dark:bg-stone-950 dark:text-stone-100">
        <style>{CSS}</style>
        <div className="mx-auto flex max-w-5xl justify-center gap-8 lg:px-8">
          <main
            key={`${nav.tab}-${nav.question}`}
            className="w-full min-w-0 max-w-md"
            style={{ paddingBottom: chrome + 24 }}
          >
            <Screen />
          </main>
          <aside className="hidden w-80 shrink-0 lg:block" aria-label="Context">
            <div
              ref={setAside}
              className="sticky top-0 max-h-screen overflow-y-auto pt-20"
              style={{ paddingBottom: chrome + 24 }}
            />
          </aside>
        </div>
        {scrub ? (
          <Scrubber
            months={months}
            value={month}
            onChange={setMonth}
            bottom={TAB_H + CHROME_PAD}
          />
        ) : null}
        <Toast bottom={chrome + 12} />
        <TabBar />
        <ImportFlow />
      </div>
    </AsideCtx.Provider>
  );
}

function Questions({ ledger, dark }: VariantProps) {
  const [initial] = useState(readInitial);
  return (
    <TallyProvider ledger={ledger} dark={dark} initial={initial}>
      <Shell />
    </TallyProvider>
  );
}

const variant: Variant = { name: 'Questions', Component: Questions };

export default variant;
