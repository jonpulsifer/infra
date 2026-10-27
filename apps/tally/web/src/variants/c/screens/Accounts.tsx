import {
  CreditCard,
  FileText,
  House,
  Landmark,
  type LucideIcon,
  PiggyBank,
  TrendingDown,
  TrendingUp,
  Wallet,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  accountBalance,
  balancesByMonth,
  latestHoldings,
} from '~/fixtures/derive';
import type { Account, AccountKind, Ledger } from '~/fixtures/types';
import { Answer, Aside, AsideSection, Card, NumbersList } from '../bits';
import { Sparkline } from '../charts/Small';
import { Trend, type TrendPoint } from '../charts/Trend';
import {
  dayLabel,
  money,
  moneyCents,
  moneySigned,
  monthLong,
  monthShort,
  pct,
} from '../model';
import { useTally } from '../store';

const KIND_ICON: Record<AccountKind, LucideIcon> = {
  chequing: Wallet,
  savings: PiggyBank,
  credit: CreditCard,
  mortgage: Landmark,
  investment: TrendingUp,
  asset: House,
};

const ORDER: AccountKind[] = [
  'chequing',
  'savings',
  'credit',
  'investment',
  'asset',
  'mortgage',
];

function series(
  ledger: Ledger,
  a: Account,
  bal: Map<string, Map<string, number>>,
): TrendPoint[] {
  if (a.kind === 'investment')
    return ledger.holdings
      .filter((h) => h.accountId === a.id)
      .map((h) => ({ key: h.date, value: Math.round(h.total) }));
  if (a.kind === 'asset')
    return ledger.valuations
      .filter((v) => v.accountId === a.id)
      .map((v) => ({ key: v.date, value: v.value }));
  if (a.kind === 'mortgage')
    return ledger.assertions
      .filter((x) => x.accountId === a.id)
      .map((x) => ({ key: x.date, value: Math.round(x.balance) }));
  const s = bal.get(a.id);
  const first = a.since.slice(0, 7);
  return Array.from(s?.entries() ?? [])
    .filter(([m]) => m >= first)
    .map(([m, v]) => ({ key: m, value: Math.round(v) }));
}

function lastActivity(ledger: Ledger, id: string) {
  for (let i = ledger.transactions.length - 1; i >= 0; i--)
    if (ledger.transactions[i].accountId === id)
      return ledger.transactions[i].date;
  return null;
}

export function Accounts() {
  const { eff, nav, nw, pal } = useTally();
  const bal = useMemo(() => balancesByMonth(eff), [eff]);
  const accounts = useMemo(
    () =>
      [...eff.accounts].sort(
        (a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind),
      ),
    [eff],
  );
  const [sel, setSel] = useState(nav.account);
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const c = strip.current;
    const el = c?.querySelector<HTMLElement>(`[data-a="${sel}"]`);
    if (c && el) c.scrollTo({ left: el.offsetLeft - 16, behavior: 'smooth' });
  }, [sel]);
  const acct = accounts.find((a) => a.id === sel) ?? accounts[0];
  const latest = nw[nw.length - 1];

  return (
    <div className="qc-in">
      <Answer
        question="What do I have?"
        line={`${accounts.length} accounts add up to ${money(latest.total)}`}
        sub="Swipe through them. Tap one to see its history."
      />
      <div
        ref={strip}
        className="qc-noscroll relative flex snap-x snap-mandatory scroll-px-4 gap-3 overflow-x-auto px-4 pt-1 pb-3"
      >
        {accounts.map((a) => {
          const on = a.id === acct.id;
          const Icon = KIND_ICON[a.kind];
          const s = series(eff, a, bal)
            .slice(-18)
            .map((p) => p.value);
          const last = lastActivity(eff, a.id);
          const closed =
            (a.kind === 'chequing' || a.kind === 'credit') &&
            last !== null &&
            last < '2026-01-01';
          return (
            <button
              key={a.id}
              type="button"
              data-a={a.id}
              aria-pressed={on}
              onClick={() => setSel(a.id)}
              className={`flex w-[13.5rem] shrink-0 snap-start flex-col rounded-2xl p-4 text-left transition active:scale-[0.98] ${
                on
                  ? 'bg-white shadow-md ring-2 ring-amber-500 dark:bg-stone-900 dark:ring-amber-400'
                  : 'bg-stone-50 ring-1 ring-stone-200 hover:ring-stone-300 dark:bg-stone-900/60 dark:ring-stone-800 dark:hover:ring-stone-700'
              }`}
            >
              <span className="flex items-center gap-2">
                <span className="grid size-8 place-items-center rounded-lg bg-amber-50 text-amber-700 dark:bg-amber-400/10 dark:text-amber-300">
                  <Icon className="size-4" aria-hidden />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold">
                    {a.name}
                  </span>
                  <span className="block text-xs text-stone-500">
                    {a.institution}
                    {closed ? ' · closed' : ''}
                  </span>
                </span>
              </span>
              <span className="mt-4 text-xl font-semibold tracking-tight">
                {money(accountBalance(eff, a.id))}
              </span>
              <span className="mt-2">
                <Sparkline
                  values={s}
                  color={pal.accent}
                  pal={pal}
                  width={176}
                  height={36}
                />
              </span>
            </button>
          );
        })}
      </div>

      <div key={acct.id} className="qc-in mt-4 px-4">
        {acct.kind === 'asset' ? (
          <HouseDetail account={acct} />
        ) : (
          <BalanceDetail account={acct} points={series(eff, acct, bal)} />
        )}
      </div>

      <Aside>
        <AsideSection title="Every account">
          <NumbersList
            rows={[
              ...accounts.map((a) => ({
                label: a.name,
                hint: a.institution,
                value: money(accountBalance(eff, a.id)),
              })),
              { label: 'Net worth', value: money(latest.total), strong: true },
            ]}
          />
        </AsideSection>
      </Aside>
    </div>
  );
}

