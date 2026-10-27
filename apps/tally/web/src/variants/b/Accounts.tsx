import { AlertCircle, CheckCircle2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  accountBalance,
  balancesByMonth,
  cadCents,
  latestHoldings,
} from '~/fixtures/derive';
import type { Account, AccountKind, Ledger } from '~/fixtures/types';
import { Kicker } from './bits';
import {
  LineChart,
  SOURCE_LABEL,
  Sparkline,
  ValuationChart,
  ValuationMarker,
} from './charts';
import {
  accountSeries,
  lastActivity,
  longDate,
  money,
  monthYear,
  type SeriesPoint,
  signed,
} from './model';

const KIND_ORDER: AccountKind[] = [
  'chequing',
  'savings',
  'credit',
  'investment',
  'asset',
  'mortgage',
];

const KIND_LABEL: Record<AccountKind, string> = {
  chequing: 'Chequing',
  savings: 'Savings',
  credit: 'Credit card',
  investment: 'Investments',
  asset: 'Property',
  mortgage: 'Mortgage',
};

export function Accounts({ ledger }: { ledger: Ledger }) {
  const [selected, setSelected] = useState('house');
  const balances = useMemo(() => balancesByMonth(ledger), [ledger]);
  const accounts = useMemo(
    () =>
      [...ledger.accounts].sort(
        (a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind),
      ),
    [ledger],
  );
  const bal = (id: string) => accountBalance(ledger, id);
  const assets = accounts.reduce((s, a) => s + Math.max(0, bal(a.id)), 0);
  const debts = accounts.reduce((s, a) => s + Math.min(0, bal(a.id)), 0);
  const current = accounts.find((a) => a.id === selected) ?? accounts[0];

  return (
    <div className="vb-in mx-auto max-w-[1180px] px-5 pt-14 pb-32 sm:px-10 sm:pt-20">
      <Kicker>Everything you hold and owe</Kicker>
      <h1 className="serif mt-3 text-[44px] leading-[1.05] text-(--ink) sm:text-[56px]">
        Accounts
      </h1>
      <p className="mt-4 max-w-2xl text-[17px] leading-relaxed text-(--ink2)">
        {accounts.length} accounts.{' '}
        <span className="font-semibold text-(--ink)">{money(assets)}</span> held
        against{' '}
        <span className="font-semibold text-(--ink)">{money(-debts)}</span>{' '}
        owed, for{' '}
        <span className="font-semibold text-(--ink)">
          {money(assets + debts)}
        </span>
        .
      </p>

      <Feature
        key={current.id}
        account={current}
        ledger={ledger}
        series={accountSeries(ledger, current.id, balances)}
      />

      <div className="mt-20 grid gap-5 md:grid-cols-2">
        {accounts.map((a) => (
          <AccountCard
            key={a.id}
            account={a}
            ledger={ledger}
            series={accountSeries(ledger, a.id, balances)}
            active={a.id === current.id}
            onSelect={() => {
              setSelected(a.id);
              window.scrollTo({ top: 0, behavior: 'smooth' });
            }}
          />
        ))}
      </div>
    </div>
  );
}

function footLine(ledger: Ledger, a: Account) {
  if (a.kind === 'investment') {
    const h = latestHoldings(ledger, a.id);
    return h
      ? `Statement ${longDate(h.date)} · ${h.origin === 'export' ? 'export' : 'scanned PDF'}`
      : 'No statements yet';
  }
  if (a.kind === 'asset') {
    const v = ledger.valuations.filter((x) => x.accountId === a.id);
    return `${v.length} valuations since ${monthYear(a.since)}`;
  }
  if (a.kind === 'mortgage') return `Since ${monthYear(a.since)}`;
  const last = lastActivity(ledger, a.id);
  if (last && last < shiftYear(ledger.asOf)) return `Closed ${monthYear(last)}`;
  return `Since ${monthYear(a.since)}`;
}

function shiftYear(iso: string) {
  return `${Number(iso.slice(0, 4)) - 1}${iso.slice(4)}`;
}

