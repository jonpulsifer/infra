import { Check, FileText, ScanLine, TriangleAlert } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { accountBalance, latestHoldings } from '~/fixtures/derive';
import type { Account, Ledger } from '~/fixtures/types';
import { isTyping, ScreenTitle, Swatch, useWidth } from './bits';
import { mLong, SeriesChart, Sparkline } from './charts';
import { accountSeries } from './model';
import { cx, money, type Palette, pct, signedMoney, tw } from './theme';

const GROUPS: { label: string; kinds: Account['kind'][] }[] = [
  { label: 'Cash & credit', kinds: ['chequing', 'savings', 'credit'] },
  { label: 'Investments', kinds: ['investment'] },
  { label: 'Property & debt', kinds: ['asset', 'mortgage'] },
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
  const [sparkRef, sparkW] = useWidth<HTMLTableCellElement>();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e) || e.metaKey || e.ctrlKey) return;
      if (e.key !== 'j' && e.key !== 'k') return;
      e.preventDefault();
      const i = order.findIndex((a) => a.id === sel);
      const n = Math.max(
        0,
        Math.min(order.length - 1, i + (e.key === 'j' ? 1 : -1)),
      );
      if (order[n]) setSel(order[n].id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const yearAgo = months.length - 13;
  const acct = ledger.accounts.find((a) => a.id === sel)!;
  const total = ledger.accounts.reduce(
    (s, a) => s + accountBalance(ledger, a.id),
    0,
  );

  const institutions = new Set(ledger.accounts.map((a) => a.institution)).size;
  const stale = ledger.assertions.filter(
    (a) => !a.ok && order.some((o) => o.id === a.accountId),
  ).length;

  return (
    <div className="flex h-full flex-col">
      <ScreenTitle
        title="Accounts"
        aside="and holdings"
        intro={
          <>
            {ledger.accounts.length} accounts at {institutions} institutions,
            worth {money(total, false)} together; holdings come from the latest
            statement, the house from its latest valuation
            {stale
              ? `, and ${stale} ${stale === 1 ? 'balance check disagrees' : 'balance checks disagree'} with the ledger`
              : ''}
            .
          </>
        }
      />
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(420px,46%)]">
        <div className={cx('min-h-0 overflow-auto pb-16 lg:border-r', tw.rule)}>
          <table className="w-full table-fixed border-separate border-spacing-0 text-[12px]">
            <thead className={cx('sticky top-0 z-10', tw.surface)}>
              <tr className={cx(tw.label, tw.ink3)}>
                <th
                  className={cx(
                    'h-7 border-b pl-3 text-left font-medium',
                    tw.rule,
                  )}
                >
                  Account
                </th>
                <th
                  className={cx(
                    'h-7 w-[84px] border-b text-left font-medium',
                    tw.rule,
                  )}
                >
                  Kind
                </th>
                <th
                  ref={sparkRef}
                  className={cx(
                    'h-7 w-[30%] border-b text-left font-medium',
                    tw.rule,
                  )}
                >
                  <span className="flex justify-between pr-3">
                    <span>{months[0]?.slice(0, 4)}</span>
                    <span>History</span>
                    <span>{months[months.length - 1]?.slice(0, 4)}</span>
                  </span>
                </th>
                <th
                  className={cx(
                    'h-7 w-[112px] border-b text-right font-medium',
                    tw.rule,
                  )}
                >
                  Balance
                </th>
                <th
                  className={cx(
                    'h-7 w-[96px] border-b pr-3 text-right font-medium',
                    tw.rule,
                  )}
                >
                  12 mo
                </th>
              </tr>
            </thead>
            {GROUPS.map((g) => {
              const accts = visible.filter((a) => g.kinds.includes(a.kind));
              if (!accts.length) return null;
              const sub = accts.reduce(
                (s, a) => s + accountBalance(ledger, a.id),
                0,
              );
              return (
                <tbody key={g.label}>
                  <tr>
                    <td
                      colSpan={3}
                      className={cx(
                        'h-7 border-b pl-3',
                        tw.rule,
                        tw.wash,
                        tw.label,
                        tw.ink2,
                      )}
                    >
                      {g.label}
                    </td>
                    <td
                      colSpan={2}
                      className={cx(
                        'h-7 border-b pr-3 text-right',
                        tw.rule,
                        tw.wash,
                        tw.num,
                        tw.ink2,
                      )}
                    >
                      {money(sub, false)}
                    </td>
                  </tr>
                  {accts.map((a) => {
                    const s = series.get(a.id) ?? [];
                    const bal = accountBalance(ledger, a.id);
                    const then = s[yearAgo];
                    const delta = then == null ? null : bal - then;
                    const on = a.id === sel;
                    const closed = a.id === 'scotia-old';
                    return (
                      <tr
                        key={a.id}
                        onClick={() => setSel(a.id)}
                        className={cx(
                          'cursor-pointer',
                          on ? tw.selected : tw.hover,
                        )}
                      >
                        <td
                          className={cx(
                            'relative h-10 border-b pl-3',
                            'border-[#efeee9] dark:border-[#20201e]',
                          )}
                        >
                          {on ? (
                            <span className="absolute inset-y-0 left-0 w-[2px] bg-[#2a78d6] dark:bg-[#3987e5]" />
                          ) : null}
                          <button
                            type="button"
                            onClick={() => setSel(a.id)}
                            className="text-left outline-none"
                          >
                            <span className={cx('block', tw.ink)}>
                              {a.name}
                            </span>
                            <span className={cx('block text-[11px]', tw.ink3)}>
                              {a.institution} · since {a.since.slice(0, 7)}
                              {closed ? ' · closed 2022-03' : ''}
                            </span>
                          </button>
                        </td>
                        <td
                          className={cx(
                            'border-b text-[11px]',
                            'border-[#efeee9] dark:border-[#20201e]',
                            tw.ink2,
                          )}
                        >
                          {a.kind}
                        </td>
                        <td
                          className={cx(
                            'border-b pr-3',
                            'border-[#efeee9] dark:border-[#20201e]',
                          )}
                        >
                          <Sparkline
                            values={s}
                            width={Math.max(60, sparkW - 12)}
                            height={24}
                            color={on ? pal.accent : pal.ink2}
                            fill
                          />
                        </td>
                        <td
                          className={cx(
                            'border-b text-right',
                            'border-[#efeee9] dark:border-[#20201e]',
                            tw.num,
                            closed ? tw.ink3 : tw.ink,
                          )}
                        >
                          {money(bal, false)}
                        </td>
                        <td
                          className={cx(
                            'border-b pr-3 text-right text-[11px]',
                            'border-[#efeee9] dark:border-[#20201e]',
                            tw.num,
                            delta == null || Math.abs(delta) < 1
                              ? tw.ink3
                              : delta > 0
                                ? tw.good
                                : tw.bad,
                          )}
                        >
                          {delta == null ? '—' : signedMoney(delta, false)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              );
            })}
            <tfoot>
              <tr>
                <td colSpan={3} className={cx('h-9 pl-3', tw.label, tw.ink2)}>
                  Net worth
                </td>
                <td className={cx('text-right font-semibold', tw.num, tw.ink)}>
                  {money(total, false)}
                </td>
                <td />
              </tr>
            </tfoot>
          </table>
          <p className={cx('px-3 pt-2 text-[11px]', tw.ink3)}>
            Sparklines share one time axis and each has its own scale.{' '}
            <span className="font-mono">j</span>/
            <span className="font-mono">k</span> to move.
          </p>
        </div>

        <div className="min-h-0 overflow-auto pb-16">
          <AccountDetail
            key={acct.id}
            ledger={ledger}
            acct={acct}
            pal={pal}
            values={series.get(acct.id) ?? []}
            months={months}
          />
        </div>
      </div>
    </div>
  );
}

function Head({
  acct,
  value,
  sub,
}: {
  acct: Account;
  value: number;
  sub: ReactNode;
}) {
  return (
    <div className={cx('border-b px-4 py-3', tw.rule)}>
      <div className={cx(tw.label, tw.ink3)}>
        {acct.institution} · {acct.kind}
      </div>
      <div className="mt-0.5 flex items-baseline gap-3">
        <h2 className={cx(tw.serif, 'text-[22px] leading-tight', tw.ink)}>
          {acct.name}
        </h2>
        <span
          className={cx(
            tw.serif,
            'ml-auto text-[26px] leading-none tracking-[-0.01em] tabular-nums',
            tw.ink,
          )}
        >
          {money(value)}
        </span>
      </div>
      <div className={cx('mt-0.5 text-[11px]', tw.ink3)}>{sub}</div>
    </div>
  );
}

function Section({
  title,
  children,
  right,
}: {
  title: string;
  children: ReactNode;
  right?: ReactNode;
}) {
  return (
    <section className={cx('border-b px-4 py-3', tw.rule)}>
      <div className="mb-2 flex items-center">
        <h3 className={cx(tw.label, tw.ink2)}>{title}</h3>
        <div className="ml-auto">{right}</div>
      </div>
      {children}
    </section>
  );
}

function AccountDetail({
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
  const body = (() => {
    if (acct.kind === 'investment')
      return <Investment ledger={ledger} acct={acct} pal={pal} />;
    if (acct.kind === 'asset') return <House ledger={ledger} pal={pal} />;
    if (acct.kind === 'mortgage') return <Mortgage ledger={ledger} pal={pal} />;
    return (
      <Cash
        ledger={ledger}
        acct={acct}
        pal={pal}
        values={values}
        months={months}
      />
    );
  })();
  const snap =
    acct.kind === 'investment' ? latestHoldings(ledger, acct.id) : null;
  return (
    <div className="animate-[desk-in_140ms_ease-out]">
      <Head
        acct={acct}
        value={bal}
        sub={
          snap
            ? `Latest statement ${snap.date} · ${snap.origin === 'statement-pdf' ? 'from a scanned PDF' : 'from an export'}`
            : acct.kind === 'asset'
              ? 'Manual valuations'
              : acct.kind === 'mortgage'
                ? 'Balance from monthly statements'
                : `Running balance from ${ledger.transactions.filter((t) => t.accountId === acct.id).length.toLocaleString('en-CA')} rows`
        }
      />
      {body}
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
      <Section
        title="Value vs book cost"
        right={
          <div className={cx('flex gap-3 text-[10px]', tw.ink3)}>
            <span className="flex items-center gap-1">
              <Swatch color={pal.ink} shape="line" /> Market value
            </span>
            <span className="flex items-center gap-1">
              <Swatch color={pal.ink3} shape="line" /> Book cost
            </span>
          </div>
        }
      >
        <SeriesChart
          rows={rows}
          series={[
            { key: 'value', label: 'Market value', color: pal.ink, area: true },
            { key: 'book', label: 'Book cost', color: pal.ink3 },
          ]}
          pal={pal}
          zeroBase
        />
      </Section>
      <Section
        title={`Positions at ${snap.date}`}
        right={
          <span
            className={cx(
              'text-[11px]',
              tw.num,
              snap.total >= book ? tw.good : tw.bad,
            )}
          >
            {signedMoney(snap.total - book, false)} unrealised
          </span>
        }
      >
        <table className="w-full table-fixed text-[12px]">
          <thead>
            <tr className={cx(tw.label, tw.ink3)}>
              <th className="w-14 pb-1 text-left font-medium">Symbol</th>
              <th className="pb-1 text-left font-medium">Name</th>
              <th className="w-[70px] pb-1 text-right font-medium">Qty</th>
              <th className="w-[60px] pb-1 text-right font-medium">Price</th>
              <th className="w-[88px] pb-1 text-right font-medium">Value</th>
              <th className="w-[76px] pb-1 text-right font-medium">Gain</th>
              <th className="w-[72px] pb-1 pl-2 text-left font-medium">
                Weight
              </th>
            </tr>
          </thead>
          <tbody>
            {snap.positions.map((p) => {
              const gain = p.marketValue - p.bookCost;
              const w = p.marketValue / snap.total;
              return (
                <tr key={p.symbol} className={cx('border-t', tw.rule)}>
                  <td className={cx('py-1.5 font-mono text-[11px]', tw.ink)}>
                    {p.symbol}
                  </td>
                  <td className={cx('truncate py-1.5 pr-2', tw.ink2)}>
                    {p.name}
                  </td>
                  <td className={cx('py-1.5 text-right', tw.num, tw.ink2)}>
                    {p.quantity.toLocaleString('en-CA', {
                      maximumFractionDigits: 2,
                    })}
                  </td>
                  <td className={cx('py-1.5 text-right', tw.num, tw.ink2)}>
                    {p.price.toFixed(2)}
                  </td>
                  <td className={cx('py-1.5 text-right', tw.num, tw.ink)}>
                    {money(p.marketValue, false)}
                  </td>
                  <td
                    className={cx(
                      'py-1.5 text-right text-[11px]',
                      tw.num,
                      Math.abs(gain) < 1
                        ? tw.ink3
                        : gain > 0
                          ? tw.good
                          : tw.bad,
                    )}
                  >
                    {Math.abs(gain) < 1 ? '—' : pct(gain / p.bookCost, 1)}
                  </td>
                  <td className="py-1.5 pl-2">
                    <div className="flex items-center gap-1.5">
                      <div
                        className="h-2 flex-1 rounded-r-[2px]"
                        style={{ background: pal.grid }}
                      >
                        <div
                          className="h-2 rounded-r-[2px]"
                          style={{ width: `${w * 100}%`, background: pal.ink2 }}
                        />
                      </div>
                      <span
                        className={cx(
                          'w-7 text-right text-[10px]',
                          tw.num,
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
            <tr className={cx('border-t', tw.rule)}>
              <td colSpan={4} className={cx('py-1.5 text-[11px]', tw.ink3)}>
                Book cost {money(book, false)}
              </td>
              <td
                className={cx(
                  'py-1.5 text-right font-semibold',
                  tw.num,
                  tw.ink,
                )}
              >
                {money(snap.total, false)}
              </td>
              <td colSpan={2} />
            </tr>
          </tfoot>
        </table>
      </Section>
      <Section
        title="Statements"
        right={
          <span className={cx('text-[11px]', tw.ink3)}>
            {snaps.length} quarterly
          </span>
        }
      >
        <ul className="grid grid-cols-2 gap-x-4 text-[11px]">
          {[...snaps]
            .reverse()
            .slice(0, 12)
            .map((h) => (
              <li
                key={h.date}
                className={cx(
                  'flex h-6 items-center gap-2 border-b',
                  'border-[#efeee9] dark:border-[#20201e]',
                )}
              >
                {h.origin === 'statement-pdf' ? (
                  <ScanLine size={11} className={tw.ink3} />
                ) : (
                  <FileText size={11} className={tw.ink3} />
                )}
                <span className={cx(tw.num, tw.ink2)}>{h.date}</span>
                <span className={cx('ml-auto', tw.num, tw.ink)}>
                  {money(h.total, false)}
                </span>
              </li>
            ))}
        </ul>
      </Section>
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
      <Section
        title="Valuations"
        right={
          <div className={cx('flex gap-3 text-[10px]', tw.ink3)}>
            <Marker kind="square" color={pal.ink} label="Purchase" />
            <Marker kind="filled" color={pal.ink} label="Assessment" />
            <Marker kind="hollow" color={pal.ink} label="Estimate" />
          </div>
        }
      >
        <SeriesChart
          rows={rows}
          series={[{ key: 'value', label: 'Value', color: pal.ink }]}
          pal={pal}
          step
          height={200}
          dotFor={(r) =>
            r.source
              ? SOURCE_SHAPE[r.source as keyof typeof SOURCE_SHAPE]
              : null
          }
        />
        <p className={cx('mt-1 text-[11px]', tw.ink3)}>
          A step holds each value until the next one; nothing is interpolated
          between assessments.
        </p>
      </Section>
      <Section title="Equity">
        <div className="grid grid-cols-3 gap-px text-[12px]">
          {(
            [
              ['House', last.value],
              ['Mortgage', mortgage],
              ['Equity', equity],
            ] as const
          ).map(([k, v]) => (
            <div key={k}>
              <div className={cx(tw.label, tw.ink3)}>{k}</div>
              <div className={cx('font-mono text-[14px]', tw.ink)}>
                {money(v, false)}
              </div>
            </div>
          ))}
        </div>
        <div
          className="mt-2 flex h-2 overflow-hidden rounded-[2px]"
          aria-hidden="true"
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
      </Section>
      <Section title="History">
        <table className="w-full text-[12px]">
          <thead>
            <tr className={cx(tw.label, tw.ink3)}>
              <th className="pb-1 text-left font-medium">Date</th>
              <th className="pb-1 text-left font-medium">Source</th>
              <th className="pb-1 text-right font-medium">Value</th>
              <th className="pb-1 text-right font-medium">Change</th>
            </tr>
          </thead>
          <tbody>
            {[...vals].reverse().map((v, i, arr) => {
              const prev = arr[i + 1];
              const d = prev ? v.value - prev.value : null;
              return (
                <tr key={v.date} className={cx('border-t', tw.rule)}>
                  <td className={cx('py-1.5', tw.num, tw.ink2)}>{v.date}</td>
                  <td className="py-1.5">
                    <Marker
                      kind={SOURCE_SHAPE[v.source]}
                      color={pal.ink2}
                      label={v.source}
                    />
                  </td>
                  <td className={cx('py-1.5 text-right', tw.num, tw.ink)}>
                    {money(v.value, false)}
                  </td>
                  <td
                    className={cx(
                      'py-1.5 text-right text-[11px]',
                      tw.num,
                      d == null ? tw.ink3 : d >= 0 ? tw.good : tw.bad,
                    )}
                  >
                    {d == null
                      ? '—'
                      : `${signedMoney(d, false)} · ${pct(d / prev!.value, 1)}`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Section>
    </>
  );
}

function Marker({
  kind,
  color,
  label,
}: {
  kind: 'square' | 'filled' | 'hollow';
  color: string;
  label: string;
}) {
  return (
    <span
      className={cx('inline-flex items-center gap-1.5 capitalize', tw.ink2)}
    >
      <span
        className={cx(
          'inline-block h-2 w-2',
          kind === 'square' ? 'rounded-[1px]' : 'rounded-full',
        )}
        style={
          kind === 'hollow'
            ? { boxShadow: `inset 0 0 0 1.5px ${color}` }
            : { background: color }
        }
      />
      {label}
    </span>
  );
}

function Mortgage({ ledger, pal }: { ledger: Ledger; pal: Palette }) {
  const pts = ledger.assertions.filter((a) => a.accountId === 'mortgage');
  const first = pts[0];
  const last = pts[pts.length - 1];
  const rows = pts.map((a) => ({ date: a.date.slice(0, 7), owed: -a.balance }));
  return (
    <>
      <Section title="Owed">
        <SeriesChart
          rows={rows}
          series={[{ key: 'owed', label: 'Owed', color: pal.ink, area: true }]}
          pal={pal}
          zeroBase
        />
      </Section>
      <Section title="Paid down">
        <div className="grid grid-cols-3 text-[12px]">
          {(
            [
              ['First statement', -first.balance],
              ['Now', -last.balance],
              ['Principal paid', last.balance - first.balance],
            ] as const
          ).map(([k, v]) => (
            <div key={k}>
              <div className={cx(tw.label, tw.ink3)}>{k}</div>
              <div className={cx('font-mono text-[14px]', tw.ink)}>
                {money(v, false)}
              </div>
            </div>
          ))}
        </div>
        <div className={cx('mt-2 text-[11px]', tw.ink3)}>
          {pts.length} statements, every one reconciled.{' '}
          {mLong(first.date.slice(0, 7))} – {mLong(last.date.slice(0, 7))}
        </div>
      </Section>
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
  const recent = ledger.transactions
    .filter((t) => t.accountId === acct.id)
    .slice(-8)
    .reverse();
  return (
    <>
      <Section title="Month-end balance">
        <SeriesChart
          rows={rows}
          series={[
            { key: 'balance', label: 'Balance', color: pal.ink, area: true },
          ]}
          pal={pal}
        />
      </Section>
      <Section title="Statement checks">
        {checks.length ? (
          <ul className="text-[12px]">
            {checks.map((c) => (
              <li
                key={c.date}
                className={cx(
                  'flex h-7 items-center gap-2 border-b',
                  'border-[#efeee9] dark:border-[#20201e]',
                )}
              >
                {c.ok ? (
                  <Check size={12} className={tw.good} />
                ) : (
                  <TriangleAlert size={12} className={tw.warn} />
                )}
                <span className={cx(tw.num, tw.ink2)}>{c.date}</span>
                <span className={cx('text-[11px]', c.ok ? tw.ink3 : tw.warn)}>
                  {c.ok ? 'reconciles' : 'does not reconcile: see Import'}
                </span>
                <span className={cx('ml-auto', tw.num, tw.ink)}>
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
      </Section>
      <Section title="Latest rows">
        <ul className="text-[12px]">
          {recent.map((t) => (
            <li
              key={t.id}
              className={cx(
                'flex h-7 items-center gap-3 border-b',
                'border-[#efeee9] dark:border-[#20201e]',
              )}
            >
              <span className={cx('w-[76px]', tw.num, tw.ink3)}>{t.date}</span>
              <span className={cx('min-w-0 flex-1 truncate', tw.ink)}>
                {t.merchant}
              </span>
              <span className={cx(tw.num, t.amount > 0 ? tw.good : tw.ink)}>
                {t.amount > 0 ? '+' : ''}
                {money(t.amount)}
              </span>
            </li>
          ))}
        </ul>
      </Section>
    </>
  );
}