function BalanceDetail({
  account,
  points,
}: {
  account: Account;
  points: TrendPoint[];
}) {
  const { eff, pal } = useTally();
  const [idx, setIdx] = useState(points.length - 1);
  const i = Math.min(idx, points.length - 1);
  const p = points[i];
  const yearAgo = points.find(
    (x) => x.key >= shiftYear(points[points.length - 1]?.key ?? ''),
  );
  const now = points[points.length - 1];
  const monthly = account.kind !== 'investment' && account.kind !== 'mortgage';
  const label = (k: string) =>
    k.length === 7 ? `${monthShort(k)} ${k.slice(0, 4)}` : dayLabel(k, true);
  const holdings =
    account.kind === 'investment' ? latestHoldings(eff, account.id) : null;
  const recent = eff.transactions
    .filter((t) => t.accountId === account.id)
    .slice(-5)
    .reverse();

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="font-semibold">
            {account.kind === 'mortgage'
              ? 'What you still owe'
              : account.kind === 'investment'
                ? 'Value at each statement'
                : 'Balance at each month end'}
          </h2>
          {now && yearAgo && yearAgo !== now ? (
            <span className="text-xs text-stone-500 tabular-nums">
              {moneySigned(now.value - yearAgo.value)} in a year
            </span>
          ) : null}
        </div>
        {points.length > 1 ? (
          <div className="mt-2">
            <Trend
              data={points}
              index={i}
              onIndex={setIdx}
              height={220}
              color={pal.accent}
              pal={pal}
              label={`${account.name} balance history`}
              pointLabel={(x) => label(x.key)}
              xLabel={(x, n) => {
                const y = x.key.slice(0, 4);
                const prev = points[n - 1]?.key.slice(0, 4);
                return y !== prev ? y : null;
              }}
            />
          </div>
        ) : (
          <p className="mt-3 text-sm text-stone-500">Not enough history yet.</p>
        )}
        {p && !monthly ? (
          <p className="mt-2 text-xs text-stone-500">
            {account.kind === 'mortgage'
              ? 'From the lender’s month-end statements.'
              : 'Snapshots come from statements, so the line moves once a quarter.'}
          </p>
        ) : null}
      </Card>

      {holdings ? (
        <section>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-xs font-semibold tracking-wide text-stone-500 uppercase">
              Holdings on {dayLabel(holdings.date, true)}
            </h2>
            <span className="inline-flex items-center gap-1 text-xs text-stone-500">
              <FileText className="size-3.5" aria-hidden />
              {holdings.origin === 'statement-pdf' ? 'Statement PDF' : 'Export'}
            </span>
          </div>
          <ul className="space-y-2">
            {holdings.positions.map((pos) => {
              const gain = pos.marketValue - pos.bookCost;
              const up = gain >= 0;
              return (
                <li
                  key={pos.symbol}
                  className="rounded-2xl bg-white p-4 ring-1 ring-stone-200/80 dark:bg-stone-900 dark:ring-stone-800"
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="font-mono text-sm font-semibold">
                      {pos.symbol}
                    </span>
                    <span className="text-lg font-semibold tracking-tight">
                      {money(pos.marketValue)}
                    </span>
                  </div>
                  <div className="mt-0.5 flex items-baseline justify-between gap-3 text-xs text-stone-500">
                    <span className="truncate">{pos.name}</span>
                    {pos.symbol === 'CASH' ? null : (
                      <span
                        className={`inline-flex items-center gap-1 font-medium ${up ? 'text-[#006300] dark:text-[#3bc43b]' : 'text-[#b42323] dark:text-[#f08080]'}`}
                      >
                        {up ? (
                          <TrendingUp className="size-3.5" aria-hidden />
                        ) : (
                          <TrendingDown className="size-3.5" aria-hidden />
                        )}
                        {moneySigned(gain)} ({pct(gain / pos.bookCost)})
                      </span>
                    )}
                  </div>
                  {pos.symbol === 'CASH' ? null : (
                    <div className="mt-2 text-xs text-stone-500 tabular-nums">
                      {pos.quantity.toLocaleString('en-CA')} units at{' '}
                      {moneyCents(pos.price)} · cost {money(pos.bookCost)}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {monthly && recent.length ? (
        <section>
          <h2 className="mb-2 text-xs font-semibold tracking-wide text-stone-500 uppercase">
            Latest rows
          </h2>
          <ul className="divide-y divide-stone-200 rounded-2xl bg-white ring-1 ring-stone-200/80 dark:divide-stone-800 dark:bg-stone-900 dark:ring-stone-800">
            {recent.map((t) => (
              <li
                key={t.id}
                className="flex items-center gap-3 px-4 py-3 text-sm"
              >
                <span className="min-w-0 flex-1 truncate">{t.merchant}</span>
                <span className="text-xs text-stone-500">
                  {dayLabel(t.date)}
                </span>
                <span className="w-24 text-right font-medium tabular-nums">
                  {moneyCents(t.amount)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function shiftYear(key: string) {
  if (!key) return '';
  return `${Number(key.slice(0, 4)) - 1}${key.slice(4)}`;
}

const SOURCE_TEXT = {
  purchase: 'Purchase price',
  assessment: 'Property assessment',
  estimate: 'Your estimate',
};

function HouseDetail({ account }: { account: Account }) {
  const { eff } = useTally();
  const vals = eff.valuations.filter((v) => v.accountId === account.id);
  const first = vals[0];
  const last = vals[vals.length - 1];
  const owed = accountBalance(eff, 'mortgage');
  const items = [...vals].reverse();
  return (
    <div className="space-y-4">
      <Card className="grid grid-cols-2 divide-x divide-stone-200 dark:divide-stone-800">
        <div className="p-4">
          <div className="text-xs text-stone-500">Up since you bought it</div>
          <div className="mt-1 text-xl font-semibold tracking-tight">
            {moneySigned(last.value - first.value)}
          </div>
          <div className="text-xs text-stone-500">
            {pct((last.value - first.value) / first.value)} since{' '}
            {monthLong(first.date.slice(0, 7), true)}
          </div>
        </div>
        <div className="p-4">
          <div className="text-xs text-stone-500">Yours after the mortgage</div>
          <div className="mt-1 text-xl font-semibold tracking-tight">
            {money(last.value + owed)}
          </div>
          <div className="text-xs text-stone-500">
            {money(-owed)} still owed
          </div>
        </div>
      </Card>
      <section>
        <h2 className="mb-3 text-xs font-semibold tracking-wide text-stone-500 uppercase">
          Valuations
        </h2>
        <ol className="relative ml-2">
          <span
            aria-hidden
            className="absolute top-2 bottom-2 left-[7px] w-0.5 rounded-full bg-stone-200 dark:bg-stone-800"
          />
          {items.map((v, i) => {
            const prev = items[i + 1];
            const d = prev ? v.value - prev.value : null;
            const est = v.source === 'estimate';
            return (
              <li key={v.date} className="relative pb-5 pl-9 last:pb-0">
                <span
                  aria-hidden
                  className={`absolute top-1.5 left-0 size-4 rounded-full ring-4 ring-stone-100 dark:ring-stone-950 ${
                    est
                      ? 'border-2 border-amber-500 bg-stone-100 dark:bg-stone-950'
                      : i === 0 || v.source === 'purchase'
                        ? 'bg-amber-500'
                        : 'bg-stone-400 dark:bg-stone-500'
                  }`}
                />
                <div className="rounded-2xl bg-white p-4 ring-1 ring-stone-200/80 dark:bg-stone-900 dark:ring-stone-800">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-xl font-semibold tracking-tight">
                      {money(v.value)}
                    </span>
                    {d !== null ? (
                      <span
                        className={`text-sm font-medium tabular-nums ${d >= 0 ? 'text-[#006300] dark:text-[#3bc43b]' : 'text-[#b42323] dark:text-[#f08080]'}`}
                      >
                        {d >= 0 ? '▲' : '▼'} {moneySigned(d)}
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-xs text-stone-500">
                    <span>{dayLabel(v.date, true)}</span>
                    <span>·</span>
                    <span
                      className={
                        est
                          ? 'font-medium text-amber-700 dark:text-amber-300'
                          : ''
                      }
                    >
                      {SOURCE_TEXT[v.source]}
                    </span>
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      </section>
    </div>
  );
}