function AccountCard({
  account: a,
  ledger,
  series,
  active,
  onSelect,
}: {
  account: Account;
  ledger: Ledger;
  series: SeriesPoint[];
  active: boolean;
  onSelect: () => void;
}) {
  const b = accountBalance(ledger, a.id);
  const mismatches = ledger.assertions.filter(
    (x) => x.accountId === a.id && !x.ok,
  );
  const markers =
    a.kind === 'asset'
      ? ledger.valuations
          .filter((v) => v.accountId === a.id)
          .map((v) => v.source)
      : undefined;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className={`group flex flex-col rounded-[28px] p-7 text-left transition ${
        active
          ? 'bg-(--raise) shadow-[0_18px_40px_-24px_rgba(0,0,0,0.35)] ring-2 ring-(--ink)'
          : 'bg-(--raise) ring-1 ring-(--hair) hover:-translate-y-0.5 hover:shadow-[0_18px_40px_-28px_rgba(0,0,0,0.35)] hover:ring-(--axis)'
      }`}
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[11px] font-semibold tracking-[0.16em] text-(--muted) uppercase">
          {a.institution} · {KIND_LABEL[a.kind]}
        </span>
        {mismatches.length ? (
          <span className="inline-flex items-center gap-1 text-[12px] text-(--bad)">
            <AlertCircle className="size-3.5" aria-hidden />
            {mismatches.length} statement off
          </span>
        ) : null}
      </div>
      <div className="mt-2 flex flex-wrap items-baseline justify-between gap-x-4">
        <span className="serif text-[24px] text-(--ink)">{a.name}</span>
        <span className="text-[26px] font-light tracking-[-0.02em] text-(--ink)">
          {money(b)}
        </span>
      </div>
      <div className="mt-5">
        <Sparkline
          points={series}
          stepped={a.kind === 'asset'}
          markers={markers}
        />
      </div>
      <div className="mt-4 text-[13px] text-(--muted)">
        {footLine(ledger, a)}
      </div>
    </button>
  );
}

function Feature({
  account: a,
  ledger,
  series,
}: {
  account: Account;
  ledger: Ledger;
  series: SeriesPoint[];
}) {
  const b = accountBalance(ledger, a.id);
  const first = series[0];
  return (
    <section className="vb-in mt-14 rounded-[32px] bg-(--raise) p-6 ring-1 ring-(--hair) sm:p-10">
      <div className="flex flex-wrap items-end justify-between gap-6">
        <div>
          <Kicker>
            {a.institution} · {KIND_LABEL[a.kind]}
          </Kicker>
          <h2 className="serif mt-2 text-[36px] leading-tight text-(--ink) sm:text-[44px]">
            {a.name}
          </h2>
        </div>
        <div className="text-right">
          <div className="text-[44px] leading-none font-light tracking-[-0.03em] text-(--ink) sm:text-[56px]">
            {money(b)}
          </div>
          {first ? (
            <div className="mt-2 text-[14px] text-(--ink2)">
              {signed(b - first.value)} since {monthYear(first.date)}
            </div>
          ) : null}
        </div>
      </div>
      <div className="mt-10">
        {a.kind === 'asset' ? (
          <House ledger={ledger} accountId={a.id} />
        ) : a.kind === 'investment' ? (
          <Holdings ledger={ledger} accountId={a.id} series={series} />
        ) : (
          <Balances ledger={ledger} account={a} series={series} />
        )}
      </div>
    </section>
  );
}

function House({ ledger, accountId }: { ledger: Ledger; accountId: string }) {
  const vals = ledger.valuations.filter((v) => v.accountId === accountId);
  return (
    <>
      <div className="mb-4 flex flex-wrap gap-x-6 gap-y-2 text-[13px] text-(--ink2)">
        {(['purchase', 'assessment', 'estimate'] as const).map((s) => (
          <span key={s} className="inline-flex items-center gap-2">
            <svg width={14} height={14} aria-hidden>
              <ValuationMarker source={s} x={7} y={7} r={4.5} />
            </svg>
            {SOURCE_LABEL[s]}
          </span>
        ))}
      </div>
      <ValuationChart valuations={vals} asOf={ledger.asOf} />
      <p className="mt-3 text-[13px] text-(--muted)">
        The value holds flat between valuations; it only moves when a new one is
        recorded.
      </p>
      <ol className="mt-8 grid gap-x-10 sm:grid-cols-2">
        {vals
          .slice()
          .reverse()
          .map((v, i, arr) => {
            const prev = arr[i + 1];
            return (
              <li
                key={v.date}
                className="flex items-center gap-4 border-t border-(--hair) py-4"
              >
                <svg width={14} height={14} aria-hidden className="shrink-0">
                  <ValuationMarker source={v.source} x={7} y={7} r={4.5} />
                </svg>
                <div className="min-w-0 flex-1">
                  <div className="text-[15px] text-(--ink)">
                    {SOURCE_LABEL[v.source]}
                  </div>
                  <div className="text-[13px] text-(--muted)">
                    {longDate(v.date)}
                  </div>
                </div>
                <div className="text-right">
                  <div className="num text-[15px] font-semibold text-(--ink)">
                    {money(v.value)}
                  </div>
                  {prev ? (
                    <div className="num text-[12px] text-(--muted)">
                      {signed(v.value - prev.value)}
                    </div>
                  ) : null}
                </div>
              </li>
            );
          })}
      </ol>
    </>
  );
}

