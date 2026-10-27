import { Check, CornerDownLeft } from 'lucide-react';
import { type ReactNode, useCallback, useMemo, useState } from 'react';
import {
  cashFlow,
  monthKey,
  monthlySpendByCategory,
  netWorthSeries,
  type SankeyData,
  sankey,
  topMerchants,
} from '~/fixtures/derive';
import type { Ledger } from '~/fixtures/types';
import { Empty, Panel, Swatch } from './bits';
import {
  CashFlowPair,
  mLong,
  NetWorthChart,
  type NWRow,
  SankeyChart,
  Sparkline,
  type SpendRow,
  SpendStack,
} from './charts';
import { topResolver } from './model';
import type { Period } from './period';
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

const COMPS = [
  { key: 'cash', label: 'Cash & credit' },
  { key: 'investments', label: 'Investments' },
  { key: 'house', label: 'House' },
  { key: 'mortgage', label: 'Mortgage' },
] as const;

type CompKey = (typeof COMPS)[number]['key'];

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
  const [included, setIncluded] = useState<CompKey[]>([
    'cash',
    'investments',
    'house',
    'mortgage',
  ]);
  const top = useMemo(
    () => topResolver(ledger.categories),
    [ledger.categories],
  );
  const q = query.trim().toLowerCase();

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

  const w0 = period.window[0];
  const w1 = period.window[period.window.length - 1];
  const inPeriod = useMemo(() => new Set(period.months), [period.months]);

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
  const visible = CAT_ORDER.filter((k) => !hidden.includes(k));
  const merchants = useMemo(() => {
    const vis = new Set<string>(visible);
    const l = {
      ...scoped,
      transactions: scoped.transactions.filter((t) =>
        vis.has(top(t.categoryId).id),
      ),
    };
    return topMerchants(l, { from: period.from, to: period.to, limit: 12 });
  }, [scoped, period.from, period.to, hidden.join()]);

  const periodTotals = useMemo(() => {
    const out: Record<string, number> = {};
    for (const r of spend.rows) {
      if (!inPeriod.has(r.month)) continue;
      for (const k of spend.keys)
        out[k] = (out[k] ?? 0) + Number((r as any)[k] ?? 0);
    }
    return out;
  }, [spend, inPeriod]);
  const spendTotal = visible.reduce((s, k) => s + (periodTotals[k] ?? 0), 0);
  const allSpend = CAT_ORDER.reduce((s, k) => s + (periodTotals[k] ?? 0), 0);

  const flowP = flow.filter((r) => inPeriod.has(r.month));
  const income = flowP.reduce((s, r) => s + r.income, 0);
  const out = flowP.reduce((s, r) => s + r.spend, 0);
  const net = income - out;

  const nwRows: NWRow[] = nwAll
    .filter((p) => period.window.includes(p.month))
    .map((p) => ({
      ...p,
      total: included.reduce((s, k) => s + p[k], 0),
    }));
  const nwEnd =
    nwAll.find((p) => p.month === period.toM) ?? nwAll[nwAll.length - 1];
  const nwStart = period.priorM
    ? nwAll.find((p) => p.month === period.priorM)
    : nwAll[0];
  const sum = (p: (typeof nwAll)[number] | undefined) =>
    p ? included.reduce((s, k) => s + p[k], 0) : 0;
  const nwDelta = sum(nwEnd) - sum(nwStart);

  const uncategorised = scoped.transactions.filter(
    (t) =>
      t.categoryId === 'uncategorized' &&
      t.date >= period.from &&
      t.date <= period.to,
  ).length;

  const colorFor = useCallback(
    (id: string) => {
      if (id === 'leaf:saved') return pal.income;
      if (id === 'all') return pal.ink2;
      if (id.startsWith('src:')) return pal.ink3;
      const cid = id.replace(/^(grp|leaf):/, '');
      return pal.cat[top(cid).id] ?? pal.spend;
    },
    [pal, top],
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

  const topTotal = merchants[0]?.total ?? 0;

  return (
    <div
      className={cx('grid grid-cols-12 gap-px border-b', tw.ruleBg, tw.rule)}
    >
      <div
        className={cx(
          'col-span-12 grid grid-cols-2 gap-px md:grid-cols-6',
          tw.ruleBg,
        )}
      >
        <Stat
          label="Net worth"
          value={money(sum(nwEnd), false)}
          sub={
            <span className={nwDelta >= 0 ? tw.good : tw.bad}>
              {signedMoney(nwDelta, false)}{' '}
              {period.key === 'all'
                ? 'since start'
                : `in ${period.label.toLowerCase()}`}
            </span>
          }
        />
        <Stat
          label="Income"
          value={money(income, false)}
          sub={`${flowP.length} mo · ${period.label}`}
        />
        <Stat
          label="Spend"
          value={money(-out, false)}
          sub={flowP.length ? `${money(-out / flowP.length, false)} / mo` : '—'}
        />
        <Stat
          label="Saved"
          value={money(net, false)}
          sub={
            <span className={net >= 0 ? tw.good : tw.bad}>
              {income ? pct(net / income) : '—'} savings rate
            </span>
          }
        />
        <Stat
          label="Uncategorised"
          value={String(uncategorised)}
          sub={
            uncategorised ? (
              <button
                type="button"
                onClick={() =>
                  openTransactions({ categoryId: 'uncategorized' })
                }
                className={cx(
                  'inline-flex items-center gap-1 hover:underline',
                  tw.accent,
                )}
              >
                Review <CornerDownLeft size={10} />
              </button>
            ) : (
              'All rows have a category'
            )
          }
        />
        <Stat
          label="Scope"
          value={period.label}
          sub={
            q ? (
              <>matching “{query.trim()}”</>
            ) : (
              `${mLong(period.fromM)} – ${mLong(period.toM)}`
            )
          }
        />
      </div>

      <Panel
        className="col-span-12 xl:col-span-7"
        title="Net worth"
        meta={
          <>
            {money(sum(nwEnd), false)}{' '}
            <span className={nwDelta >= 0 ? tw.good : tw.bad}>
              {signedMoney(nwDelta, false)}
            </span>
          </>
        }
        right={
          <span className={cx('text-[10px]', tw.ink3)}>
            {q ? 'Balances ignore search · ' : ''}
            {included.length === 4
              ? 'All components'
              : `${included.length} of 4 components`}
          </span>
        }
      >
        <div className="flex gap-3">
          <div className="min-w-0 flex-1">
            <NetWorthChart
              rows={nwRows}
              comps={COMPS.map((c) => ({ key: c.key, label: c.label }))}
              included={included}
              period={{
                fromM: period.fromM,
                toM: period.toM,
                whole: period.window.length === period.months.length,
              }}
              pal={pal}
            />
          </div>
          <div className={cx('w-[212px] shrink-0 border-l pl-3', tw.rule)}>
            <div className={cx(tw.label, tw.ink3, 'mb-1 flex justify-between')}>
              <span>Composition</span>
              <span>{mLong(nwEnd.month)}</span>
            </div>
            {COMPS.map((c) => {
              const on = included.includes(c.key);
              return (
                <button
                  type="button"
                  key={c.key}
                  aria-pressed={on}
                  onClick={() =>
                    setIncluded((xs) =>
                      on
                        ? xs.length > 1
                          ? xs.filter((x) => x !== c.key)
                          : xs
                        : [...xs, c.key],
                    )
                  }
                  className={cx(
                    'group grid w-full grid-cols-[14px_1fr_56px] items-center gap-x-2 rounded-[3px] px-1 py-[5px] text-left',
                    tw.hover,
                    !on && 'opacity-45',
                  )}
                >
                  <span
                    className={cx(
                      'flex h-3 w-3 items-center justify-center rounded-[2px] border',
                      on
                        ? 'border-[#0b0b0b] bg-[#0b0b0b] text-[#fcfcfb] dark:border-[#f0efec] dark:bg-[#f0efec] dark:text-[#141413]'
                        : tw.rule,
                    )}
                  >
                    {on ? <Check size={9} strokeWidth={3} /> : null}
                  </span>
                  <span className="min-w-0">
                    <span className={cx('block truncate text-[12px]', tw.ink)}>
                      {c.label}
                    </span>
                    <span className={cx('block text-[11px]', tw.ink2, tw.num)}>
                      {money(nwEnd[c.key], false)}
                    </span>
                  </span>
                  <Sparkline
                    values={nwRows.map((r) => Number(r[c.key]))}
                    width={56}
                    height={22}
                    color={pal.ink2}
                  />
                </button>
              );
            })}
          </div>
        </div>
      </Panel>

      <Panel
        className="col-span-12 xl:col-span-5"
        title="Cash flow"
        meta={
          <>
            in {kmoney(income)} · out {kmoney(out)} · net{' '}
            <span className={net >= 0 ? tw.good : tw.bad}>{kmoney(net)}</span>
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
        <CashFlowPair
          rows={flow}
          window={period.window}
          inPeriod={inPeriod}
          pal={pal}
        />
      </Panel>

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
              />
            ) : (
              <Empty>No spend matches this slice.</Empty>
            )}
          </div>
          <div className={cx('w-[228px] shrink-0 border-l pl-3', tw.rule)}>
            <div
              className={cx(
                tw.label,
                tw.ink3,
                'mb-1 grid grid-cols-[1fr_52px_30px] gap-x-2',
              )}
            >
              <span>Category</span>
              <span className="text-right">Total</span>
              <span className="text-right">%</span>
            </div>
            {CAT_ORDER.map((k) => {
              const off = hidden.includes(k);
              const v = periodTotals[k] ?? 0;
              return (
                <button
                  type="button"
                  key={k}
                  aria-pressed={!off}
                  onClick={(e) => toggleCat(k, e.altKey || e.metaKey)}
                  onDoubleClick={() => toggleCat(k, true)}
                  title="Click to hide · double-click to show only this"
                  className={cx(
                    'grid w-full grid-cols-[1fr_52px_30px] items-center gap-x-2 rounded-[3px] px-1 py-[5px] text-left text-[12px]',
                    tw.hover,
                    off && 'opacity-45',
                  )}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <Swatch color={pal.cat[k]} off={off} />
                    <span
                      className={cx('truncate', tw.ink, off && 'line-through')}
                    >
                      {spend.names[k] ??
                        ledger.categories.find((c) => c.id === k)?.name}
                    </span>
                  </span>
                  <span className={cx('text-right', tw.num, tw.ink)}>
                    {kmoney(v)}
                  </span>
                  <span className={cx('text-right', tw.num, tw.ink3)}>
                    {allSpend ? pct(v / allSpend) : '—'}
                  </span>
                </button>
              );
            })}
            <p className={cx('mt-2 px-1 text-[10px] leading-4', tw.ink3)}>
              Click hides a category here and in merchants. Double-click shows
              only that one.
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
                <th className="w-8 py-1 text-right font-medium">n</th>
                <th className="w-[76px] py-1 text-right font-medium">Total</th>
                <th className="w-[30%] py-1 pl-3 text-left font-medium">
                  Share
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
                    <td className={cx('py-[3px]', tw.num, tw.ink3)}>{i + 1}</td>
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
                    <td className={cx('py-[3px] text-right', tw.num, tw.ink3)}>
                      {m.count}
                    </td>
                    <td className={cx('py-[3px] text-right', tw.num, tw.ink)}>
                      {money(-m.total, false)}
                    </td>
                    <td className="py-[3px] pl-3">
                      <div className="flex items-center gap-2">
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
                            'w-8 text-right text-[10px]',
                            tw.num,
                            tw.ink3,
                          )}
                        >
                          {spendTotal ? pct(m.total / spendTotal) : ''}
                        </span>
                      </div>
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
        title="Where it went"
        meta={
          <>
            {mLong(monthKey(period.from))} – {mLong(period.toM)} · income →
            groups → categories {scopeNote}
          </>
        }
        right={
          <span className={cx('text-[10px]', tw.ink3)}>
            Hover a flow for its share of income
          </span>
        }
      >
        <SankeyChart data={sk} pal={pal} colorFor={colorFor} />
      </Panel>
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

function Stat({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub: ReactNode;
}) {
  return (
    <div className={cx(tw.surface, 'px-3 py-2')}>
      <div className={cx(tw.label, tw.ink3)}>{label}</div>
      <div className={cx('mt-0.5 font-mono text-[17px] leading-6', tw.ink)}>
        {value}
      </div>
      <div className={cx('truncate text-[11px]', tw.ink3)}>{sub}</div>
    </div>
  );
}
