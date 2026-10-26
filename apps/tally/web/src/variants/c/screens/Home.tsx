import {
  ChevronRight,
  Inbox,
  type LucideIcon,
  PiggyBank,
  ShieldAlert,
  Store,
  TrendingUp,
  Waypoints,
} from 'lucide-react';
import { topMerchants } from '~/fixtures/derive';
import { Aside, AsideSection, CategoryChip, NumbersList } from '../bits';
import { useIssues } from '../findings';
import {
  categoryName,
  currentMonth,
  dayLabel,
  money,
  moneyCents,
  moneySigned,
  monthEnd,
  monthLong,
  type Question,
  spendAnswer,
} from '../model';
import { useTally } from '../store';

type Chip = {
  key: Question | 'import';
  q: string;
  a: string;
  icon: LucideIcon;
  badge?: number;
  tone?: 'alert';
};

export function Home() {
  const t = useTally();
  const { eff, nw, spendMonths, flows, go, base, imported, setMonth, pal } = t;
  const issues = useIssues();
  const cm = currentMonth(eff);
  const last = nw[nw.length - 1];
  const yearAgo = nw[nw.length - 13];
  const spend = spendAnswer(eff, cm, spendMonths);
  const top = topMerchants(eff, {
    from: `${cm}-01`,
    to: monthEnd(cm),
    limit: 1,
  })[0];
  const year = flows.slice(-12);
  const yIn = year.reduce((s, r) => s + r.income, 0);
  const yNet = year.reduce((s, r) => s + r.net, 0);
  const chips: Chip[] = [
    {
      key: 'worth',
      q: 'What am I worth?',
      a: `${money(last.total)} · ${moneySigned(last.total - (yearAgo?.total ?? 0))} in a year`,
      icon: TrendingUp,
    },
    {
      key: 'spend',
      q: `Where did ${monthLong(cm)} go?`,
      a: `${money(spend.spent)} so far · usually ${money(spend.usual)}`,
      icon: Waypoints,
    },
    {
      key: 'payees',
      q: 'Who do I pay most?',
      a: top
        ? `${top.merchant}, ${money(top.total)} this month`
        : 'Nobody yet this month',
      icon: Store,
    },
    {
      key: 'saving',
      q: 'Am I saving?',
      a:
        yNet > 0
          ? `Yes, ${Math.round((yNet / yIn) * 100)}% of income over the year`
          : `Not lately: ${money(-yNet)} short over the year`,
      icon: PiggyBank,
    },
    {
      key: 'import',
      q: "What's new to import?",
      a: imported
        ? 'All caught up'
        : `${base.preview.files.length} statements · ${base.preview.newTransactions.length} rows waiting`,
      icon: Inbox,
      badge: imported ? undefined : base.preview.files.length,
    },
    {
      key: 'wrong',
      q: 'Is anything wrong?',
      a: issues.count
        ? `${issues.count} thing${issues.count === 1 ? '' : 's'} need a look`
        : 'Nothing looks wrong',
      icon: ShieldAlert,
      badge: issues.count || undefined,
      tone: issues.count ? 'alert' : undefined,
    },
  ];

  const open = (c: Chip) => {
    if (c.key === 'import') go({ tab: 'import', question: null });
    else {
      if (c.key !== 'worth') setMonth(cm);
      go({ tab: 'home', question: c.key });
    }
  };

  const recent = eff.transactions.slice(-6).reverse();

  return (
    <div className="px-4 pt-6">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold tracking-tight text-stone-900 dark:text-stone-100">
          tally
        </span>
        <span className="rounded-full bg-stone-200/70 px-2.5 py-1 text-xs text-stone-600 dark:bg-stone-800 dark:text-stone-400">
          Through {dayLabel(eff.asOf, true)}
        </span>
      </div>
      <h1 className="mt-8 text-[2rem] leading-[1.1] font-semibold tracking-tight text-stone-900 dark:text-stone-50">
        What do you want to know?
      </h1>
      <p className="mt-2 text-[0.95rem] text-stone-600 dark:text-stone-400">
        Tap a question. Every answer comes from your own ledger.
      </p>
      <ul className="mt-6 space-y-2.5">
        {chips.map((c, i) => (
          <li
            key={c.key}
            className="qc-in"
            style={{ animationDelay: `${i * 40}ms` }}
          >
            <button
              type="button"
              onClick={() => open(c)}
              className="group flex min-h-[4.75rem] w-full items-center gap-3.5 rounded-2xl bg-white px-4 py-3 text-left shadow-[0_1px_0_rgb(0_0_0/0.03)] ring-1 ring-stone-200/80 transition hover:-translate-y-px hover:shadow-md hover:ring-amber-300 active:scale-[0.99] dark:bg-stone-900 dark:ring-stone-800 dark:hover:ring-amber-500/50"
            >
              <span
                className={`grid size-11 shrink-0 place-items-center rounded-xl ${
                  c.tone === 'alert'
                    ? 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300'
                    : 'bg-amber-50 text-amber-700 dark:bg-amber-400/10 dark:text-amber-300'
                }`}
              >
                <c.icon className="size-5" aria-hidden />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[1.05rem] font-semibold tracking-tight text-stone-900 dark:text-stone-50">
                  {c.q}
                </span>
                <span className="mt-0.5 block truncate text-sm text-stone-500 dark:text-stone-400">
                  {c.a}
                </span>
              </span>
              {c.badge ? (
                <span
                  className={`grid h-6 min-w-6 place-items-center rounded-full px-1.5 text-xs font-semibold ${
                    c.tone === 'alert'
                      ? 'bg-red-600 text-white'
                      : 'bg-amber-500 text-stone-950'
                  }`}
                >
                  {c.badge}
                </span>
              ) : null}
              <ChevronRight
                className="size-5 shrink-0 text-stone-400 transition group-hover:translate-x-0.5"
                aria-hidden
              />
            </button>
          </li>
        ))}
      </ul>

      <Aside>
        <div className="space-y-4">
          <AsideSection title="At a glance">
            <NumbersList
              rows={[
                { label: 'Net worth', value: money(last.total), strong: true },
                {
                  label: `Spent in ${monthLong(cm)}`,
                  value: money(spend.spent),
                },
                { label: 'Usual month', value: money(spend.usual) },
                { label: 'Kept over 12 months', value: money(yNet) },
                {
                  label: 'Needs a look',
                  value: String(issues.count),
                },
              ]}
            />
          </AsideSection>
          <AsideSection title="Latest rows">
            <ul className="divide-y divide-stone-200/80 dark:divide-stone-800">
              {recent.map((r) => (
                <li key={r.id} className="flex items-center gap-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">
                      {r.merchant}
                    </div>
                    <div className="mt-1">
                      <CategoryChip
                        ledger={eff}
                        categoryId={r.categoryId}
                        name={categoryName(eff, r.categoryId)}
                        pal={pal}
                      />
                    </div>
                  </div>
                  <span className="text-sm tabular-nums">
                    {moneyCents(r.amount)}
                  </span>
                </li>
              ))}
            </ul>
          </AsideSection>
        </div>
      </Aside>
    </div>
  );
}