function Holdings({
  ledger,
  accountId,
  series,
}: {
  ledger: Ledger;
  accountId: string;
  series: SeriesPoint[];
}) {
  const snap = latestHoldings(ledger, accountId);
  return (
    <>
      <LineChart points={series} label="Holdings value at each statement" />
      <p className="mt-3 text-[13px] text-(--muted)">
        One point per quarterly statement. Before 2024 these were read from
        scanned PDFs.
      </p>
      {snap ? (
        <div className="mt-10">
          <h3 className="serif text-[24px] text-(--ink)">
            Positions at the {longDate(snap.date)} statement
          </h3>
          <ul className="mt-5">
            {snap.positions.map((p) => {
              const gain = p.marketValue - p.bookCost;
              const pct = p.bookCost ? (gain / p.bookCost) * 100 : 0;
              const share = snap.total ? (p.marketValue / snap.total) * 100 : 0;
              return (
                <li
                  key={p.symbol}
                  className="grid grid-cols-[5.5rem_1fr_auto] items-baseline gap-x-5 border-t border-(--hair) py-5"
                >
                  <span className="serif text-[26px] text-(--ink)">
                    {p.symbol}
                  </span>
                  <div className="min-w-0">
                    <div className="truncate text-[15px] text-(--ink)">
                      {p.name}
                    </div>
                    <div className="num mt-0.5 text-[13px] text-(--muted)">
                      {p.symbol === 'CASH'
                        ? 'Uninvested'
                        : `${p.quantity.toLocaleString('en-CA')} units at ${cadCents.format(p.price)}`}{' '}
                      · {share.toFixed(0)}% of the account
                    </div>
                    <div className="mt-3 h-[3px] rounded-full bg-(--sunk)">
                      <div
                        className="h-full rounded-full bg-(--s3)"
                        style={{ width: `${share}%` }}
                      />
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="num text-[17px] font-semibold text-(--ink)">
                      {money(p.marketValue)}
                    </div>
                    {p.symbol !== 'CASH' ? (
                      <div
                        className="num text-[12px]"
                        style={{
                          color: gain >= 0 ? 'var(--good)' : 'var(--bad)',
                        }}
                      >
                        {signed(gain)} ({pct >= 0 ? '+' : '−'}
                        {Math.abs(pct).toFixed(0)}%) on cost
                      </div>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
          <p className="mt-2 text-[13px] text-(--muted)">
            From the{' '}
            {snap.origin === 'export'
              ? 'brokerage export'
              : 'scanned statement'}
            .
          </p>
        </div>
      ) : null}
    </>
  );
}

function Balances({
  ledger,
  account: a,
  series,
}: {
  ledger: Ledger;
  account: Account;
  series: SeriesPoint[];
}) {
  const checks = ledger.assertions.filter((x) => x.accountId === a.id);
  const shown =
    a.kind === 'mortgage'
      ? checks.slice(-4).reverse()
      : checks.slice().reverse();
  return (
    <>
      <LineChart
        points={series}
        color={a.kind === 'mortgage' ? 'var(--s7)' : 'var(--s1)'}
        label={`${a.name} balance by month`}
      />
      {a.kind === 'mortgage' && series.length > 1 ? (
        <p className="mt-3 text-[13px] text-(--muted)">
          {money(series[series.length - 1].value - series[0].value)} of
          principal paid since {monthYear(series[0].date)}, read from monthly
          statements.
        </p>
      ) : null}
      {shown.length ? (
        <div className="mt-10">
          <h3 className="serif text-[22px] text-(--ink)">Statement checks</h3>
          <ul className="mt-4">
            {shown.map((c) => {
              const gap = ledger.preview.findings.find(
                (f) =>
                  f.kind === 'missing-period' &&
                  f.accountId === a.id &&
                  f.to === c.date,
              );
              const off =
                gap?.kind === 'missing-period'
                  ? gap.expectedBalance - gap.actualBalance
                  : null;
              return (
                <li
                  key={c.date}
                  className="flex items-start gap-3 border-t border-(--hair) py-4 text-[15px]"
                >
                  {c.ok ? (
                    <CheckCircle2
                      className="mt-0.5 size-4 shrink-0 text-(--good)"
                      aria-hidden
                    />
                  ) : (
                    <AlertCircle
                      className="mt-0.5 size-4 shrink-0 text-(--bad)"
                      aria-hidden
                    />
                  )}
                  <span className="flex-1 text-(--ink)">
                    {longDate(c.date)}: statement says{' '}
                    <span className="num font-semibold">
                      {cadCents.format(c.balance)}
                    </span>
                    {c.ok ? (
                      <span className="text-(--muted)">
                        , and the ledger agrees.
                      </span>
                    ) : (
                      <span className="text-(--ink2)">
                        {off == null ? (
                          '; the ledger does not agree.'
                        ) : (
                          <>
                            ; the ledger is{' '}
                            <span className="num">
                              {cadCents.format(Math.abs(off))}
                            </span>{' '}
                            short. A missing export, flagged in Import.
                          </>
                        )}
                      </span>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      ) : (
        <p className="mt-6 text-[14px] text-(--muted)">
          No statement balances recorded for this account yet, so nothing to
          check the running total against.
        </p>
      )}
    </>
  );
}
