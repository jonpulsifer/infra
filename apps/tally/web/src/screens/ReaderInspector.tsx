import { type ReactNode, useMemo } from 'react';
import { Kbd, useWidth } from '~/components/bits';
import { type FlowRow, Sparkline } from '~/components/charts';
import {
  Block,
  InspectorHead,
  Keys,
  KV,
  MonthLadder,
  rowRule,
  TxnList,
} from '~/components/ui';
import {
  isIncome,
  isSpend,
  type NetWorthPoint,
  netWorthSeries,
  UNCATEGORIZED,
} from '~/fixtures/derive';
import type { Ledger, Transaction } from '~/fixtures/types';
import { mLong, mShort } from '~/lib/dates';
import type { topResolver } from '~/lib/ledger';
import { money, pct, signedMoney } from '~/lib/money';
import type { Period } from '~/lib/period';
import {
  byMonth,
  categoryRows,
  latestFirst,
  merchantRows,
  NW_PARTS,
  type NwKey,
  provenance,
  rowsMatching,
  ruleFor,
  type Subject,
  totals,
} from '~/lib/reader';
import { cx, groupColor, type Palette, tw } from '~/lib/theme';

type Props = {
  subject: Subject | null;
  pinned: boolean;
  togglePin: () => void;
  ledger: Ledger;
  full: Ledger;
  pal: Palette;
  colors: Record<NwKey, string>;
  period: Period;
  nw: NetWorthPoint[];
  cash: FlowRow[];
  top: ReturnType<typeof topResolver>;
  openFindings: number;
  goImport: () => void;
  openTransactions: (q: { text?: string; categoryId?: string }) => void;
};

export function subjectTitle(
  s: Subject | null,
  ledger: Ledger,
  period: Period,
): string {
  if (!s) return `${period.label} at a glance`;
  switch (s.kind) {
    case 'month':
      return `Net worth, ${mLong(s.month)}`;
    case 'flow':
      return `Cash flow, ${mLong(s.month)}`;
    case 'category':
      return ledger.categories.find((c) => c.id === s.id)?.name ?? s.id;
    case 'source':
      return `${s.merchant}, income`;
    case 'merchant':
      return s.merchant;
    case 'kept':
      return 'What stayed';
  }
}

export function ReaderInspector(props: Props) {
  const { subject } = props;
  return (
    <div className="rf-in">
      {!subject ? <Ticker {...props} /> : null}
      {subject?.kind === 'month' ? (
        <MonthView {...props} month={subject.month} />
      ) : null}
      {subject?.kind === 'category' ? (
        <CategoryView {...props} id={subject.id} />
      ) : null}
      {subject?.kind === 'source' ? (
        <SourceView {...props} merchant={subject.merchant} />
      ) : null}
      {subject?.kind === 'merchant' ? (
        <MerchantView {...props} merchant={subject.merchant} />
      ) : null}
      {subject?.kind === 'flow' ? (
        <FlowMonthView {...props} month={subject.month} />
      ) : null}
      {subject?.kind === 'kept' ? <KeptView {...props} /> : null}
    </div>
  );
}

function useNames(ledger: Ledger) {
  return useMemo(() => {
    const cat = new Map(ledger.categories.map((c) => [c.id, c.name]));
    const acct = new Map(ledger.accounts.map((a) => [a.id, a]));
    return {
      cat: (id: string) => cat.get(id) ?? id,
      acct: (id: string) => {
        const a = acct.get(id);
        return a ? `${a.institution} ${a.name}` : id;
      },
      acctShort: (id: string) => acct.get(id)?.name ?? id,
    };
  }, [ledger]);
}

function Cell({
  label,
  value,
  sub,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
}) {
  return (
    <div className={cx(tw.surface, 'px-4 py-2')}>
      <div className={cx(tw.label, tw.ink3)}>{label}</div>
      <div className={cx('mt-0.5 font-mono text-[15px] tabular-nums', tw.ink)}>
        {value}
      </div>
      {sub ? (
        <div className={cx('truncate text-[11px]', tw.ink3)}>{sub}</div>
      ) : null}
    </div>
  );
}

