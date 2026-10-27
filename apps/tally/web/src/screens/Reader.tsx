import { ArrowRight } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CashColumns,
  type FlowRow,
  NetWorthStack,
  SankeyFlow,
} from '~/components/charts';
import { Split } from '~/components/Split';
import { Kicker, rowRule, SectionHead, serif } from '~/components/ui';
import {
  cashFlow,
  monthKey,
  type NetWorthPoint,
  UNCATEGORIZED,
} from '~/fixtures/derive';
import type { Ledger } from '~/fixtures/types';
import { longDate, mLong, ordinal } from '~/lib/dates';
import { isTyping } from '~/lib/keys';
import { topResolver } from '~/lib/ledger';
import { magnitude, money, pct, signedMoney } from '~/lib/money';
import type { Period } from '~/lib/period';
import {
  brief,
  flow,
  merchantList,
  NW_PARTS,
  netWorthWindow,
  periodPhrase,
  rankCategories,
  type Subject,
  sameSubject,
} from '~/lib/reader';
import { cx, groupColor, nwColors, type Palette, tw } from '~/lib/theme';
import { ReaderInspector, subjectTitle } from './ReaderInspector';

const SECTIONS = [
  { id: 'worth', numeral: 'I.', kicker: 'Net worth' },
  { id: 'flow', numeral: 'II.', kicker: 'Where the money went' },
  { id: 'brief', numeral: 'III.', kicker: 'In brief' },
  { id: 'merchants', numeral: 'IV.', kicker: 'Top merchants' },
  { id: 'cash', numeral: 'V.', kicker: 'Cash flow' },
] as const;

