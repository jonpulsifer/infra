import { CornerDownLeft } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  cashFlow,
  monthlySpendByCategory,
  months,
  netWorthSeries,
  type SankeyData,
  sankey,
  topMerchants,
} from '~/fixtures/derive';
import type { Ledger } from '~/fixtures/types';
import { Delta, Empty, Panel, Swatch } from './bits';
import {
  CashFlowPair,
  mLong,
  mShort,
  type SpendRow,
  SpendStack,
} from './charts';
import {
  COMPS,
  CompositionChart,
  carryNote,
  HeroBand,
  type HeroStat,
  Ticker,
} from './hero';
import { momFor, spendIn, topResolver } from './model';
import type { Period } from './period';
import { FlowSankey } from './sankey';
import {
  CAT_ORDER,
  cx,
  kmoney,
  money,
  type Palette,
  pct,
  signedMoney,
  tw,
} from './theme';

const DRIVER: Record<(typeof COMPS)[number]['key'], string> = {
  house: 'the house',
  investments: 'investments',
  cash: 'cash',
  mortgage: 'the mortgage',
};

function phrase(period: Period, first: string) {
  switch (period.key) {
    case 'month':
      return 'This month';
    case 'last3':
      return 'Over the last three months';
    case 'ytd':
      return 'Year to date';
    case 'y2025':
      return 'In 2025';
    default:
      return `Since ${mLong(first)}`;
  }
}