// Nothing selected: the period's ticker strip -------------------------------

function Ticker({
  ledger,
  full,
  period,
  nw,
  cash,
  openFindings,
  goImport,
  openTransactions,
}: Props) {
  const t = totals(ledger, period.from, period.to);
  const kept = t.income - t.spend;
  const end = nw[nw.length - 1];
  const start = period.priorM
    ? (nw.find((p) => p.month === period.priorM) ?? nw[0])
    : nw[0];
  const unc = ledger.transactions.filter(
    (x) =>
      x.categoryId === UNCATEGORIZED &&
      x.date >= period.from &&
      x.date <= period.to,
  ).length;
  const rows = ledger.transactions.filter(
    (x) => x.date >= period.from && x.date <= period.to,
  ).length;
  const months = cash.filter((r) => period.months.includes(r.month)).reverse();
  return (
    <>
      <InspectorHead
        kicker="Nothing selected"
        title={`${period.label} · ${mLong(period.fromM)} – ${mLong(period.toM)}`}
        sub="Hover anything in the reader to inspect it here."
      />
      <div
        className={cx('grid grid-cols-2 gap-px border-b', tw.ruleBg, tw.rule)}
      >
        <Cell
          label="Net worth"
          value={end ? money(end.total, false) : '—'}
          sub={
            end && start ? (
              <span className={end.total >= start.total ? tw.good : tw.bad}>
                {signedMoney(end.total - start.total, false)}
              </span>
            ) : null
          }
        />
        <Cell
          label="Kept"
          value={signedMoney(kept, false)}
          sub={
            <span className={kept >= 0 ? tw.good : tw.bad}>
              {t.income ? pct(kept / t.income) : '—'} of income
            </span>
          }
        />
        <Cell
          label="Income"
          value={signedMoney(t.income, false)}
          sub={`${period.months.length} mo`}
        />
        <Cell
          label="Spending"
          value={signedMoney(-t.spend, false)}
          sub={`${signedMoney(-t.spend / Math.max(1, period.months.length), false)} / mo`}
        />
        <Cell
          label="Uncategorised"
          value={unc}
          sub={
            unc ? (
              <button
                type="button"
                onClick={() => openTransactions({ categoryId: UNCATEGORIZED })}
                className={cx('hover:underline', tw.accent)}
              >
                Review →
              </button>
            ) : (
              'every row filed'
            )
          }
        />
        <Cell
          label="Rows"
          value={rows.toLocaleString('en-CA')}
          sub={`of ${full.transactions.length.toLocaleString('en-CA')} in the ledger`}
        />
      </div>
      <Block title="Open findings" right="from the pending import">
        <div className="flex items-center gap-3">
          <span
            className={cx(
              'font-mono text-[28px] leading-none tabular-nums',
              openFindings ? tw.warn : tw.good,
            )}
          >
            {openFindings}
          </span>
          <span className={cx('flex-1 text-[12px] leading-4', tw.ink2)}>
            {openFindings
              ? 'duplicates, a missing period, transfer pairs and merchants the rules did not know'
              : 'No import is waiting on a decision.'}
          </span>
          <button
            type="button"
            onClick={goImport}
            className={cx(tw.btn, 'shrink-0')}
          >
            Import <Kbd>g i</Kbd>
          </button>
        </div>
      </Block>
      <Block title="Month by month" right="in · out · net">
        <table className="w-full table-fixed text-[11px]">
          <tbody>
            {months.map((r) => (
              <tr key={r.month} className={cx('border-t', rowRule)}>
                <td className={cx('h-[22px] w-[64px] font-mono', tw.ink2)}>
                  {mShort(r.month)} ’{r.month.slice(2, 4)}
                </td>
                <td className={cx('text-right font-mono', tw.good)}>
                  {signedMoney(r.income, false)}
                </td>
                <td className={cx('text-right font-mono', tw.ink)}>
                  {signedMoney(-r.spend, false)}
                </td>
                <td
                  className={cx(
                    'text-right font-mono',
                    r.net >= 0 ? tw.ink : tw.bad,
                  )}
                >
                  {signedMoney(r.net, false)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Block>
      <Block title="Keys">
        <Keys
          items={[
            ['j k', 'move between sections'],
            ['h l', 'step within a section'],
            ['↵', 'pin what the inspector shows'],
            ['esc', 'unpin, then clear'],
            ['[ ]', 'step the period'],
          ]}
        />
      </Block>
    </>
  );
}

// I. A net-worth month: the composition ladder ------------------------------

function MonthView({
  full,
  pal,
  colors,
  month,
  pinned,
  togglePin,
}: Props & { month: string }) {
  const all = useMemo(() => netWorthSeries(full), [full]);
  const i = all.findIndex((p) => p.month === month);
  const now = all[i];
  const prev = i > 0 ? all[i - 1] : null;
  const src = provenance(full, month);
  if (!now) return null;
  let run = 0;
  const rungs = NW_PARTS.map((p) => {
    const from = run;
    run += now[p.key];
    return { ...p, value: now[p.key], from, to: run };
  });
  const lo = Math.min(0, ...rungs.map((r) => Math.min(r.from, r.to)));
  const hi = Math.max(1, ...rungs.map((r) => Math.max(r.from, r.to)));
  const sx = (v: number) => ((v - lo) / (hi - lo)) * 100;
  const around = all.slice(Math.max(0, i - 4), i + 3);
  return (
    <>
      <InspectorHead
        kicker="Net worth · month end"
        title={mLong(month)}
        figure={money(now.total, false)}
        sub={
          now.estimated
            ? 'Estimated: at least one component carries an older statement forward.'
            : 'Every component comes from a statement in this month.'
        }
        pinned={pinned}
        onPin={togglePin}
      />
      <Block
        title="Composition ladder"
        right={prev ? `Δ vs ${mShort(prev.month)}` : ''}
      >
        <table className="w-full table-fixed text-[12px]">
          <tbody>
            {rungs.map((r) => {
              const d = prev ? now[r.key] - prev[r.key] : null;
              const s = src[r.key];
              return (
                <tr key={r.key} className={cx('border-t', rowRule)}>
                  <td className="py-1.5 pr-2">
                    <span className="flex items-center gap-1.5">
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-[2px]"
                        style={{ background: colors[r.key] }}
                      />
                      <span className={cx('truncate', tw.ink)}>{r.label}</span>
                    </span>
                    <span
                      className={cx(
                        'block truncate pl-4 font-mono text-[10px]',
                        tw.ink3,
                      )}
                    >
                      {s.date ? `${s.date} · ${s.note}` : s.note}
                    </span>
                  </td>
                  <td className="w-[104px] pr-2">
                    <div className="relative h-3">
                      <div
                        className="absolute top-1/2 h-px w-full -translate-y-1/2"
                        style={{ background: pal.grid }}
                      />
                      <div
                        className="absolute inset-y-0 rounded-[2px]"
                        style={{
                          left: `${sx(Math.min(r.from, r.to))}%`,
                          width: `${Math.max(0.8, Math.abs(sx(r.to) - sx(r.from)))}%`,
                          background: colors[r.key],
                        }}
                      />
                      <div
                        className="absolute -top-0.5 -bottom-0.5 w-px"
                        style={{ left: `${sx(0)}%`, background: pal.axis }}
                      />
                    </div>
                  </td>
                  <td
                    className={cx(
                      'w-[88px] text-right font-mono tabular-nums',
                      tw.ink,
                    )}
                  >
                    {money(r.value, false)}
                  </td>
                  <td
                    className={cx(
                      'w-[70px] text-right font-mono text-[11px] tabular-nums',
                      d == null || Math.abs(d) < 1
                        ? tw.ink3
                        : d > 0
                          ? tw.good
                          : tw.bad,
                    )}
                  >
                    {d == null || Math.abs(d) < 1 ? '—' : signedMoney(d, false)}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className={cx('border-t-2', tw.rule)}>
              <td className={cx('py-1.5 font-medium', tw.ink)}>Net worth</td>
              <td />
              <td
                className={cx(
                  'text-right font-mono font-semibold tabular-nums',
                  tw.ink,
                )}
              >
                {money(now.total, false)}
              </td>
              <td
                className={cx(
                  'text-right font-mono text-[11px] tabular-nums',
                  prev && now.total >= prev.total ? tw.good : tw.bad,
                )}
              >
                {prev ? signedMoney(now.total - prev.total, false) : ''}
              </td>
            </tr>
          </tfoot>
        </table>
        <p className={cx('mt-2 text-[11px] leading-4', tw.ink3)}>
          Each bar starts where the rung above ended, so the last one lands on
          net worth. The mortgage steps back toward zero.
        </p>
      </Block>
      <Block title="Around it">
        <table className="w-full table-fixed text-[11px]">
          <tbody>
            {around.map((p) => {
              const before = all[all.indexOf(p) - 1];
              const d = before ? p.total - before.total : null;
              return (
                <tr
                  key={p.month}
                  className={cx(
                    'border-t',
                    rowRule,
                    p.month === month && tw.selected,
                  )}
                >
                  <td
                    className={cx('h-[22px] w-[72px] pl-1 font-mono', tw.ink2)}
                  >
                    {mShort(p.month)} ’{p.month.slice(2, 4)}
                  </td>
                  <td className={cx('text-[10px]', tw.ink3)}>
                    {p.estimated ? 'carried' : 'stated'}
                  </td>
                  <td className={cx('text-right font-mono', tw.ink)}>
                    {money(p.total, false)}
                  </td>
                  <td
                    className={cx(
                      'w-[80px] pr-1 text-right font-mono',
                      d == null ? tw.ink3 : d >= 0 ? tw.good : tw.bad,
                    )}
                  >
                    {d == null ? '—' : signedMoney(d, false)}
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

// II/III. A category, group or leaf ------------------------------------------

function CategoryView({
  ledger,
  pal,
  period,
  top,
  id,
  pinned,
  togglePin,
  openTransactions,
}: Props & { id: string }) {
  const names = useNames(ledger);
  const cat = ledger.categories.find((c) => c.id === id);
  const isGroup = !cat?.parentId;
  const group = top(id);
  const color = groupColor(pal, group.id);
  const rows = useMemo(
    () => latestFirst(categoryRows(ledger, id, period.from, period.to, top)),
    [ledger, id, period, top],
  );
  const windowRows = useMemo(
    () => categoryRows(ledger, id, `${period.window[0]}-01`, period.to, top),
    [ledger, id, period, top],
  );
  const total = -rows.reduce((s, t) => s + t.amount, 0);
  const spend = totals(ledger, period.from, period.to).spend;
  const leaves = useMemo(() => {
    if (!isGroup) return [];
    const m = new Map<string, number>();
    for (const t of rows)
      m.set(t.categoryId, (m.get(t.categoryId) ?? 0) - t.amount);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [rows, isGroup]);
  const merchants = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of rows)
      m.set(t.merchant, (m.get(t.merchant) ?? 0) - t.amount);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  }, [rows]);
  return (
    <>
      <InspectorHead
        kicker={
          <span className="inline-flex items-center gap-1.5">
            <span
              className="h-2 w-2 rounded-full"
              style={{ background: color }}
            />
            {isGroup ? 'Category group' : `Category · ${group.name}`}
          </span>
        }
        title={cat?.name ?? id}
        figure={signedMoney(-total, false)}
        sub={`${rows.length} rows · ${spend ? pct(total / spend, 1) : '—'} of spending · ${period.label}`}
        pinned={pinned}
        onPin={togglePin}
      />
      {leaves.length > 1 ? (
        <Block title={`Inside ${cat?.name}`}>
          <Bars
            rows={leaves.map(([k, v]) => ({ label: names.cat(k), value: -v }))}
            color={color}
          />
        </Block>
      ) : null}
      <Block title="Month by month" right={`${period.window.length} months`}>
        <MonthLadder
          rows={byMonth(windowRows, period.window, 1)}
          inPeriod={new Set(period.months)}
          color={color}
          pal={pal}
        />
      </Block>
      {merchants.length ? (
        <Block title="Where it was spent">
          <Bars
            rows={merchants.map(([k, v]) => ({ label: k, value: -v }))}
            color={color}
          />
        </Block>
      ) : null}
      <Block title="Rows" right="latest first">
        <TxnList
          rows={rows}
          catName={names.cat}
          acctName={names.acctShort}
          showCategory={isGroup}
          onOpen={() => openTransactions({ categoryId: id })}
        />
      </Block>
    </>
  );
}

function Bars({
  rows,
  color,
}: {
  rows: { label: string; value: number }[];
  color: string;
}) {
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.value)));
  return (
    <table className="w-full table-fixed text-[11px]">
      <tbody>
        {rows.map((r) => (
          <tr key={r.label} className={cx('border-t', rowRule)}>
            <td className={cx('h-[22px] w-[132px] truncate pr-2', tw.ink)}>
              {r.label}
            </td>
            <td className="pr-3">
              <div
                className="h-[7px] rounded-r-[2px]"
                style={{
                  width: `${(Math.abs(r.value) / max) * 100}%`,
                  background: color,
                }}
              />
            </td>
            <td className={cx('w-[80px] text-right font-mono', tw.ink)}>
              {signedMoney(r.value, false)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// II. An income source ---------------------------------------------------------

function SourceView({
  ledger,
  pal,
  period,
  merchant,
  pinned,
  togglePin,
}: Props & { merchant: string }) {
  const names = useNames(ledger);
  const rows = latestFirst(
    merchantRows(ledger, merchant, period.from, period.to, true),
  );
  const windowRows = merchantRows(
    ledger,
    merchant,
    `${period.window[0]}-01`,
    period.to,
    true,
  );
  const total = rows.reduce((s, t) => s + t.amount, 0);
  const income = totals(ledger, period.from, period.to).income;
  return (
    <>
      <InspectorHead
        kicker="Income source"
        title={merchant}
        figure={signedMoney(total, false)}
        sub={`${rows.length} deposits · ${income ? pct(total / income, 1) : '—'} of income · ${period.label}`}
        pinned={pinned}
        onPin={togglePin}
      />
      <Block title="Month by month">
        <MonthLadder
          rows={byMonth(windowRows, period.window, 1)}
          inPeriod={new Set(period.months)}
          color={pal.income}
          pal={pal}
        />
      </Block>
      <Block title="Deposits" right="latest first">
        <TxnList rows={rows} acctName={names.acctShort} />
      </Block>
    </>
  );
}

// IV. A merchant: its rows, its trend, the rule that files it ------------------

function MerchantView({
  ledger,
  pal,
  period,
  top,
  merchant,
  pinned,
  togglePin,
  openTransactions,
}: Props & { merchant: string }) {
  const names = useNames(ledger);
  const [ref, width] = useWidth<HTMLDivElement>();
  const rows = latestFirst(
    merchantRows(ledger, merchant, period.from, period.to),
  );
  const windowRows = merchantRows(
    ledger,
    merchant,
    `${period.window[0]}-01`,
    period.to,
  );
  const ever = ledger.transactions.filter((t) => t.merchant === merchant);
  const latest = rows[0] ?? latestFirst(ever)[0];
  const total = -rows.reduce((s, t) => s + t.amount, 0);
  const series = byMonth(windowRows, period.window);
  const peak = series.reduce((a, b) => (b.value > a.value ? b : a), series[0]);
  const rule = latest ? ruleFor(ledger, latest) : null;
  const ruleHits = rule ? rowsMatching(ledger, rule).length : 0;
  const cats = new Map<string, number>();
  for (const t of ever)
    cats.set(t.categoryId, (cats.get(t.categoryId) ?? 0) + 1);
  const group = latest ? top(latest.categoryId) : null;
  return (
    <>
      <InspectorHead
        kicker={
          latest ? (
            <span className="inline-flex items-center gap-1.5">
              <span
                className="h-2 w-2 rounded-full"
                style={{ background: groupColor(pal, group?.id ?? '') }}
              />
              Merchant · {names.cat(latest.categoryId)}
            </span>
          ) : (
            'Merchant'
          )
        }
        title={merchant}
        figure={signedMoney(-total, false)}
        sub={`${rows.length} charges · avg ${signedMoney(-total / Math.max(1, rows.length))} · ${ever.length} on record`}
        pinned={pinned}
        onPin={togglePin}
      />
      <Block
        title="Twelve-month trend"
        right={
          peak?.value
            ? `peak ${mShort(peak.month)} ${signedMoney(-peak.value, false)}`
            : ''
        }
      >
        <div ref={ref}>
          <Sparkline
            values={series.map((s) => s.value)}
            width={width}
            height={40}
            color={groupColor(pal, group?.id ?? '')}
            fill
          />
        </div>
        <div
          className={cx(
            'mt-1 flex justify-between font-mono text-[10px]',
            tw.ink3,
          )}
        >
          <span>{mLong(period.window[0])}</span>
          <span>{mLong(period.window[period.window.length - 1])}</span>
        </div>
      </Block>
      <Block title="Filed by">
        {rule ? (
          <div className="space-y-1.5 text-[12px]">
            <div className={tw.ink2}>
              Descriptor contains{' '}
              <code
                className={cx(
                  'rounded-[2px] px-1 font-mono text-[11px]',
                  tw.wash,
                  tw.ink,
                )}
              >
                {rule.match}
              </code>{' '}
              → <span className={tw.ink}>{names.cat(rule.categoryId)}</span>
            </div>
            <KV
              rows={[
                [
                  'Origin',
                  rule.createdFrom === 'seed' ? 'seed rule' : 'a correction',
                ],
                ['Matches', `${ruleHits} rows in the ledger`],
                [
                  'Latest row',
                  latest ? (
                    <span key="v" className="font-mono text-[11px]">
                      {latest.descriptor}
                    </span>
                  ) : (
                    '—'
                  ),
                ],
              ]}
            />
          </div>
        ) : latest ? (
          <p className={cx('text-[12px]', tw.ink2)}>
            No rule matches{' '}
            <code className={cx('font-mono text-[11px]', tw.ink)}>
              {latest.descriptor}
            </code>
            .{' '}
            {latest.source === 'model'
              ? `The model filed the latest row at ${pct(latest.confidence ?? 0)}.`
              : 'The latest row was filed by hand.'}
          </p>
        ) : null}
        {cats.size > 1 ? (
          <p className={cx('mt-2 text-[11px]', tw.warn)}>
            Filed under {cats.size} categories:{' '}
            {[...cats.entries()]
              .map(([k, v]) => `${names.cat(k)} ${v}`)
              .join(' · ')}
          </p>
        ) : null}
      </Block>
      <Block title="Rows" right={period.label}>
        <TxnList
          rows={rows}
          acctName={names.acctShort}
          onOpen={() => openTransactions({ text: merchant })}
        />
      </Block>
    </>
  );
}

// V. A cash-flow month ---------------------------------------------------------

function FlowMonthView({
  ledger,
  pal,
  top,
  month,
  pinned,
  togglePin,
}: Props & { month: string }) {
  const names = useNames(ledger);
  const inMonth = ledger.transactions.filter(
    (t) => t.date.startsWith(month) && !t.transferId,
  );
  const spend = inMonth.filter((t) => isSpend(t, ledger));
  const income = inMonth.filter((t) => isIncome(t, ledger));
  const out = -spend.reduce((s, t) => s + t.amount, 0);
  const inn = income.reduce((s, t) => s + t.amount, 0);
  const net = inn - out;
  const groupsOf = (rows: Transaction[], key: (t: Transaction) => string) => {
    const m = new Map<string, number>();
    for (const t of rows)
      m.set(key(t), (m.get(key(t)) ?? 0) + Math.abs(t.amount));
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };
  const byGroup = groupsOf(spend, (t) => top(t.categoryId).id);
  const bySource = groupsOf(income, (t) => t.merchant);
  const largest = [...spend].sort((a, b) => a.amount - b.amount).slice(0, 8);
  const max = Math.max(1, ...byGroup.map((g) => g[1]));
  return (
    <>
      <InspectorHead
        kicker="Cash flow · month"
        title={mLong(month)}
        figure={signedMoney(net, false)}
        sub={`${inMonth.length} rows, transfers left out`}
        pinned={pinned}
        onPin={togglePin}
      />
      <div
        className={cx('grid grid-cols-3 gap-px border-b', tw.ruleBg, tw.rule)}
      >
        <Cell label="In" value={signedMoney(inn, false)} />
        <Cell label="Out" value={signedMoney(-out, false)} />
        <Cell
          label="Kept"
          value={inn ? pct(net / inn) : '—'}
          sub={<span className={net >= 0 ? tw.good : tw.bad}>of income</span>}
        />
      </div>
      <Block title="Where it went">
        <table className="w-full table-fixed text-[11px]">
          <tbody>
            {byGroup.map(([g, v]) => (
              <tr key={g} className={cx('border-t', rowRule)}>
                <td className={cx('h-[22px] w-[120px] truncate', tw.ink)}>
                  <span className="inline-flex items-center gap-1.5">
                    <span
                      className="h-2 w-2 rounded-[2px]"
                      style={{ background: groupColor(pal, g) }}
                    />
                    {names.cat(g)}
                  </span>
                </td>
                <td className="pr-3">
                  <div
                    className="h-[7px] rounded-r-[2px]"
                    style={{
                      width: `${(v / max) * 100}%`,
                      background: groupColor(pal, g),
                    }}
                  />
                </td>
                <td className={cx('w-[60px] text-right font-mono', tw.ink3)}>
                  {out ? pct(v / out) : ''}
                </td>
                <td className={cx('w-[80px] text-right font-mono', tw.ink)}>
                  {signedMoney(-v, false)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Block>
      {bySource.length ? (
        <Block title="Came in">
          <table className="w-full table-fixed text-[11px]">
            <tbody>
              {bySource.map(([s, v]) => (
                <tr key={s} className={cx('border-t', rowRule)}>
                  <td className={cx('h-[22px] truncate', tw.ink)}>{s}</td>
                  <td className={cx('w-[90px] text-right font-mono', tw.good)}>
                    {signedMoney(v, false)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Block>
      ) : null}
      <Block title="Largest rows">
        <TxnList rows={largest} acctName={names.acctShort} />
      </Block>
    </>
  );
}

// II. What stayed, month by month ---------------------------------------------

function KeptView({ ledger, period, cash, pinned, togglePin }: Props) {
  const rows = cash.filter((r) => period.months.includes(r.month));
  const t = totals(ledger, period.from, period.to);
  const kept = t.income - t.spend;
  return (
    <>
      <InspectorHead
        kicker="Income less spending"
        title={kept >= 0 ? 'What stayed' : 'Drawn from savings'}
        figure={signedMoney(kept, false)}
        sub={`${t.income ? pct(kept / t.income, 1) : '—'} of income · ${period.label}`}
        pinned={pinned}
        onPin={togglePin}
      />
      <Block title="Month by month">
        <table className="w-full table-fixed text-[11px]">
          <thead>
            <tr className={cx(tw.label, tw.ink3)}>
              <th className="w-[60px] pb-1 text-left font-medium">Month</th>
              <th className="pb-1 text-right font-medium">In</th>
              <th className="pb-1 text-right font-medium">Out</th>
              <th className="pb-1 text-right font-medium">Net</th>
              <th className="w-[52px] pb-1 text-right font-medium">Rate</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.month} className={cx('border-t', rowRule)}>
                <td className={cx('h-[22px] font-mono', tw.ink2)}>
                  {mShort(r.month)} ’{r.month.slice(2, 4)}
                </td>
                <td className={cx('text-right font-mono', tw.good)}>
                  {signedMoney(r.income, false)}
                </td>
                <td className={cx('text-right font-mono', tw.ink)}>
                  {signedMoney(-r.spend, false)}
                </td>
                <td
                  className={cx(
                    'text-right font-mono',
                    r.net >= 0 ? tw.ink : tw.bad,
                  )}
                >
                  {signedMoney(r.net, false)}
                </td>
                <td className={cx('text-right font-mono', tw.ink3)}>
                  {r.income ? pct(r.net / r.income) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Block>
      <p
        className={cx('flex items-center gap-1 px-4 py-3 text-[11px]', tw.ink3)}
      >
        Transfers to savings and investments count as staying.
      </p>
    </>
  );
}