export function Reader({
  ledger,
  full,
  pal,
  dark,
  period,
  query,
  openFindings,
  goImport,
  openTransactions,
  synthetic,
}: {
  /** The ledger scoped by search. */
  ledger: Ledger;
  /** The whole ledger, for balances that search must not touch. */
  full: Ledger;
  pal: Palette;
  dark: boolean;
  period: Period;
  query: string;
  openFindings: number;
  goImport: () => void;
  openTransactions: (q: { text?: string; categoryId?: string }) => void;
  synthetic: boolean;
}) {
  const [hover, setHover] = useState<Subject | null>(null);
  const [pin, setPin] = useState<Subject | null>(null);
  const [kbd, setKbd] = useState<{ section: number; index: number } | null>(
    null,
  );
  const [focus, setFocus] = useState(-1);
  const [sheet, setSheet] = useState(false);
  const clear = useRef(0);
  const readerRef = useRef<HTMLDivElement>(null);
  const colors = nwColors(dark);
  const phrase = periodPhrase(period, ledger.asOf);
  const top = useMemo(
    () => topResolver(ledger.categories),
    [ledger.categories],
  );

  const nw = useMemo(() => netWorthWindow(full, period), [full, period]);
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
  const cash = useMemo<FlowRow[]>(() => {
    const by = new Map(
      cashFlow(ledger, {
        from: period.window[0],
        to: period.window[period.window.length - 1],
      }).map((r) => [r.month, r]),
    );
    return period.window.map(
      (m) => by.get(m) ?? { month: m, income: 0, spend: 0, net: 0 },
    );
  }, [ledger, period]);
  const inPeriod = useMemo(() => new Set(period.months), [period.months]);

  const groups = useMemo(
    () =>
      f.nodes
        .filter((n) => n.kind === 'group' && n.id !== 'all')
        .map((n) => ({
          id: n.id.slice(4),
          value: f.links
            .filter((l) => l.target === n.id)
            .reduce((s, l) => s + l.value, 0),
        }))
        .sort((a, b) => b.value - a.value),
    [f],
  );

  const lists: Subject[][] = useMemo(
    () => [
      nw.map((p) => ({ kind: 'month', month: p.month }) as Subject),
      [
        ...groups.map((g) => ({ kind: 'category', id: g.id }) as Subject),
        { kind: 'kept' },
      ],
      ranked.rows
        .filter((r) => r.id !== 'other')
        .map((r) => ({ kind: 'category', id: r.id }) as Subject),
      merchants.map(
        (m) => ({ kind: 'merchant', merchant: m.merchant }) as Subject,
      ),
      cash.map((r) => ({ kind: 'flow', month: r.month }) as Subject),
    ],
    [nw, groups, ranked, merchants, cash],
  );
  const leadIndex = (s: number) =>
    s === 0 || s === 4 ? Math.max(0, lists[s].length - 1) : 0;
  const kbdSubject = kbd ? (lists[kbd.section]?.[kbd.index] ?? null) : null;
  const shown = pin ?? hover ?? kbdSubject;

  const onHover = (section: number) => (s: Subject | null) => {
    window.clearTimeout(clear.current);
    if (s) {
      setHover(s);
      setFocus(section);
    } else clear.current = window.setTimeout(() => setHover(null), 420);
  };
  const onPick = (s: Subject) => {
    setPin((p) => (sameSubject(p, s) ? null : s));
    setSheet(true);
  };

  const moveTo = (section: number) => {
    setFocus(section);
    setKbd({ section, index: leadIndex(section) });
    document
      .getElementById(`rf-${SECTIONS[section].id}`)
      ?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isTyping(e) || e.metaKey || e.ctrlKey) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (e.key === 'j' || e.key === 'k') {
        e.preventDefault();
        const next =
          focus < 0
            ? 0
            : Math.max(
                0,
                Math.min(SECTIONS.length - 1, focus + (e.key === 'j' ? 1 : -1)),
              );
        moveTo(next);
      } else if ((e.key === 'h' || e.key === 'l') && focus >= 0) {
        e.preventDefault();
        const list = lists[focus];
        const at = shown ? list.findIndex((x) => sameSubject(x, shown)) : -1;
        const cur =
          kbd?.section === focus && !hover
            ? kbd.index
            : at >= 0
              ? at
              : leadIndex(focus);
        const index = Math.max(
          0,
          Math.min(list.length - 1, cur + (e.key === 'l' ? 1 : -1)),
        );
        setHover(null);
        setKbd({ section: focus, index });
      } else if (e.key === 'Enter' && tag !== 'BUTTON' && tag !== 'A') {
        const s = hover ?? kbdSubject;
        if (s) {
          e.preventDefault();
          setPin(s);
          setSheet(true);
        }
      } else if (e.key === 'Escape') {
        if (pin) setPin(null);
        else if (kbd) {
          setKbd(null);
          setFocus(-1);
        } else setSheet(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const latest = nw[nw.length - 1];
  const start = period.priorM
    ? (nw.find((p) => p.month === period.priorM) ?? nw[0])
    : nw[0];
  const change = latest && start ? latest.total - start.total : 0;
  const changePct = start?.total ? change / Math.abs(start.total) : 0;
  const q = query.trim();

  const reader = (
    <div className="mx-auto max-w-[760px] px-5 pt-10 sm:px-10">
      {q ? (
        <div
          className={cx(
            'mb-8 flex items-center gap-2 border-y py-2 text-[12px]',
            tw.rule,
            tw.ink2,
          )}
        >
          <span className={cx(tw.label, tw.ink3)}>Scoped</span>
          Flows, the brief and merchants follow “{q}”. Net worth ignores search.
        </div>
      ) : null}

      {/* I. Net worth ------------------------------------------------- */}
      <section id="rf-worth" className="scroll-mt-6">
        <SectionHead
          numeral="I."
          kicker={`Net worth · ${longDate(full.asOf)}`}
          focused={focus === 0}
          title={
            <span
              className={cx(
                serif,
                'rf-lining block text-[56px] leading-none font-normal tracking-[-0.03em] sm:text-[72px]',
              )}
            >
              {latest ? money(latest.total, false) : '—'}
              {latest?.estimated ? (
                <sup className={cx('ml-1 text-[0.3em]', tw.ink3)}>†</sup>
              ) : null}
            </span>
          }
          dek={
            start ? (
              <>
                <span
                  className={cx(
                    'font-mono tabular-nums',
                    change >= 0 ? tw.good : tw.bad,
                  )}
                >
                  {signedMoney(change, false)}
                </span>{' '}
                {period.key === 'all'
                  ? `since ${mLong(start.month)}`
                  : `${phrase.inline}, ${change >= 0 ? 'up' : 'down'} ${pct(Math.abs(changePct), 1)}`}
                . {carries(latest)}
              </>
            ) : null
          }
        />
        <NetWorthStack
          points={nw}
          pal={pal}
          colors={colors}
          active={shown?.kind === 'month' ? shown.month : null}
          onHover={(m) => onHover(0)(m ? { kind: 'month', month: m } : null)}
          onPick={(m) => onPick({ kind: 'month', month: m })}
        />
        <p className={cx('mt-3 text-[12px] leading-relaxed', tw.ink3)}>
          † Estimated. Hollow points carry a statement forward from an earlier
          month. Hover a month for its composition ladder.
        </p>
      </section>

      {/* II. Where the money went ------------------------------------- */}
      <section
        id="rf-flow"
        className={cx('mt-16 scroll-mt-6 border-t pt-12', tw.rule)}
      >
        <SectionHead
          numeral="II."
          kicker="The flow"
          focused={focus === 1}
          title={
            <>
              Where the money went,{' '}
              <span className={cx('italic', tw.ink3)}>
                {period.key === 'month'
                  ? phrase.title
                  : phrase.title.toLowerCase()}
              </span>
            </>
          }
          dek={
            f.saved > 0 ? (
              <>
                Every dollar that came in, followed to where it landed. The
                green ribbon is what stayed:{' '}
                <span className={cx('font-mono', tw.ink)}>
                  {magnitude(f.saved, false)}
                </span>
                .
              </>
            ) : (
              <>
                Every dollar that came in, followed to where it landed. Spending
                outran income by{' '}
                <span className={cx('font-mono', tw.ink)}>
                  {magnitude(f.spent - f.income, false)}
                </span>
                , drawn from savings.
              </>
            )
          }
        />
        {f.links.length ? (
          <SankeyFlow
            nodes={f.nodes}
            links={f.links}
            income={f.income}
            pal={pal}
            active={shown}
            lead={lists[1][0] ?? null}
            onHover={onHover(1)}
            onPick={onPick}
          />
        ) : (
          <p className={tw.ink3}>Nothing moved in this period.</p>
        )}
        <p className={cx(serif, 'mt-4 text-[14px] italic', tw.ink3)}>
          Hover a ribbon and the inspector lists its rows. Transfers between
          your own accounts are left out.
        </p>
      </section>

      {/* III. In brief ----------------------------------------------- */}
      <section
        id="rf-brief"
        className={cx('mt-16 scroll-mt-6 border-t pt-12', tw.rule)}
      >
        <SectionHead
          numeral="III."
          kicker="In brief"
          focused={focus === 2}
          title={`${phrase.title}, in a paragraph`}
        />
        <div className="grid gap-8 sm:grid-cols-[1fr_auto]">
          <p
            className={cx(
              serif,
              'rf-dropcap text-[19px] leading-[1.62] text-pretty',
              tw.ink,
            )}
          >
            {story.sentences.join(' ')}
          </p>
          {story.pull ? (
            <figure
              className={cx(
                'self-start border-l-2 pl-5 sm:w-[168px]',
                'border-[#0b0b0b] dark:border-[#f0efec]',
              )}
            >
              <div
                className={cx(
                  serif,
                  'rf-lining text-[46px] leading-none tracking-[-0.02em]',
                  tw.ink,
                )}
              >
                {story.pull.value}
              </div>
              <figcaption
                className={cx('mt-2 text-[12px] leading-snug', tw.ink3)}
              >
                {story.pull.caption}
              </figcaption>
            </figure>
          ) : null}
        </div>
        <UncategorisedNote
          ledger={ledger}
          period={period}
          open={() => openTransactions({ categoryId: UNCATEGORIZED })}
        />
        <div className="mt-10 flex items-baseline justify-between gap-4">
          <h3 className={cx(serif, 'text-[21px]', tw.ink)}>
            Spent, by category
          </h3>
          <span className={cx('text-[11px]', tw.ink3)}>
            {ranked.priorLabel}
          </span>
        </div>
        <ul className="mt-3">
          {ranked.rows.map((r) => {
            const max = ranked.rows[0]?.amount || 1;
            const subject: Subject | null =
              r.id === 'other' ? null : { kind: 'category', id: r.id };
            const on = subject && sameSubject(shown, subject);
            const delta = r.prior == null ? null : r.amount - r.prior;
            return (
              <li key={r.id}>
                <button
                  type="button"
                  onPointerEnter={() => subject && onHover(2)(subject)}
                  onPointerLeave={() => onHover(2)(null)}
                  onFocus={() => subject && onHover(2)(subject)}
                  onBlur={() => onHover(2)(null)}
                  onClick={() => subject && onPick(subject)}
                  className={cx(
                    'grid w-full cursor-pointer text-left grid-cols-[minmax(0,9rem)_1fr_88px_72px] items-center gap-x-3 border-t py-[7px] text-[13px] transition-colors',
                    rowRule,
                    on ? 'bg-[#eaf2fc] dark:bg-[#18263a]' : tw.hover,
                  )}
                >
                  <span className="flex min-w-0 items-center gap-2 pl-1">
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ background: groupColor(pal, r.groupId) }}
                    />
                    <span className={cx('truncate', tw.ink)}>{r.name}</span>
                  </span>
                  <span className="relative h-2.5">
                    <span
                      className="absolute inset-y-0 left-0 rounded-r-[3px] transition-[width] duration-300"
                      style={{
                        width: `${Math.max(0.6, (r.amount / max) * 100)}%`,
                        background: groupColor(pal, r.groupId),
                        opacity: r.id === 'other' ? 0.45 : 1,
                      }}
                    />
                  </span>
                  <span
                    className={cx('text-right font-mono tabular-nums', tw.ink)}
                  >
                    {magnitude(r.amount, false)}
                  </span>
                  <span
                    className={cx(
                      'pr-1 text-right font-mono text-[11px] tabular-nums',
                      delta == null || Math.abs(delta) < 1
                        ? tw.ink3
                        : delta > 0
                          ? tw.bad
                          : tw.good,
                    )}
                  >
                    {delta == null ? '' : signedMoney(delta, false)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      {/* IV. Top merchants -------------------------------------------- */}
      <section
        id="rf-merchants"
        className={cx('mt-16 scroll-mt-6 border-t pt-12', tw.rule)}
      >
        <SectionHead
          numeral="IV."
          kicker="The usual suspects"
          focused={focus === 3}
          title="Top merchants"
          dek={`Ranked by what was spent with them ${phrase.inline}. Hover one for its rows and the rule that files it.`}
        />
        {merchants.length ? (
          <ol>
            {merchants.map((mm, i) => {
              const subject: Subject = {
                kind: 'merchant',
                merchant: mm.merchant,
              };
              const on = sameSubject(shown, subject);
              return (
                <li key={mm.merchant}>
                  <button
                    type="button"
                    onPointerEnter={() => onHover(3)(subject)}
                    onPointerLeave={() => onHover(3)(null)}
                    onFocus={() => onHover(3)(subject)}
                    onBlur={() => onHover(3)(null)}
                    onClick={() => onPick(subject)}
                    className={cx(
                      'group grid w-full cursor-pointer text-left grid-cols-[2.75rem_1fr_auto] items-baseline gap-x-4 border-t py-4 transition-colors',
                      tw.rule,
                      on ? 'bg-[#eaf2fc] dark:bg-[#18263a]' : '',
                    )}
                  >
                    <span
                      className={cx(
                        serif,
                        'rf-lining pl-1 text-[26px] leading-none transition-colors',
                        on
                          ? tw.accent
                          : cx(
                              tw.ink3,
                              'group-hover:text-[#0b0b0b] dark:group-hover:text-[#f0efec]',
                            ),
                      )}
                    >
                      {String(i + 1).padStart(2, '0')}
                    </span>
                    <span className="block min-w-0">
                      <span className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                        <span
                          className={cx(serif, 'truncate text-[20px]', tw.ink)}
                        >
                          {mm.merchant}
                        </span>
                        <span
                          className={cx(
                            'inline-flex items-center gap-1.5 text-[11px]',
                            tw.ink3,
                          )}
                        >
                          <span
                            className="h-1.5 w-1.5 rounded-full"
                            style={{ background: groupColor(pal, mm.groupId) }}
                          />
                          {mm.categoryName}
                        </span>
                      </span>
                      <span className="block mt-2 h-[2px] w-full">
                        <span
                          className="block h-full rounded-full"
                          style={{
                            width: `${(mm.total / merchants[0].total) * 100}%`,
                            background: groupColor(pal, mm.groupId),
                          }}
                        />
                      </span>
                    </span>
                    <span className="block pr-1 text-right">
                      <span
                        className={cx(
                          'block font-mono text-[15px] tabular-nums',
                          tw.ink,
                        )}
                      >
                        {magnitude(mm.total, false)}
                      </span>
                      <span className={cx('block text-[11px]', tw.ink3)}>
                        {mm.count} {mm.count === 1 ? 'charge' : 'charges'}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        ) : (
          <p className={tw.ink3}>No spending in this period.</p>
        )}
      </section>

      {/* V. Cash flow -------------------------------------------------- */}
      <section
        id="rf-cash"
        className={cx('mt-16 scroll-mt-6 border-t pt-12', tw.rule)}
      >
        <SectionHead
          numeral="V."
          kicker="In and out"
          focused={focus === 4}
          title="Cash flow, month by month"
          dek="What came in beside what went out. The line is the difference; below zero, the month leaned on savings."
        />
        <div
          className={cx(
            'mb-3 flex flex-wrap gap-x-5 gap-y-1 text-[12px]',
            tw.ink2,
          )}
        >
          <Legend color={pal.income} label="Income" />
          <Legend color={pal.spend} label="Spent" />
          <Legend color={pal.ink} label="Net" line />
        </div>
        <CashColumns
          rows={cash}
          inPeriod={inPeriod}
          pal={pal}
          active={shown?.kind === 'flow' ? shown.month : null}
          onHover={(m) => onHover(4)(m ? { kind: 'flow', month: m } : null)}
          onPick={(m) => onPick({ kind: 'flow', month: m })}
        />
        <p className={cx('mt-3 text-[12px]', tw.ink3)}>
          Months outside the period are dimmed.{' '}
          {monthKey(ledger.asOf) === period.toM
            ? `${mLong(period.toM)} runs to the ${ordinal(Number(ledger.asOf.slice(8)))}.`
            : ''}
        </p>
      </section>

      <footer
        className={cx(
          'mt-20 flex items-baseline justify-between border-t pt-6 text-[12px]',
          tw.rule,
          tw.ink3,
        )}
      >
        <span className={cx(serif, 'text-[16px]', tw.ink2)}>tally.</span>
        <span>
          {synthetic
            ? 'Synthetic ledger. Nothing leaves this page.'
            : 'Read from the lab. Only descriptors ever leave it.'}
        </span>
      </footer>
    </div>
  );

  return (
    <Split
      readerRef={readerRef}
      open={sheet}
      setOpen={setSheet}
      peek={
        <>
          {pin ? 'Pinned · ' : ''}
          {subjectTitle(shown, ledger, period)}
        </>
      }
      onInspectorEnter={() => window.clearTimeout(clear.current)}
      onInspectorLeave={() => {
        window.clearTimeout(clear.current);
        clear.current = window.setTimeout(() => setHover(null), 420);
      }}
      reader={reader}
      inspector={
        <ReaderInspector
          key={shown ? JSON.stringify(shown) : 'none'}
          subject={shown}
          pinned={!!pin && sameSubject(pin, shown)}
          togglePin={() =>
            setPin((p) => (p && sameSubject(p, shown) ? null : shown))
          }
          ledger={ledger}
          full={full}
          pal={pal}
          colors={colors}
          period={period}
          nw={nw}
          cash={cash}
          top={top}
          openFindings={openFindings}
          goImport={goImport}
          openTransactions={openTransactions}
        />
      }
    />
  );
}

function Legend({
  color,
  label,
  line,
}: {
  color: string;
  label: string;
  line?: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={
          line ? 'h-[2px] w-3.5 rounded-full' : 'h-2.5 w-2.5 rounded-[2px]'
        }
        style={{ background: color }}
      />
      {label}
    </span>
  );
}

function UncategorisedNote({
  ledger,
  period,
  open,
}: {
  ledger: Ledger;
  period: Period;
  open: () => void;
}) {
  const n = ledger.transactions.filter(
    (t) =>
      t.categoryId === UNCATEGORIZED &&
      t.date >= period.from &&
      t.date <= period.to,
  ).length;
  if (!n) return null;
  return (
    <button
      type="button"
      onClick={open}
      className={cx(
        'group mt-6 inline-flex items-center gap-2 border-b pb-0.5 text-[13px]',
        'border-[#e4e3dd] hover:border-[#0b0b0b] dark:border-[#2a2a27] dark:hover:border-[#f0efec]',
        tw.ink2,
      )}
    >
      <Kicker>Still open</Kicker>
      {n} transaction{n === 1 ? ' is' : 's are'} uncategorised
      <ArrowRight
        size={13}
        className="transition-transform group-hover:translate-x-0.5"
      />
    </button>
  );
}

/** The dek's second sentence: which component carries net worth, and the debt under it. */
function carries(p: NetWorthPoint | undefined) {
  if (!p) return '';
  const assets = NW_PARTS.filter((x) => x.key !== 'mortgage')
    .map((x) => ({ label: x.label, value: p[x.key] }))
    .sort((a, b) => b.value - a.value);
  const top = assets[0];
  const sum = assets.reduce((s, x) => s + Math.max(0, x.value), 0);
  const share = top && sum > 0 ? top.value / sum : 0;
  const lead =
    top && share > 0.5
      ? `${top.label === 'House' ? 'The house' : top.label} carries most of it`
      : 'No one part carries most of it';
  return p.mortgage < 0
    ? `${lead}; the mortgage is the long shadow beneath.`
    : `${lead}.`;
}