export function Dashboard({
  ledger,
  pal,
  period,
  query,
  openTransactions,
}: {
  ledger: Ledger;
  pal: Palette;
  period: Period;
  query: string;
  openTransactions: (q: { text?: string; categoryId?: string }) => void;
}) {
  const [hidden, setHidden] = useState<string[]>([]);
  const [ticker, setTicker] = useState(false);
  const heroEnd = useRef<HTMLDivElement>(null);
  const top = useMemo(
    () => topResolver(ledger.categories),
    [ledger.categories],
  );
  const q = query.trim().toLowerCase();

  useEffect(() => {
    const el = heroEnd.current;
    const root = el?.closest('main') ?? null;
    if (!el) return;
    const io = new IntersectionObserver(
      ([e]) => {
        const rootTop = e.rootBounds?.top ?? 0;
        setTicker(!e.isIntersecting && e.boundingClientRect.top < rootTop + 40);
      },
      { root, threshold: 0 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const scoped = useMemo<Ledger>(() => {
    if (!q) return ledger;
    return {
      ...ledger,
      transactions: ledger.transactions.filter(
        (t) =>
          t.descriptor.toLowerCase().includes(q) ||
          t.merchant.toLowerCase().includes(q),
      ),
    };
  }, [ledger, q]);

  const first = useMemo(() => months(ledger)[0], [ledger]);
  const w0 = period.window[0];
  const w1 = period.window[period.window.length - 1];
  const inPeriod = useMemo(() => new Set(period.months), [period.months]);
  const mom = useMemo(() => momFor(period, ledger.asOf), [period, ledger.asOf]);

  const spend = useMemo(
    () => monthlySpendByCategory(scoped, { from: w0, to: w1 }),
    [scoped, w0, w1],
  );
  const flow = useMemo(
    () => cashFlow(scoped, { from: w0, to: w1 }),
    [scoped, w0, w1],
  );
  const nwAll = useMemo(() => netWorthSeries(ledger), [ledger]);
  const sk = useMemo(
    () => withDrawdown(sankey(scoped, { from: period.from, to: period.to })),
    [scoped, period.from, period.to],
  );
  const catMoM = useMemo(() => {
    const k = (t: { categoryId: string }) => top(t.categoryId).id;
    return {
      cur: spendIn(scoped, mom.cur, k),
      prev: spendIn(scoped, mom.prev, k),
    };
  }, [scoped, mom, top]);

  const visible = CAT_ORDER.filter((k) => !hidden.includes(k));
  const merchants = useMemo(() => {
    const vis = new Set<string>(CAT_ORDER.filter((k) => !hidden.includes(k)));
    const l = {
      ...scoped,
      transactions: scoped.transactions.filter((t) =>
        vis.has(top(t.categoryId).id),
      ),
    };
    const rows = topMerchants(l, {
      from: period.from,
      to: period.to,
      limit: 12,
    });
    const names = new Set(rows.map((r) => r.merchant));
    const only = {
      ...l,
      transactions: l.transactions.filter((t) => names.has(t.merchant)),
    };
    const cur = spendIn(only, mom.cur, (t) => t.merchant);
    const prev = spendIn(only, mom.prev, (t) => t.merchant);
    return rows.map((r) => ({
      ...r,
      delta: (cur.get(r.merchant) ?? 0) - (prev.get(r.merchant) ?? 0),
      inMonth: cur.get(r.merchant) ?? 0,
    }));
  }, [scoped, period.from, period.to, hidden, mom, top]);

  const periodTotals = useMemo(() => {
    const out: Record<string, number> = {};
    for (const r of spend.rows) {
      if (!inPeriod.has(r.month)) continue;
      for (const k of spend.keys)
        out[k] = (out[k] ?? 0) + Number((r as Record<string, unknown>)[k] ?? 0);
    }
    return out;
  }, [spend, inPeriod]);
  const spendTotal = visible.reduce((s, k) => s + (periodTotals[k] ?? 0), 0);
  const allSpend = CAT_ORDER.reduce((s, k) => s + (periodTotals[k] ?? 0), 0);

  const flowP = flow.filter((r) => inPeriod.has(r.month));
  const income = flowP.reduce((s, r) => s + r.income, 0);
  const out = flowP.reduce((s, r) => s + r.spend, 0);
  const net = income - out;

  const nwRows = nwAll.filter((p) => period.window.includes(p.month));
  const nwEnd =
    nwAll.find((p) => p.month === period.toM) ?? nwAll[nwAll.length - 1];
  const nwStart =
    (period.priorM && nwAll.find((p) => p.month === period.priorM)) || nwAll[0];
  const nwDelta = nwEnd.total - nwStart.total;
  const nwPct = nwStart.total ? nwDelta / Math.abs(nwStart.total) : 0;
  const driver = [...COMPS].sort(
    (a, b) =>
      Math.abs(nwEnd[b.key] - nwStart[b.key]) -
      Math.abs(nwEnd[a.key] - nwStart[a.key]),
  )[0];
  const driverDelta = nwEnd[driver.key] - nwStart[driver.key];

  const uncategorised = scoped.transactions.filter(
    (t) =>
      t.categoryId === 'uncategorized' &&
      t.date >= period.from &&
      t.date <= period.to,
  ).length;

  const names = (k: string) =>
    spend.names[k] ?? ledger.categories.find((c) => c.id === k)?.name ?? k;
  const mover = CAT_ORDER.map((k) => ({
    k,
    d: (catMoM.cur.get(k) ?? 0) - (catMoM.prev.get(k) ?? 0),
  })).sort((a, b) => Math.abs(b.d) - Math.abs(a.d))[0];

  const ph = phrase(period, first);
  const lineOne = (
    <>
      {signedMoney(nwDelta, false)} since {mLong(nwStart.month)},{' '}
      {nwPct >= 0 ? 'up' : 'down'} {pct(Math.abs(nwPct), 1)};{' '}
      {DRIVER[driver.key]} moved most, at {signedMoney(driverDelta, false)}.
    </>
  );
  const lineTwo = (
    <>
      {income > 0
        ? net >= 0
          ? `${ph} you kept ${money(net, false)} of ${money(income, false)} income (${pct(net / income)})`
          : `${ph} spending ran ${money(-net, false)} ahead of income`
        : `${ph} no income landed`}
      {mover && Math.abs(mover.d) >= 1
        ? `; ${mShort(period.toM)} ${names(mover.k).toLowerCase()} is ${mover.d > 0 ? 'up' : 'down'} ${kmoney(Math.abs(mover.d))} on ${mShort(mom.prev.from.slice(0, 7))}.`
        : '.'}
    </>
  );

  const stats: HeroStat[] = [
    {
      label: 'Income',
      value: money(income, false),
      sub: `${flowP.length} mo · ${period.label}`,
    },
    {
      label: 'Spend',
      value: money(-out, false),
      sub: flowP.length ? `${money(-out / flowP.length, false)} / mo` : '—',
    },
    {
      label: 'Saved',
      value: money(net, false),
      sub: (
        <span className={net >= 0 ? tw.good : tw.bad}>
          {income ? pct(net / income) : '—'} rate
        </span>
      ),
    },
    {
      label: 'Uncategorised',
      value: String(uncategorised),
      sub: uncategorised ? (
        <button
          type="button"
          onClick={() => openTransactions({ categoryId: 'uncategorized' })}
          className={cx(
            'inline-flex items-center gap-1 hover:underline',
            tw.accent,
          )}
        >
          Review <CornerDownLeft size={10} />
        </button>
      ) : (
        'All rows have one'
      ),
    },
  ];

  const colorFor = useCallback(
    (id: string) => {
      if (id === 'leaf:saved') return pal.income;
      if (id === 'src:drawdown') return pal.bad;
      if (id === 'all') return pal.ink2;
      if (id.startsWith('src:')) return pal.ink3;
      return pal.cat[top(id.replace(/^(grp|leaf):/, '')).id] ?? pal.spend;
    },
    [pal, top],
  );
  const groupOf = useCallback(
    (id: string) =>
      id.startsWith('src:') || id === 'all' || id === 'leaf:saved'
        ? id
        : top(id.replace(/^(grp|leaf):/, '')).id,
    [top],
  );

  const toggleCat = (k: string, solo: boolean) => {
    if (solo) {
      setHidden(CAT_ORDER.filter((c) => c !== k));
      return;
    }
    setHidden((h) => (h.includes(k) ? h.filter((x) => x !== k) : [...h, k]));
  };

  const scopeNote = q ? (
    <span className={cx('rounded-[2px] px-1', tw.wash, tw.ink2)}>
      “{query.trim()}”
    </span>
  ) : null;
  const saved = sk.links.find((l) => l.target === 'leaf:saved')?.value ?? 0;
  const drawn = sk.links.find((l) => l.source === 'src:drawdown')?.value ?? 0;
  const topTotal = merchants[0]?.total ?? 0;
  const note = nwEnd.estimated ? carryNote(ledger, nwEnd.month) : '';
  const recent = [...flowP].reverse().slice(0, 6);

  return (
    <div className="pb-16">
      <Ticker
        shown={ticker}
        figure={money(nwEnd.total, false)}
        estimated={nwEnd.estimated}
        delta={
          <span className={nwDelta >= 0 ? tw.good : tw.bad}>
            {signedMoney(nwDelta, false)}
          </span>
        }
        stats={stats.slice(0, 3)}
        spark={nwRows.map((r) => r.total)}
        pal={pal}
        onTop={() =>
          heroEnd.current
            ?.closest('main')
            ?.scrollTo({ top: 0, behavior: 'smooth' })
        }
      />

      <HeroBand
        kicker={
          <>
            Net worth · {mLong(nwEnd.month)} month end
            {q ? ' · balances ignore search' : ''}
          </>
        }
        figure={money(nwEnd.total, false)}
        estimated={nwEnd.estimated}
        lines={[lineOne, lineTwo]}
        stats={stats}
        chart={
          <CompositionChart
            points={nwRows}
            period={{
              fromM: period.fromM,
              toM: period.toM,
              whole: period.window.length === period.months.length,
            }}
            pal={pal}
          />
        }
        footnote={
          <>
            {nwEnd.estimated ? (
              <>
                † Estimated: {note || 'a component carries forward'}. Hollow
                points carry at least one component forward; filled points come
                from statements in that month.
              </>
            ) : (
              'Every component of this month comes from a statement in it. Hollow points elsewhere carry one forward.'
            )}
            {period.window.length !== period.months.length
              ? ' The shaded band is the selected period.'
              : ''}
          </>
        }
      />
      <div ref={heroEnd} aria-hidden className="h-px" />

      <section className={cx('border-y', tw.rule, tw.surface)}>
        <header className="flex flex-wrap items-baseline gap-x-5 gap-y-1 px-5 pt-5 pb-1">
          <h2 className={cx(tw.serif, 'text-[24px] leading-tight', tw.ink)}>
            Where the money went,{' '}
            <span className={cx('italic', tw.ink3)}>
              {ph.charAt(0).toLowerCase() + ph.slice(1)}
            </span>
          </h2>
          <p className={cx('text-[13px]', tw.ink2)}>
            {saved > 0 ? (
              <>
                Every dollar in, followed to where it landed. The green ribbon
                is what stayed:{' '}
                <span className={cx(tw.num, tw.ink)}>
                  {money(saved, false)}
                </span>
                .
              </>
            ) : drawn > 0 ? (
              <>
                Spending outran income by{' '}
                <span className={cx(tw.num, tw.ink)}>
                  {money(drawn, false)}
                </span>
                , drawn from savings on the left.
              </>
            ) : (
              'Every dollar in, followed to where it landed.'
            )}{' '}
            {scopeNote}
          </p>
          <span className={cx('ml-auto text-[10px]', tw.ink3)}>
            Hover a ribbon to follow it alone · transfers are left out
          </span>
        </header>
        <div className="px-2 pb-4">
          <FlowSankey
            data={sk}
            pal={pal}
            colorFor={colorFor}
            groupOf={groupOf}
          />
        </div>
      </section>

      <div
        className={cx('grid grid-cols-12 gap-px border-b', tw.ruleBg, tw.rule)}
      >
        <Panel
          className="col-span-12 xl:col-span-7"
          title="Spend by category"
          meta={
            <>
              {money(spendTotal, false)}
              {hidden.length ? ` of ${money(allSpend, false)}` : ''} {scopeNote}
            </>
          }
          right={
            hidden.length ? (
              <button
                type="button"
                onClick={() => setHidden([])}
                className={cx('text-[11px] hover:underline', tw.accent)}
              >
                Show all
              </button>
            ) : null
          }
        >
          <div className="flex gap-3">
            <div className="min-w-0 flex-1">
              {spend.rows.length ? (
                <SpendStack
                  rows={spend.rows as SpendRow[]}
                  visible={visible}
                  names={spend.names}
                  window={period.window}
                  inPeriod={inPeriod}
                  pal={pal}
                  height={208}
                />
              ) : (
                <Empty>No spend matches this slice.</Empty>
              )}
            </div>
            <div className={cx('w-[288px] shrink-0 border-l pl-3', tw.rule)}>
              <div
                className={cx(
                  tw.label,
                  tw.ink3,
                  'mb-1 grid grid-cols-[1fr_50px_28px_52px] gap-x-2 px-1',
                )}
              >
                <span>Category</span>
                <span className="text-right">Total</span>
                <span className="text-right">%</span>
                <span className="text-right" title={mom.note}>
                  {mom.head}
                </span>
              </div>
              {CAT_ORDER.map((k) => {
                const off = hidden.includes(k);
                const v = periodTotals[k] ?? 0;
                const d = (catMoM.cur.get(k) ?? 0) - (catMoM.prev.get(k) ?? 0);
                return (
                  <button
                    type="button"
                    key={k}
                    aria-pressed={!off}
                    onClick={(e) => toggleCat(k, e.altKey || e.metaKey)}
                    onDoubleClick={() => toggleCat(k, true)}
                    title="Click to hide · double-click to show only this"
                    className={cx(
                      'grid w-full grid-cols-[1fr_50px_28px_52px] items-center gap-x-2 rounded-[3px] px-1 py-[5px] text-left text-[12px]',
                      tw.hover,
                      off && 'opacity-45',
                    )}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <Swatch color={pal.cat[k]} off={off} />
                      <span
                        className={cx(
                          'truncate',
                          tw.ink,
                          off && 'line-through',
                        )}
                      >
                        {names(k)}
                      </span>
                    </span>
                    <span className={cx('text-right', tw.num, tw.ink)}>
                      {kmoney(v)}
                    </span>
                    <span className={cx('text-right', tw.num, tw.ink3)}>
                      {allSpend ? pct(v / allSpend) : '—'}
                    </span>
                    <span className="text-right">
                      <Delta value={d} title={mom.note} />
                    </span>
                  </button>
                );
              })}
              <p className={cx('mt-2 px-1 text-[10px] leading-4', tw.ink3)}>
                Click hides a category here and in merchants; double-click shows
                only it. {mom.head} is {mom.note}.
              </p>
            </div>
          </div>
        </Panel>

        <Panel
          className="col-span-12 xl:col-span-5"
          title="Top merchants"
          meta={
            <>
              {period.label}
              {hidden.length
                ? ` · ${visible.length} of ${CAT_ORDER.length} categories`
                : ''}
            </>
          }
        >
          {merchants.length ? (
            <table className="w-full table-fixed text-[12px]">
              <thead>
                <tr className={cx(tw.label, tw.ink3)}>
                  <th className="w-6 py-1 text-left font-medium">#</th>
                  <th className="py-1 text-left font-medium">Merchant</th>
                  <th className="w-7 py-1 text-right font-medium">n</th>
                  <th className="w-[72px] py-1 text-right font-medium">
                    Total
                  </th>
                  <th className="w-[24%] py-1 pl-3 text-left font-medium">
                    Share
                  </th>
                  <th
                    className="w-[54px] py-1 text-right font-medium"
                    title={mom.note}
                  >
                    {mom.head}
                  </th>
                </tr>
              </thead>
              <tbody>
                {merchants.map((m, i) => {
                  const cat = top(m.categoryId).id;
                  return (
                    <tr
                      key={m.merchant}
                      onClick={() => openTransactions({ text: m.merchant })}
                      className={cx(
                        'group cursor-pointer border-t',
                        tw.rule,
                        tw.hover,
                      )}
                    >
                      <td className={cx('py-[3px]', tw.num, tw.ink3)}>
                        {i + 1}
                      </td>
                      <td className="truncate py-[3px]">
                        <span className={tw.ink}>{m.merchant}</span>
                        <span
                          className={cx(
                            'ml-2 text-[11px] opacity-0 transition-opacity group-hover:opacity-100',
                            tw.accent,
                          )}
                        >
                          open ↵
                        </span>
                      </td>
                      <td
                        className={cx('py-[3px] text-right', tw.num, tw.ink3)}
                      >
                        {m.count}
                      </td>
                      <td className={cx('py-[3px] text-right', tw.num, tw.ink)}>
                        {money(-m.total, false)}
                      </td>
                      <td className="py-[3px] pl-3">
                        <div className="flex items-center gap-1.5">
                          <div className="h-2 flex-1">
                            <div
                              className="h-2 rounded-r-[2px] transition-[width] duration-200"
                              style={{
                                width: `${(m.total / topTotal) * 100}%`,
                                background: pal.cat[cat],
                              }}
                            />
                          </div>
                          <span
                            className={cx(
                              'w-7 text-right text-[10px]',
                              tw.num,
                              tw.ink3,
                            )}
                          >
                            {spendTotal ? pct(m.total / spendTotal) : ''}
                          </span>
                        </div>
                      </td>
                      <td className="py-[3px] text-right">
                        <Delta
                          value={m.delta}
                          title={`${money(-m.inMonth, false)} in ${mom.note}`}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <Empty>No merchants in this slice.</Empty>
          )}
        </Panel>

        <Panel
          className="col-span-12"
          title="Cash flow"
          meta={
            <>
              in {kmoney(income)} · out {kmoney(out)} · net{' '}
              <span className={net >= 0 ? tw.good : tw.bad}>{kmoney(net)}</span>{' '}
              {scopeNote}
            </>
          }
          right={
            <div className={cx('flex items-center gap-3 text-[10px]', tw.ink3)}>
              <span className="flex items-center gap-1">
                <Swatch color={pal.income} /> Income
              </span>
              <span className="flex items-center gap-1">
                <Swatch color={pal.spend} /> Spend
              </span>
              <span className="flex items-center gap-1">
                <Swatch color={pal.ink} shape="dot" /> Net
              </span>
            </div>
          }
        >
          <div className="flex gap-3">
            <div className="min-w-0 flex-1">
              <CashFlowPair
                rows={flow}
                window={period.window}
                inPeriod={inPeriod}
                pal={pal}
                height={200}
              />
            </div>
            <div
              className={cx(
                'hidden w-[340px] shrink-0 self-start border-l pl-1 lg:block',
                tw.rule,
              )}
            >
              <table className="w-full text-[12px]">
                <thead>
                  <tr className={cx(tw.label, tw.ink3)}>
                    <th className="py-1 pl-3 text-left font-medium">Month</th>
                    <th className="py-1 text-right font-medium">In</th>
                    <th className="py-1 text-right font-medium">Out</th>
                    <th className="py-1 text-right font-medium">Net</th>
                    <th className="py-1 text-right font-medium">Rate</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((r) => (
                    <tr key={r.month} className={cx('border-t', tw.rule)}>
                      <td className={cx('py-[3px] pl-3', tw.ink2)}>
                        {mLong(r.month)}
                      </td>
                      <td className={cx('py-[3px] text-right', tw.num, tw.ink)}>
                        {kmoney(r.income)}
                      </td>
                      <td className={cx('py-[3px] text-right', tw.num, tw.ink)}>
                        {kmoney(-r.spend)}
                      </td>
                      <td
                        className={cx(
                          'py-[3px] text-right',
                          tw.num,
                          r.net >= 0 ? tw.good : tw.bad,
                        )}
                      >
                        {kmoney(r.net)}
                      </td>
                      <td
                        className={cx('py-[3px] text-right', tw.num, tw.ink3)}
                      >
                        {r.income ? pct(r.net / r.income) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </Panel>
      </div>
    </div>
  );
}

/** When spend beats income, show the gap as money drawn from savings. */
function withDrawdown(d: SankeyData): SankeyData {
  const sum = (pred: (l: SankeyData['links'][number]) => boolean) =>
    d.links.filter(pred).reduce((s, l) => s + l.value, 0);
  const inflow = sum((l) => l.target === 'all');
  const outflow = sum((l) => l.source === 'all');
  if (outflow - inflow < 1) return d;
  return {
    nodes: [
      ...d.nodes,
      { id: 'src:drawdown', name: 'From savings', kind: 'source' },
    ],
    links: [
      ...d.links,
      { source: 'src:drawdown', target: 'all', value: outflow - inflow },
    ],
  };
}
