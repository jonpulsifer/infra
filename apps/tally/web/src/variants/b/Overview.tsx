import { ArrowRight } from 'lucide-react';
import { useMemo } from 'react';
import { monthLabel } from '~/fixtures/derive';
import type { Ledger } from '~/fixtures/types';
import {
  CategoryPill,
  Delta,
  Figures,
  Kicker,
  LegendItem,
  SectionHead,
} from './bits';
import { CashFlowChart, NetWorthChart } from './charts';
import {
  brief,
  cashFlowWindow,
  estimateNote,
  flow,
  longDate,
  merchantList,
  money,
  monthYear,
  netWorthWindow,
  type Period,
  rankCategories,
  signed,
} from './model';
import { SankeyFlow } from './Sankey';
import { groupColor } from './theme';

export function Overview({
  ledger,
  period,
  onReviewUncategorised,
}: {
  ledger: Ledger;
  period: Period;
  onReviewUncategorised: () => void;
}) {
  const nw = useMemo(() => netWorthWindow(ledger, period), [ledger, period]);
  const f = useMemo(() => flow(ledger, period), [ledger, period]);
  const story = useMemo(() => brief(ledger, period), [ledger, period]);
  const ranked = useMemo(
    () => rankCategories(ledger, period),
    [ledger, period],
  );
  const merchants = useMemo(
    () => merchantList(ledger, period),
    [ledger, period],
  );
  const cash = useMemo(() => cashFlowWindow(ledger, period), [ledger, period]);

  const latest = nw[nw.length - 1];
  const first = nw[0];
  const change = latest && first ? latest.total - first.total : 0;
  const changePct = first?.total ? (change / Math.abs(first.total)) * 100 : 0;
  const note = estimateNote(ledger);
  const partialMonth = period.partial ? ledger.asOf.slice(0, 7) : undefined;

  return (
    <div className="vb-in">
      {/* Hero ------------------------------------------------------------ */}
      <section className="mx-auto max-w-[1240px] px-5 pt-14 sm:px-10 sm:pt-20">
        <Kicker>Net worth · {longDate(ledger.asOf)}</Kicker>
        <div className="mt-4 flex flex-wrap items-end gap-x-10 gap-y-4">
          <div className="text-[64px] leading-none font-light tracking-[-0.035em] text-(--ink) sm:text-[104px]">
            {latest ? money(latest.total) : '—'}
            {latest?.estimated ? (
              <sup className="ml-1 align-super text-[0.32em] font-normal text-(--muted)">
                †
              </sup>
            ) : null}
          </div>
          {first ? (
            <p className="max-w-sm pb-3 text-[17px] leading-snug text-(--ink2)">
              <span className="font-semibold text-(--ink)">
                {signed(change)}
              </span>{' '}
              since {monthYear(first.month)}, {changePct >= 0 ? 'up' : 'down'}{' '}
              {Math.abs(changePct).toFixed(1)}%. The house carries most of it;
              the mortgage is the long shadow beneath.
            </p>
          ) : null}
        </div>
      </section>
      <section className="mt-10 px-3 sm:px-6">
        <NetWorthChart points={nw} />
        <div className="mx-auto max-w-[1240px] px-2 sm:px-4">
          <p className="mt-4 max-w-3xl text-[13px] leading-relaxed text-(--muted)">
            † Estimated. Filled points are months where every component comes
            from a statement in that month; hollow points carry at least one
            forward
            {note ? ` (today ${note.replace(/\.$/, '')})` : ''}.
          </p>
          <Figures
            rows={nw.slice(-12).map((p) => ({
              k: monthLabel(p.month) + (p.estimated ? ' †' : ''),
              v: money(p.total),
            }))}
          />
        </div>
      </section>

      {/* Sankey ---------------------------------------------------------- */}
      <section className="mt-28 border-t border-(--hair) pt-20">
        <div className="mx-auto max-w-[1240px] px-5 sm:px-10">
          <SectionHead
            numeral="I."
            kicker="The flow"
            title={
              <>
                Where the money went,{' '}
                <span className="text-(--muted) italic">
                  {period.key === 'month'
                    ? period.title
                    : period.title.toLowerCase()}
                </span>
              </>
            }
            dek={
              f.saved > 0 ? (
                <>
                  Every dollar that came in, followed to where it landed. The
                  green ribbon is what stayed:{' '}
                  <span className="font-semibold text-(--ink)">
                    {money(f.saved)}
                  </span>
                  .
                </>
              ) : (
                <>
                  Every dollar that came in, followed to where it landed.
                  Spending outran income by{' '}
                  <span className="font-semibold text-(--ink)">
                    {money(f.spent - f.income)}
                  </span>
                  , drawn from savings on the left.
                </>
              )
            }
          />
        </div>
        <div className="px-3 sm:px-6">
          {f.links.length ? (
            <SankeyFlow nodes={f.nodes} links={f.links} income={f.income} />
          ) : (
            <p className="mx-auto max-w-[1240px] px-5 text-(--muted)">
              Nothing moved in this period.
            </p>
          )}
        </div>
        <p className="serif mx-auto mt-6 max-w-[1240px] px-5 text-[15px] text-(--muted) italic sm:px-10">
          Hover a ribbon to follow it alone. Transfers between your own accounts
          are left out; they are neither income nor spending.
        </p>
      </section>

      {/* Brief + categories --------------------------------------------- */}
      <section className="mt-28 border-t border-(--hair) pt-20">
        <div className="mx-auto grid max-w-[1240px] gap-16 px-5 sm:px-10 lg:grid-cols-[1fr_1.05fr] lg:gap-20">
          <div>
            <Kicker>
              <span className="serif mr-2 normal-case">II.</span>In brief
            </Kicker>
            <h2 className="serif mt-3 text-[34px] leading-[1.1] text-(--ink) sm:text-[42px]">
              {period.title.replace(/,.*$/, '')}, in a paragraph
            </h2>
            <p className="dropcap serif mt-8 text-[21px] leading-[1.6] text-pretty text-(--ink)">
              {story.sentences.join(' ')}
            </p>
            {story.pull ? (
              <figure className="mt-10 border-l-2 border-(--ink) pl-6">
                <div className="text-[56px] leading-none font-light tracking-[-0.03em] text-(--ink)">
                  {story.pull.value}
                </div>
                <figcaption className="mt-2 text-[14px] text-(--muted)">
                  {story.pull.caption}
                </figcaption>
              </figure>
            ) : null}
            {story.uncategorised ? (
              <button
                type="button"
                onClick={onReviewUncategorised}
                className="group mt-10 inline-flex items-center gap-2 rounded-full bg-(--sunk) px-4 py-2 text-[14px] text-(--ink) ring-1 ring-(--hair) transition hover:bg-(--wash) hover:ring-(--axis)"
              >
                {story.uncategorised} transaction
                {story.uncategorised === 1 ? ' is' : 's are'} still
                uncategorised
                <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
              </button>
            ) : null}
          </div>
          <div>
            <div className="flex items-baseline justify-between gap-4">
              <h3 className="serif text-[24px] text-(--ink)">
                Spending by category
              </h3>
              {ranked.priorLabel ? (
                <span className="text-[12px] text-(--muted)">
                  {ranked.priorLabel}
                </span>
              ) : null}
            </div>
            <RankedBars rows={ranked.rows} compare={!!ranked.compare} />
          </div>
        </div>
      </section>

      {/* Merchants ------------------------------------------------------- */}
      <section className="mt-28 border-t border-(--hair) pt-20">
        <div className="mx-auto max-w-[1240px] px-5 sm:px-10">
          <SectionHead
            numeral="III."
            kicker="The usual suspects"
            title="Top merchants"
            dek={`Ranked by what was spent with them, ${period.key === 'month' ? `in ${period.title}` : period.title.toLowerCase()}.`}
          />
          {merchants.length ? (
            <ol className="grid gap-x-16 lg:grid-cols-2">
              {merchants.map((mm, i) => (
                <li
                  key={mm.merchant}
                  className="group grid grid-cols-[3rem_1fr_auto] items-baseline gap-x-4 border-t border-(--hair) py-5"
                >
                  <span className="serif text-[28px] leading-none text-(--muted) tabular-nums transition-colors group-hover:text-(--ink)">
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="serif truncate text-[21px] text-(--ink)">
                        {mm.merchant}
                      </span>
                      <CategoryPill
                        name={mm.categoryName}
                        groupId={mm.groupId}
                      />
                    </div>
                    <div className="mt-3 h-[3px] w-full rounded-full bg-(--sunk)">
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${(mm.total / merchants[0].total) * 100}%`,
                          background: groupColor(mm.groupId),
                        }}
                      />
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="num text-[17px] font-semibold text-(--ink)">
                      {money(mm.total)}
                    </div>
                    <div className="text-[12px] text-(--muted)">
                      {mm.count} {mm.count === 1 ? 'charge' : 'charges'}
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-(--muted)">No spending in this period.</p>
          )}
        </div>
      </section>

      {/* Cash flow ------------------------------------------------------- */}
      <section className="mt-28 border-t border-(--hair) pt-20 pb-32">
        <div className="mx-auto max-w-[1240px] px-5 sm:px-10">
          <SectionHead
            numeral="IV."
            kicker="In and out"
            title="Cash flow, month by month"
            dek="What came in beside what went out. The line is the difference; below zero, the month leaned on savings."
          />
          <div className="mb-4 flex flex-wrap gap-x-6 gap-y-2">
            <LegendItem color="var(--s1)" label="Income" />
            <LegendItem color="var(--s2)" label="Spending" />
            <LegendItem color="var(--ink)" label="Net" mark="line" />
          </div>
        </div>
        <div className="mx-auto max-w-[1300px] px-3 sm:px-8">
          <CashFlowChart rows={cash} partialMonth={partialMonth} />
        </div>
        <div className="mx-auto max-w-[1240px] px-5 sm:px-10">
          {partialMonth ? (
            <p className="mt-3 text-[13px] text-(--muted)">
              * {monthLabel(partialMonth)} runs to the {ledger.asOf.slice(8)}th.
            </p>
          ) : null}
          <Figures
            rows={cash.slice(-12).map((r) => ({
              k: monthLabel(r.month),
              v: `${money(r.income)} / ${money(r.spend)}`,
            }))}
            label="Read the figures (income / spending)"
          />
        </div>
      </section>
    </div>
  );
}

function RankedBars({
  rows,
  compare,
}: {
  rows: ReturnType<typeof rankCategories>['rows'];
  compare: boolean;
}) {
  const max = Math.max(1, ...rows.map((r) => r.amount));
  if (!rows.length)
    return <p className="mt-6 text-(--muted)">No spending in this period.</p>;
  return (
    <ul className="mt-6">
      {rows.map((r) => (
        <li
          key={r.id}
          className="group grid grid-cols-[minmax(0,9.5rem)_1fr_auto] items-center gap-x-4 rounded-lg py-2.5 transition-colors hover:bg-(--wash) sm:-mx-3 sm:px-3"
        >
          <span className="flex min-w-0 items-center gap-2 text-[14px] text-(--ink)">
            <span
              className="size-2 shrink-0 rounded-full"
              style={{ background: groupColor(r.groupId) }}
            />
            <span className="truncate">{r.name}</span>
          </span>
          <span className="relative h-3.5">
            <span
              className="absolute inset-y-0 left-0 rounded-r-[4px] transition-[width] duration-500"
              style={{
                width: `${Math.max(0.6, (r.amount / max) * 100)}%`,
                background: groupColor(r.groupId),
                opacity: r.id === 'other' ? 0.5 : 1,
              }}
            />
          </span>
          <span className="flex w-[8.5rem] items-baseline justify-end gap-3">
            <span className="num text-[14px] font-semibold text-(--ink)">
              {money(r.amount)}
            </span>
            {compare ? (
              <span className="w-[4.2rem] text-right">
                <Delta value={r.amount - r.prior} />
              </span>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  );
}
