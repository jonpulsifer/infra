import { Check, FileText, ScanLine, TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { accountBalance, latestHoldings } from '~/fixtures/derive';
import type { Account, Ledger } from '~/fixtures/types';
import { isTyping } from '~/variants/a/bits';
import { mLong, SeriesChart, Sparkline } from '~/variants/a/charts';
import { accountSeries } from '~/variants/a/model';
import {
  cx,
  money,
  type Palette,
  pct,
  signedMoney,
  tw,
} from '~/variants/a/theme';
import { Split } from './Split';
import { latestFirst, longDate } from './state';
import { Block, InspectorHead, KV, rowRule, serif, TxnList } from './ui';

const GROUPS: { label: string; note: string; kinds: Account['kind'][] }[] = [
  {
    label: 'Cash & credit',
    note: 'Running balances from every row.',
    kinds: ['chequing', 'savings', 'credit'],
  },
  {
    label: 'Investments',
    note: 'Positions at each statement.',
    kinds: ['investment'],
  },
  {
    label: 'Property & debt',
    note: 'Valuations and mortgage statements.',
    kinds: ['asset', 'mortgage'],
  },
];

export function Accounts({
  ledger,
  pal,
  query,
  initial,
}: {
  ledger: Ledger;
  pal: Palette;
  query: string;
  initial?: string;
}) {
  const [sel, setSel] = useState(
    initial && ledger.accounts.some((a) => a.id === initial)
      ? initial
      : 'ws-tfsa',
  );
  const [sheet, setSheet] = useState(false);
  const { months, series } = useMemo(() => accountSeries(ledger), [ledger]);
  const q = query.trim().toLowerCase();
  const visible = ledger.accounts.filter(
    (a) =>
      !q ||
      a.name.toLowerCase().includes(q) ||
      a.institution.toLowerCase().includes(q) ||
      a.kind.includes(q),
  );
  const order = GROUPS.flatMap((g) =>
    visible.filter((a) => g.kinds.includes(a.kind)),
  );
  const total = ledger.accounts.reduce(
    (s, a) => s + accountBalance(ledger, a.id),
    0,
  );
  const yearAgo = months.length - 13;

  const choose = (id: string) => {
    setSel(id);
    document
      .getElementById(`rf-acct-${id}`)
      ?.scrollIntoView({ block: 'nearest' });
  };

  useEffect(() => {
    document
      .getElementById(`rf-acct-${sel}`)
      ?.scrollIntoView({ block: 'center' });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isTyping(e) || e.metaKey || e.ctrlKey) return;
      if (e.key === 'j' || e.key === 'k') {
        e.preventDefault();
        const i = order.findIndex((a) => a.id === sel);
        const n = Math.max(
          0,
          Math.min(order.length - 1, i + (e.key === 'j' ? 1 : -1)),
        );
        if (order[n]) choose(order[n].id);
      } else if (e.key === 'Enter') setSheet(true);
      else if (e.key === 'Escape') setSheet(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const acct = ledger.accounts.find((a) => a.id === sel)!;

  const reader = (
    <div className="mx-auto max-w-[760px] px-5 pt-10 sm:px-10">
      <div className={cx(tw.label, tw.ink3)}>
        {ledger.accounts.length} accounts · as of {longDate(ledger.asOf)}
      </div>
      <h1 className={cx(serif, 'mt-2 text-[34px] leading-tight', tw.ink)}>
        Accounts
      </h1>
      <div
        className={cx(
          serif,
          'rf-lining mt-4 text-[48px] leading-none tracking-[-0.02em]',
          tw.ink,
        )}
      >
        {money(total, false)}
      </div>
      <p className={cx('mt-2 text-[15px]', tw.ink2)}>
        Net worth across every account, the house at its last valuation and the
        mortgage at its last statement.
      </p>

      {GROUPS.map((g) => {
        const accts = visible.filter((a) => g.kinds.includes(a.kind));
        if (!accts.length) return null;
        const sub = accts.reduce((s, a) => s + accountBalance(ledger, a.id), 0);
        return (
          <section key={g.label} className="mt-12">
            <div
              className={cx('flex items-baseline gap-3 border-b pb-2', tw.rule)}
            >
              <h2 className={cx(serif, 'text-[22px]', tw.ink)}>{g.label}</h2>
              <span className={cx('text-[11px]', tw.ink3)}>{g.note}</span>
              <span className={cx('ml-auto font-mono text-[13px]', tw.ink2)}>
                {money(sub, false)}
              </span>
            </div>
            <ul>
              {accts.map((a) => {
                const s = series.get(a.id) ?? [];
                const bal = accountBalance(ledger, a.id);
                const then = s[yearAgo];
                const delta = then == null ? null : bal - then;
                const on = a.id === sel;
                const closed = a.id === 'scotia-old';
                return (
                  <li key={a.id}>
                    <button
                      type="button"
                      id={`rf-acct-${a.id}`}
                      onClick={() => {
                        setSel(a.id);
                        setSheet(true);
                      }}
                      className={cx(
                        'relative grid w-full grid-cols-[1fr_120px_112px_84px] items-center gap-x-3 border-b py-2.5 pr-1 pl-3 text-left max-sm:grid-cols-[1fr_96px]',
                        rowRule,
                        on ? tw.selected : tw.hover,
                      )}
                    >
                      {on ? (
                        <span className="absolute inset-y-0 left-0 w-[2px] bg-[#2a78d6] dark:bg-[#3987e5]" />
                      ) : null}
                      <span className="min-w-0">
                        <span
                          className={cx('block truncate text-[14px]', tw.ink)}
                        >
                          {a.name}
                        </span>
                        <span
                          className={cx('block truncate text-[11px]', tw.ink3)}
                        >
                          {a.institution} · {a.kind} · since{' '}
                          {a.since.slice(0, 7)}
                          {closed ? ' · closed 2022-03' : ''}
                        </span>
                      </span>
                      <span className="max-sm:hidden">
                        <Sparkline
                          values={s}
                          width={120}
                          height={24}
                          color={on ? pal.accent : pal.ink3}
                          fill
                        />
                      </span>
                      <span
                        className={cx(
                          'text-right font-mono text-[13px] tabular-nums',
                          closed ? tw.ink3 : tw.ink,
                        )}
                      >
                        {money(bal, false)}
                      </span>
                      <span
                        className={cx(
                          'text-right font-mono text-[11px] tabular-nums max-sm:hidden',
                          delta == null || Math.abs(delta) < 1
                            ? tw.ink3
                            : delta > 0
                              ? tw.good
                              : tw.bad,
                        )}
                      >
                        {delta == null ? '—' : signedMoney(delta, false)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
      <p className={cx('mt-4 text-[11px]', tw.ink3)}>
        Sparklines share one time axis, {months[0]?.slice(0, 4)} to{' '}
        {months[months.length - 1]?.slice(0, 4)}, each on its own scale. The
        last column is the change over twelve months.
      </p>
    </div>
  );

  return (
    <Split
      open={sheet}
      setOpen={setSheet}
      peek={`${acct.name} · ${money(accountBalance(ledger, acct.id), false)}`}
      reader={reader}
      inspector={
        <AccountInspector
          key={acct.id}
          ledger={ledger}
          acct={acct}
          pal={pal}
          values={series.get(acct.id) ?? []}
          months={months}
        />
      }
    />
  );
}

function AccountInspector({
  ledger,
  acct,
  pal,
  values,
  months,
}: {
  ledger: Ledger;
  acct: Account;
  pal: Palette;
  values: (number | null)[];
  months: string[];
}) {
  const bal = accountBalance(ledger, acct.id);
  const snap =
    acct.kind === 'investment' ? latestHoldings(ledger, acct.id) : null;
  return (
    <div className="rf-in">
      <InspectorHead
        kicker={`${acct.institution} · ${acct.kind}`}
        title={acct.name}
        figure={money(bal)}
        sub={
          snap
            ? `Latest statement ${snap.date}, ${snap.origin === 'statement-pdf' ? 'from a scanned PDF' : 'from an export'}`
            : acct.kind === 'asset'
              ? 'Manual valuations'
              : acct.kind === 'mortgage'
                ? 'Balance from monthly statements'
                : `Running balance from ${ledger.transactions.filter((t) => t.accountId === acct.id).length.toLocaleString('en-CA')} rows`
        }
      />
      {acct.kind === 'investment' ? (
        <Investment ledger={ledger} acct={acct} pal={pal} />
      ) : acct.kind === 'asset' ? (
        <House ledger={ledger} pal={pal} />
      ) : acct.kind === 'mortgage' ? (
        <Mortgage ledger={ledger} pal={pal} />
      ) : (
        <Cash
          ledger={ledger}
          acct={acct}
          pal={pal}
          values={values}
          months={months}
        />
      )}
    </div>
  );
}

function Investment({
  ledger,
  acct,
  pal,
}: {
  ledger: Ledger;
  acct: Account;
  pal: Palette;
}) {
  const snaps = ledger.holdings.filter((h) => h.accountId === acct.id);
  const snap = snaps[snaps.length - 1];
  if (!snap)
    return (
      <div className={cx('p-4 text-[12px]', tw.ink3)}>No statements yet.</div>
    );
  const book = snap.positions.reduce((s, p) => s + p.bookCost, 0);
  const rows = snaps.map((h) => ({
    date: h.date,
    value: h.total,
    book: h.positions.reduce((s, p) => s + p.bookCost, 0),
    note:
      h.origin === 'statement-pdf'
        ? 'From a scanned statement'
        : 'From an export',
  }));
  return (
    <>
      <Block
        title={`Positions at ${snap.date}`}
        right={
          <span
            className={cx('font-mono', snap.total >= book ? tw.good : tw.bad)}
          >
            {signedMoney(snap.total - book, false)} unrealised
          </span>
        }
      >
        <table className="w-full table-fixed text-[11px]">
          <thead>
            <tr className={cx(tw.label, tw.ink3)}>
              <th className="w-[46px] pb-1 text-left font-medium">Symbol</th>
              <th className="w-[54px] pb-1 text-right font-medium">Qty</th>
              <th className="w-[48px] pb-1 text-right font-medium">Price</th>
              <th className="pb-1 text-right font-medium">Value</th>
              <th className="w-[50px] pb-1 text-right font-medium">Gain</th>
              <th className="w-[60px] pb-1 pl-2 text-left font-medium">Wt</th>
            </tr>
          </thead>
          <tbody>
            {snap.positions.map((p) => {
              const gain = p.marketValue - p.bookCost;
              const w = p.marketValue / snap.total;
              return (
                <tr
                  key={p.symbol}
                  title={p.name}
                  className={cx('border-t', rowRule)}
                >
                  <td className={cx('h-[24px] font-mono', tw.ink)}>
                    {p.symbol}
                  </td>
                  <td className={cx('text-right font-mono', tw.ink2)}>
                    {p.quantity.toLocaleString('en-CA', {
                      maximumFractionDigits: 2,
                    })}
                  </td>
                  <td className={cx('text-right font-mono', tw.ink2)}>
                    {p.price.toFixed(2)}
                  </td>
                  <td className={cx('text-right font-mono', tw.ink)}>
                    {money(p.marketValue, false)}
                  </td>
                  <td
                    className={cx(
                      'text-right font-mono',
                      Math.abs(gain) < 1
                        ? tw.ink3
                        : gain > 0
                          ? tw.good
                          : tw.bad,
                    )}
                  >
                    {Math.abs(gain) < 1 ? '—' : pct(gain / p.bookCost, 1)}
                  </td>
                  <td className="pl-2">
                    <div className="flex items-center gap-1">
                      <div
                        className="h-[6px] flex-1 rounded-r-[2px]"
                        style={{ background: pal.grid }}
                      >
                        <div
                          className="h-full rounded-r-[2px]"
                          style={{ width: `${w * 100}%`, background: pal.ink2 }}
                        />
                      </div>
                      <span
                        className={cx(
                          'w-6 text-right font-mono text-[10px]',
                          tw.ink3,
                        )}
                      >
                        {pct(w)}
                      </span>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className={cx('border-t-2', tw.rule)}>
              <td colSpan={3} className={cx('pt-1.5', tw.ink3)}>
                Book cost {money(book, false)}
              </td>
              <td
                className={cx(
                  'pt-1.5 text-right font-mono font-semibold',
                  tw.ink,
                )}
              >
                {money(snap.total, false)}
              </td>
              <td colSpan={2} />
            </tr>
          </tfoot>
        </table>
        <ul className={cx('mt-2 space-y-0.5 text-[11px]', tw.ink3)}>
          {snap.positions.map((p) => (
            <li key={p.symbol} className="truncate">
              <span className="font-mono">{p.symbol}</span> {p.name}
            </li>
          ))}
        </ul>
      </Block>
      <Block title="Value vs book cost">
        <SeriesChart
          rows={rows}
          series={[
            { key: 'value', label: 'Market value', color: pal.ink, area: true },
            { key: 'book', label: 'Book cost', color: pal.ink3 },
          ]}
          pal={pal}
          height={150}
          zeroBase
        />
      </Block>
      <Block title="Statements" right={`${snaps.length} quarterly`}>
        <ul className="grid grid-cols-2 gap-x-4 text-[11px]">
          {[...snaps]
            .reverse()
            .slice(0, 12)
            .map((h) => (
              <li
                key={h.date}
                className={cx(
                  'flex h-6 items-center gap-1.5 border-b',
                  rowRule,
                )}
              >
                {h.origin === 'statement-pdf' ? (
                  <ScanLine size={11} className={tw.ink3} />
                ) : (
                  <FileText size={11} className={tw.ink3} />
                )}
                <span className={cx('font-mono', tw.ink2)}>{h.date}</span>
                <span className={cx('ml-auto font-mono', tw.ink)}>
                  {money(h.total, false)}
                </span>
              </li>
            ))}
        </ul>
      </Block>
    </>
  );
}

const SOURCE_SHAPE = {
  purchase: 'square',
  assessment: 'filled',
  estimate: 'hollow',
} as const;

function House({ ledger, pal }: { ledger: Ledger; pal: Palette }) {
  const vals = ledger.valuations.filter((v) => v.accountId === 'house');
  const last = vals[vals.length - 1];
  const rows = [
    ...vals.map((v) => ({
      date: v.date,
      value: v.value,
      source: v.source,
      note: `${v.source[0].toUpperCase()}${v.source.slice(1)}`,
    })),
    {
      date: ledger.asOf,
      value: last.value,
      source: null,
      note: 'Carried forward to today',
    },
  ];
  const mortgage = accountBalance(ledger, 'mortgage');
  const equity = last.value + mortgage;
  return (
    <>
      <Block
        title="Valuations"
        right="square purchase · dot assessment · ring estimate"
      >
        <table className="w-full table-fixed text-[11px]">
          <thead>
            <tr className={cx(tw.label, tw.ink3)}>
              <th className="w-[80px] pb-1 text-left font-medium">Date</th>
              <th className="pb-1 text-left font-medium">Source</th>
              <th className="pb-1 text-right font-medium">Value</th>
              <th className="w-[118px] pb-1 text-right font-medium">Change</th>
            </tr>
          </thead>
          <tbody>
            {[...vals].reverse().map((v, i, arr) => {
              const prev = arr[i + 1];
              const d = prev ? v.value - prev.value : null;
              return (
                <tr key={v.date} className={cx('border-t', rowRule)}>
                  <td className={cx('h-[24px] font-mono', tw.ink2)}>
                    {v.date}
                  </td>
                  <td className={cx('capitalize', tw.ink2)}>
                    <span className="inline-flex items-center gap-1.5">
                      <span
                        className={cx(
                          'inline-block h-2 w-2',
                          SOURCE_SHAPE[v.source] === 'square'
                            ? 'rounded-[1px]'
                            : 'rounded-full',
                        )}
                        style={
                          SOURCE_SHAPE[v.source] === 'hollow'
                            ? { boxShadow: `inset 0 0 0 1.5px ${pal.ink2}` }
                            : { background: pal.ink2 }
                        }
                      />
                      {v.source}
                    </span>
                  </td>
                  <td className={cx('text-right font-mono', tw.ink)}>
                    {money(v.value, false)}
                  </td>
                  <td
                    className={cx(
                      'text-right font-mono',
                      d == null ? tw.ink3 : d >= 0 ? tw.good : tw.bad,
                    )}
                  >
                    {d == null
                      ? '—'
                      : `${signedMoney(d, false)} ${pct(d / prev!.value, 1)}`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Block>
      <Block title="Value over time">
        <SeriesChart
          rows={rows}
          series={[{ key: 'value', label: 'Value', color: pal.ink }]}
          pal={pal}
          step
          height={160}
          dotFor={(r) =>
            r.source
              ? SOURCE_SHAPE[r.source as keyof typeof SOURCE_SHAPE]
              : null
          }
        />
        <p className={cx('mt-1 text-[11px]', tw.ink3)}>
          A step holds each value until the next; nothing is interpolated.
        </p>
      </Block>
      <Block title="Equity">
        <KV
          rows={[
            [
              'House',
              <span key="v" className="font-mono">
                {money(last.value, false)}
              </span>,
            ],
            [
              'Mortgage',
              <span key="v" className="font-mono">
                {money(mortgage, false)}
              </span>,
            ],
            [
              'Equity',
              <span key="v" className="font-mono font-semibold">
                {money(equity, false)}
              </span>,
            ],
          ]}
        />
        <div
          className="mt-2 flex h-2 overflow-hidden rounded-[2px]"
          aria-hidden
        >
          <div
            style={{
              width: `${(equity / last.value) * 100}%`,
              background: pal.ink,
            }}
          />
          <div className="ml-[2px] flex-1" style={{ background: pal.spend }} />
        </div>
        <div className={cx('mt-1 text-[11px]', tw.ink3)}>
          {pct(equity / last.value)} owned outright
        </div>
      </Block>
    </>
  );
}

function Mortgage({ ledger, pal }: { ledger: Ledger; pal: Palette }) {
  const pts = ledger.assertions.filter((a) => a.accountId === 'mortgage');
  const first = pts[0];
  const last = pts[pts.length - 1];
  const rows = pts.map((a) => ({ date: a.date.slice(0, 7), owed: -a.balance }));
  return (
    <>
      <Block title="Paid down">
        <KV
          rows={[
            [
              'First statement',
              <span key="v" className="font-mono">
                {money(-first.balance, false)}
              </span>,
            ],
            [
              'Now owed',
              <span key="v" className="font-mono">
                {money(-last.balance, false)}
              </span>,
            ],
            [
              'Principal paid',
              <span key="v" className="font-mono">
                {money(last.balance - first.balance, false)}
              </span>,
              tw.good,
            ],
            ['Statements', `${pts.length}, every one reconciled`],
          ]}
        />
      </Block>
      <Block title="Owed">
        <SeriesChart
          rows={rows}
          series={[{ key: 'owed', label: 'Owed', color: pal.ink, area: true }]}
          pal={pal}
          height={160}
          zeroBase
        />
      </Block>
      <Block
        title="Statements"
        right={`${mLong(first.date.slice(0, 7))} – ${mLong(last.date.slice(0, 7))}`}
      >
        <table className="w-full table-fixed text-[11px]">
          <tbody>
            {[...pts]
              .reverse()
              .slice(0, 12)
              .map((a, i, arr) => {
                const prev = arr[i + 1];
                return (
                  <tr key={a.date} className={cx('border-t', rowRule)}>
                    <td className={cx('h-[22px] w-[84px] font-mono', tw.ink2)}>
                      {a.date}
                    </td>
                    <td className={cx('text-right font-mono', tw.ink)}>
                      {money(a.balance)}
                    </td>
                    <td
                      className={cx('w-[90px] text-right font-mono', tw.good)}
                    >
                      {prev ? signedMoney(a.balance - prev.balance) : ''}
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </Block>
    </>
  );
}

function Cash({
  ledger,
  acct,
  pal,
  values,
  months,
}: {
  ledger: Ledger;
  acct: Account;
  pal: Palette;
  values: (number | null)[];
  months: string[];
}) {
  const rows = months
    .map((m, i) => ({ date: m, balance: values[i] }))
    .filter((r) => r.balance != null);
  const checks = ledger.assertions.filter((a) => a.accountId === acct.id);
  const recent = latestFirst(
    ledger.transactions.filter((t) => t.accountId === acct.id),
  );
  const catName = (id: string) =>
    ledger.categories.find((c) => c.id === id)?.name ?? id;
  return (
    <>
      <Block title="Month-end balance">
        <SeriesChart
          rows={rows}
          series={[
            { key: 'balance', label: 'Balance', color: pal.ink, area: true },
          ]}
          pal={pal}
          height={150}
        />
      </Block>
      <Block title="Statement checks" right={`${checks.length} recorded`}>
        {checks.length ? (
          <ul className="text-[11px]">
            {checks.map((c) => (
              <li
                key={c.date}
                className={cx('flex h-6 items-center gap-2 border-t', rowRule)}
              >
                {c.ok ? (
                  <Check size={11} className={tw.good} />
                ) : (
                  <TriangleAlert size={11} className={tw.warn} />
                )}
                <span className={cx('font-mono', tw.ink2)}>{c.date}</span>
                <span className={c.ok ? tw.ink3 : tw.warn}>
                  {c.ok ? 'reconciles' : 'does not reconcile: see Import'}
                </span>
                <span className={cx('ml-auto font-mono', tw.ink)}>
                  {money(c.balance)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className={cx('text-[12px]', tw.ink3)}>
            No statement balances recorded for this account.
          </p>
        )}
      </Block>
      <Block title="Latest rows">
        <TxnList rows={recent} limit={16} catName={catName} showCategory />
      </Block>
    </>
  );
}
