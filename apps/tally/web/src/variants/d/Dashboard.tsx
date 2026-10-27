import { Check, CornerDownLeft } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import {
  cashFlow,
  monthKey,
  monthlySpendByCategory,
  months,
  netWorthSeries,
  type SankeyData,
  sankey,
  topMerchants,
} from '~/fixtures/derive';
import type { Ledger } from '~/fixtures/types';
import { estimateNote } from '~/variants/b/model';
import { Empty, Panel, Stat, Swatch } from './bits';
import {
  CashFlowPair,
  mLong,
  NetWorthLine,
  type NWRow,
  SankeyChart,
  type SpendRow,
  SpendStack,
} from './charts';
import { type Period, topResolver } from './model';
import {
  aggregator,
  baselineFor,
  brief,
  cashFlowFinding,
  merchantFinding,
  netWorthFinding,
  pulls,
  spendFinding,
  subjectFor,
} from './prose';
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
  const firstM = useMemo(() => months(ledger)[0], [ledger]);

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
    return topMerchants(
      {
        ...scoped,
        transactions: scoped.transactions.filter((t) =>
          vis.has(top(t.categoryId).id),
        ),
      },
      { from: period.from, to: period.to, limit: 12 },
    );
  }, [scoped, period.from, period.to, hidden.join()]);

  // The written layer ---------------------------------------------------------
  const agg = useMemo(() => aggregator(scoped), [scoped]);
  const baseline = useMemo(
    () => baselineFor(period, `${firstM}-01`),
    [period, firstM],
  );
  const cur = useMemo(
    () => agg({ from: period.from, to: period.to }),
    [agg, period.from, period.to],
  );
  const bases = useMemo(
    () => baseline?.windows.map(agg) ?? [],
    [agg, baseline],
  );
  const subject = q
    ? `Spending on “${query.trim()}”`
    : subjectFor(period, ledger.asOf, firstM);
  const sentences = useMemo(
    () =>
      brief({
        ledger: scoped,
        cur,
        bases,
        baseline,
        subject,
        months: period.months.length,
      }),
    [scoped, cur, bases, baseline, subject, period.months.length],
  );
  const figures = useMemo(
    () => pulls(cur, bases, baseline),
    [cur, bases, baseline],
  );

  const periodTotals = useMemo(() => {
    const out: Record<string, number> = {};
    for (const r of spend.rows) {
      if (!inPeriod.has(r.month)) continue;
      for (const k of spend.keys)
        out[k] = (out[k] ?? 0) + Number((r as SpendRow)[k] ?? 0);
    }
    return out;
  }, [spend, inPeriod]);
  const spendTotal = visible.reduce((s, k) => s + (periodTotals[k] ?? 0), 0);
  const allSpend = CAT_ORDER.reduce((s, k) => s + (periodTotals[k] ?? 0), 0);

  const flowP = flow.filter((r) => inPeriod.has(r.month));
  const income = flowP.reduce((s, r) => s + r.income, 0);
  const out = flowP.reduce((s, r) => s + r.spend, 0);
  const net = income - out;
  const asOfDay = Number(ledger.asOf.slice(8, 10));
  const [ay, am] = ledger.asOf.split('-').map(Number);
  const partial =
    period.toM === monthKey(ledger.asOf) &&
    asOfDay < new Date(Date.UTC(ay, am, 0)).getUTCDate();

  const nwRows: NWRow[] = nwAll
    .filter((p) => period.window.includes(p.month))
    .map((p) => ({ ...p, total: included.reduce((s, k) => s + p[k], 0) }));
  const nwEnd =
    nwAll.find((p) => p.month === period.toM) ?? nwAll[nwAll.length - 1];
  const nwStart = period.priorM
    ? nwAll.find((p) => p.month === period.priorM)
    : nwAll[0];
  const sum = (p: (typeof nwAll)[number] | undefined) =>
    p ? included.reduce((s, k) => s + p[k], 0) : 0;
  const nwDelta = sum(nwEnd) - sum(nwStart);
  const anyEstimate = nwRows.some((r) => r.estimated);
  const note = estimateNote(ledger);

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
  const span = `${mLong(period.fromM)} – ${mLong(period.toM)}`;

  return (
    <div
      className={cx('grid grid-cols-12 gap-px border-b', tw.ruleBg, tw.rule)}
    >
      <div
        className={cx(
          'col-span-12 grid grid-cols-2 gap-px md:grid-cols-3 xl:grid-cols-6',
          tw.ruleBg,
        )}
      >
        <Stat
          label="Net worth"
          value={money(sum(nwEnd), false)}
          mark={nwEnd.estimated ? '†' : undefined}
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
          sub={q ? <>matching “{query.trim()}”</> : span}
        />
      </div>

      <Panel
        className="col-span-12 md:col-span-4 xl:col-span-3"
        title="Brief"
        meta={q ? scopeNote : span}
        foot={
          uncategorised ? (
            <button
              type="button"
              onClick={() => openTransactions({ categoryId: 'uncategorized' })}
              className={cx('text-left hover:underline', tw.accent)}
            >
              {uncategorised} {uncategorised === 1 ? 'row is' : 'rows are'}{' '}
              still uncategorised; the brief counts them as spend. Review ↵
            </button>
          ) : (
            'Written from the ledger each time it changes.'
          )
        }
      >
        <p
          className={cx(
            'dw-prose dw-drop max-w-[46ch] pt-1 text-[15px] leading-[22px] text-pretty hyphens-auto',
            tw.ink,
          )}
        >
          {sentences.map((s, i) => (
            <span key={i}>
              {i ? ' ' : ''}
              {s}
            </span>
          ))}
        </p>
        {figures.length ? (
          <div
            className={cx(
              'mt-3 grid grid-cols-2 gap-3 border-t pt-2.5',
              tw.rule,
            )}
          >
            {figures.map((f) => (
              <figure
                key={f.caption}
                className={cx('border-l-2 pl-2.5', tw.rule)}
              >
                <div
                  className={cx(
                    'dw-serif text-[26px] leading-7',
                    f.tone === 'good' ? tw.good : tw.bad,
                  )}
                >
                  {f.value}
                </div>
                <figcaption className={cx('text-[11px] leading-4', tw.ink3)}>
                  {f.caption}
                </figcaption>
              </figure>
            ))}
          </div>
        ) : null}
      </Panel>

      <Panel
        className="col-span-12 md:col-span-8 xl:col-span-5"
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
        finding={netWorthFinding({
          start: nwStart,
          end: nwEnd,
          included,
          since: nwStart?.month ?? period.fromM,
        })}
        foot={
          anyEstimate ? (
            <>
              <span className={tw.ink2}>†</span> Estimated: a hollow point
              carries an older statement forward.
              {note ? ` Now the ${note}` : ''}
            </>
          ) : null
        }
      >
        <NetWorthLine
          rows={nwRows}
          comps={COMPS.map((c) => ({ key: c.key, label: c.label }))}
          included={included}
          period={{
            fromM: period.fromM,
            toM: period.toM,
            whole: period.window.length === period.months.length,
          }}
          pal={pal}
          height={172}
        />
        <div
          className={cx('mt-2 grid grid-cols-2 gap-px sm:grid-cols-4')}
          role="group"
          aria-label="Net worth components"
        >
          {COMPS.map((c) => {
            const on = included.includes(c.key);
            const d =
              nwEnd && nwStart ? nwEnd[c.key] - (nwStart[c.key] ?? 0) : 0;
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
                  'grid min-w-0 grid-cols-[12px_minmax(0,1fr)_auto] items-center gap-x-1.5 gap-y-px rounded-[3px] px-1 py-1 text-left whitespace-nowrap',
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
                <span
                  className={cx('col-span-2 truncate text-[11px]', tw.ink2)}
                >
                  {c.label}
                </span>
                <span />
                <span className="col-span-2 flex min-w-0 items-baseline gap-1.5 overflow-hidden">
                  <span className={cx('shrink-0 text-[11px]', tw.num, tw.ink)}>
                    {kmoney(nwEnd[c.key])}
                  </span>
                  <span
                    className={cx(
                      'ml-auto min-w-0 truncate text-[10px]',
                      tw.num,
                      Math.abs(d) < 1 ? tw.ink3 : d > 0 ? tw.good : tw.bad,
                    )}
                  >
                    {Math.abs(d) < 1
                      ? '±0'
                      : `${d > 0 ? '+' : '−'}${kmoney(Math.abs(d))}`}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </Panel>

      <Panel
        className="col-span-12 xl:col-span-4"
        title="Cash flow"
        meta={
          <>
            in {kmoney(income)} · out {kmoney(out)} · net{' '}
            <span className={net >= 0 ? tw.good : tw.bad}>{kmoney(net)}</span>
          </>
        }
        finding={cashFlowFinding(flowP, partial)}
      >
        <CashFlowPair
          rows={flow}
          window={period.window}
          inPeriod={inPeriod}
          pal={pal}
          height={212}
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
        finding={spendFinding({
          ledger: scoped,
          cur,
          bases,
          baseline,
          visible: new Set(visible),
        })}
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
          <div className={cx('w-[212px] shrink-0 border-l pl-3', tw.rule)}>
            <div
              className={cx(
                tw.label,
                tw.ink3,
                'mb-1 grid grid-cols-[1fr_52px_30px] gap-x-2',
              )}
            >
              <span>Filter</span>
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
                    'grid w-full grid-cols-[1fr_52px_30px] items-center gap-x-2 rounded-[3px] px-1 py-[4px] text-left text-[12px]',
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
              Click hides a category here, in merchants and in the sentence
              above. Double-click shows only that one.
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
        finding={merchantFinding({ merchants, spendTotal, bases })}
      >
        {merchants.length ? (
          <table className="w-full table-fixed text-[12px]">
            <thead>
              <tr className={cx(tw.label, tw.ink3)}>
                <th className="w-6 py-1 text-left font-medium">#</th>
                <th className="py-1 text-left font-medium">Merchant</th>
                <th className="w-8 py-1 text-right font-medium">n</th>
                <th className="w-[76px] py-1 text-right font-medium">Total</th>
                <th className="w-[34%] py-1 pl-3 text-left font-medium">
                  Share of spend
                </th>
              </tr>
            </thead>
            <tbody>
              {merchants.map((m, i) => {
                const cat = top(m.categoryId).id;
                const w = topTotal ? m.total / topTotal : 0;
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
                      <div className="flex items-center">
                        <div
                          className="h-2 shrink-0 rounded-r-[2px] transition-[width] duration-200"
                          style={{
                            width: `calc((100% - 34px) * ${w})`,
                            background: pal.cat[cat],
                          }}
                        />
                        <span
                          className={cx(
                            'pl-1.5 text-[10px]',
                            tw.num,
                            i === 0 ? tw.ink2 : tw.ink3,
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
            {span} · income → groups → categories {scopeNote}
          </>
        }
        right={
          <span className={cx('text-[10px]', tw.ink3)}>
            Transfers between your own accounts are left out
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
