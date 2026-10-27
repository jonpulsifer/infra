// The written layer: every sentence the variant prints is generated here from
// the ledger, so the words and the charts can never disagree.

import type { ReactNode } from 'react';
import type { Ledger } from '~/fixtures/types';
import { shiftMonths } from '~/variants/b/model';
import { Fig } from './bits';
import { type Period, topResolver } from './model';
import { money, pct, signedMoney } from './theme';

const MONTHS =
  'January February March April May June July August September October November December'.split(
    ' ',
  );

export function monthName(ym: string) {
  return MONTHS[Number(ym.slice(5, 7)) - 1];
}

export function monthYear(ym: string) {
  return `${monthName(ym).slice(0, 3)} ${ym.slice(0, 4)}`;
}

export function ordinal(n: number) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

const WORDS =
  'zero one two three four five six seven eight nine ten eleven twelve'.split(
    ' ',
  );

export function count(n: number) {
  return n <= 12 ? WORDS[n] : n.toLocaleString('en-CA');
}

export function plural(n: number, one: string, many = `${one}s`) {
  return `${count(n)} ${n === 1 ? one : many}`;
}

function cap(s: string) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function lower(s: string) {
  return s === 'Uncategorized' ? 'uncategorised' : s.toLowerCase();
}

function be(name: string) {
  return /s$/i.test(name) ? 'were' : 'was';
}

function m0(n: number) {
  return money(n, false);
}

function joinNodes(items: ReactNode[]) {
  return items.map((it, i) => (
    <span key={i}>
      {i === 0 ? '' : i === items.length - 1 ? ' and ' : ', '}
      {it}
    </span>
  ));
}

// Aggregates ------------------------------------------------------------------

export type MerchAgg = { total: number; count: number };

export type Agg = {
  spend: number;
  income: number;
  leaf: Map<string, number>;
  group: Map<string, number>;
  /** Keyed `${leafId}|${merchant}`. */
  merch: Map<string, MerchAgg>;
  /** Keyed by merchant across leaves. */
  byMerchant: Map<string, MerchAgg>;
};

export type Window = { from: string; to: string };

export function aggregator(ledger: Ledger) {
  const top = topResolver(ledger.categories);
  return ({ from, to }: Window): Agg => {
    const a: Agg = {
      spend: 0,
      income: 0,
      leaf: new Map(),
      group: new Map(),
      merch: new Map(),
      byMerchant: new Map(),
    };
    for (const t of ledger.transactions) {
      if (t.transferId || t.date < from || t.date > to) continue;
      const g = top(t.categoryId);
      if (g.flow === 'income' && t.amount > 0) {
        a.income += t.amount;
        continue;
      }
      if (g.flow !== 'expense' || t.amount >= 0) continue;
      const v = -t.amount;
      a.spend += v;
      a.leaf.set(t.categoryId, (a.leaf.get(t.categoryId) ?? 0) + v);
      a.group.set(g.id, (a.group.get(g.id) ?? 0) + v);
      for (const [map, key] of [
        [a.merch, `${t.categoryId}|${t.merchant}`],
        [a.byMerchant, t.merchant],
      ] as const) {
        const m = map.get(key) ?? { total: 0, count: 0 };
        m.total += v;
        m.count += 1;
        map.set(key, m);
      }
    }
    return a;
  };
}

export type Baseline = { windows: Window[]; name: string };

export function baselineFor(p: Period, firstDate: string): Baseline | null {
  const shift = (n: number) => ({
    from: shiftMonths(p.from, -n),
    to: shiftMonths(p.to, -n),
  });
  const spec: Record<Period['key'], [number[], string] | null> = {
    month: [
      Array.from({ length: 12 }, (_, i) => i + 1),
      'the trailing-twelve average',
    ],
    last3: [[3, 6, 9, 12], 'the four quarters before'],
    ytd: [[12], `the same stretch of ${Number(p.toM.slice(0, 4)) - 1}`],
    y2025: [[12], '2024'],
    all: null,
  };
  const s = spec[p.key];
  if (!s) return null;
  const windows = s[0].map(shift).filter((w) => w.from >= firstDate);
  return windows.length ? { windows, name: s[1] } : null;
}

function avgOf(bases: Agg[], pick: (a: Agg) => number) {
  return bases.length
    ? bases.reduce((s, b) => s + pick(b), 0) / bases.length
    : 0;
}

export function subjectFor(p: Period, asOf: string, first: string) {
  const day = Number(asOf.slice(8, 10));
  const [y, m] = asOf.split('-').map(Number);
  const partial = day < new Date(Date.UTC(y, m, 0)).getUTCDate();
  switch (p.key) {
    case 'month':
      return partial
        ? `${monthName(p.toM)}, through the ${ordinal(day)},`
        : monthName(p.toM);
    case 'last3':
      return 'The last three months';
    case 'ytd':
      return 'The year so far';
    case 'y2025':
      return 'All of 2025';
    default:
      return `Since ${monthYear(first)}`;
  }
}

// The Brief -------------------------------------------------------------------

export function brief({
  ledger,
  cur,
  bases,
  baseline,
  subject,
  months,
}: {
  ledger: Ledger;
  cur: Agg;
  bases: Agg[];
  baseline: Baseline | null;
  subject: string;
  months: number;
}): ReactNode[] {
  const name = new Map(ledger.categories.map((c) => [c.id, c.name]));
  const out: ReactNode[] = [];
  const avg = avgOf(bases, (b) => b.spend);

  if (baseline && avg > 0) {
    const d = (cur.spend - avg) / avg;
    const r = Math.round(Math.abs(d) * 100);
    out.push(
      <>
        {subject} ran{' '}
        {r < 1 ? (
          'level with'
        ) : (
          <>
            <Fig tone={d > 0 ? 'bad' : 'good'}>{r}%</Fig>{' '}
            {d > 0 ? 'over' : 'under'}
          </>
        )}{' '}
        {baseline.name}: <Fig>{m0(cur.spend)}</Fig> spent against a typical{' '}
        {m0(avg)}.
      </>,
    );
    const ids = new Set([
      ...cur.leaf.keys(),
      ...bases.flatMap((b) => [...b.leaf.keys()]),
    ]);
    const moves = [...ids]
      .map((id) => ({
        name: name.get(id) ?? id,
        delta:
          (cur.leaf.get(id) ?? 0) - avgOf(bases, (b) => b.leaf.get(id) ?? 0),
      }))
      .filter((x) => Math.abs(x.delta) >= Math.max(40, avg * 0.003));
    const ups = moves
      .filter((x) => x.delta > 0)
      .sort((a, b) => b.delta - a.delta)
      .slice(0, 2);
    const downs = moves
      .filter((x) => x.delta < 0)
      .sort((a, b) => a.delta - b.delta)
      .slice(0, 1);
    const upText = ups.map((x, i) =>
      i === 0 ? (
        <>
          {x.name} ran <Fig tone="bad">{m0(x.delta)}</Fig> above the usual
        </>
      ) : (
        <>
          {lower(x.name)} <Fig tone="bad">{m0(x.delta)}</Fig>
        </>
      ),
    );
    const downText = downs.map((x) => (
      <>
        {ups.length ? lower(x.name) : x.name} came in{' '}
        <Fig tone="good">{m0(-x.delta)}</Fig> lighter
      </>
    ));
    if (ups.length || downs.length)
      out.push(
        <>
          {joinNodes(upText)}
          {ups.length && downs.length ? '; ' : ''}
          {joinNodes(downText)}.
        </>,
      );
    else out.push(<>No single category strayed far from the usual.</>);
  } else {
    out.push(
      <>
        {subject}, <Fig>{m0(cur.spend)}</Fig> went out over{' '}
        {plural(months, 'month')}, about {m0(cur.spend / Math.max(1, months))} a
        month.
      </>,
    );
    const groups = [...cur.group.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2);
    if (groups.length && cur.spend)
      out.push(
        <>
          {name.get(groups[0][0])} took{' '}
          <Fig>{pct(groups[0][1] / cur.spend)}</Fig> of it
          {groups[1] ? (
            <>
              {' '}
              and {lower(name.get(groups[1][0]) ?? '')}{' '}
              <Fig>{pct(groups[1][1] / cur.spend)}</Fig>
            </>
          ) : null}
          .
        </>,
      );
  }

  const kept = cur.income - cur.spend;
  if (cur.income > 0 && kept >= 0)
    out.push(
      <>
        Of the {m0(cur.income)} that came in, <Fig tone="good">{m0(kept)}</Fig>{' '}
        stayed: {pct(kept / cur.income)} of income.
      </>,
    );
  else if (cur.income > 0)
    out.push(
      <>
        Spending ran <Fig tone="bad">{m0(-kept)}</Fig> ahead of the{' '}
        {m0(cur.income)} that came in, drawn from savings.
      </>,
    );
  else out.push(<>Nothing came in over the period.</>);

  const ranked = [...cur.byMerchant.entries()].sort(
    (a, b) => b[1].total - a[1].total,
  );
  const [first, second] = ranked;
  if (first && cur.spend) {
    if (first[0] === 'Mortgage' && second)
      out.push(
        <>
          Past the mortgage ({m0(first[1].total)}), {second[0]} was the largest
          line at <Fig>{m0(second[1].total)}</Fig> across{' '}
          {plural(second[1].count, 'charge')}.
        </>,
      );
    else
      out.push(
        <>
          {first[0]} was the largest single line at{' '}
          <Fig>{m0(first[1].total)}</Fig>, {pct(first[1].total / cur.spend)} of
          everything spent.
        </>,
      );
  }
  return out.slice(0, 4);
}

export type Pull = { value: string; caption: string; tone: 'good' | 'bad' };

/** The two figures the Brief pulls out of its own paragraph. */
export function pulls(
  cur: Agg,
  bases: Agg[],
  baseline: Baseline | null,
): Pull[] {
  const out: Pull[] = [];
  const avg = avgOf(bases, (b) => b.spend);
  if (baseline && avg) {
    const d = (cur.spend - avg) / avg;
    const r = Math.round(Math.abs(d) * 100);
    out.push({
      value: r < 1 ? '±0%' : `${d < 0 ? '−' : '+'}${r}%`,
      caption: `spend against ${baseline.name.replace(/^the /, '')}`,
      tone: d > 0 ? 'bad' : 'good',
    });
  }
  if (cur.income > 0) {
    const k = (cur.income - cur.spend) / cur.income;
    out.push({
      value: pct(Math.abs(k)),
      caption: k >= 0 ? 'of income kept' : 'more spent than came in',
      tone: k >= 0 ? 'good' : 'bad',
    });
  }
  return out;
}

// Panel findings ----------------------------------------------------------------

const COMP_PHRASE: Record<string, (up: boolean) => string> = {
  cash: () => 'cash & credit',
  investments: () => 'investments',
  house: () => 'the house',
  mortgage: (up) => (up ? 'paying down the mortgage' : 'the mortgage'),
};

export function netWorthFinding({
  start,
  end,
  included,
  since,
}: {
  start: Record<string, unknown> | undefined;
  end: Record<string, unknown>;
  included: string[];
  since: string;
}): ReactNode {
  if (!start) return null;
  const deltas = included
    .map((k) => ({ k, d: Number(end[k] ?? 0) - Number(start[k] ?? 0) }))
    .sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
  const total = deltas.reduce((s, x) => s + x.d, 0);
  const up = total >= 0;
  const lead = deltas.find((x) => x.d >= 0 === up && Math.abs(x.d) >= 1);
  const next = deltas.find((x) => x !== lead && Math.abs(x.d) >= 500);
  return (
    <>
      {up ? 'Up' : 'Down'}{' '}
      <Fig tone={up ? 'good' : 'bad'}>{m0(Math.abs(total))}</Fig> since{' '}
      {monthYear(since)}
      {lead ? (
        <>
          ; {COMP_PHRASE[lead.k](lead.d > 0)}{' '}
          {Math.abs(lead.d) >= Math.abs(total) * 0.5 ? 'did most of it' : 'led'}{' '}
          (
          <Fig tone={lead.d >= 0 ? 'good' : 'bad'}>
            {signedMoney(lead.d, false)}
          </Fig>
          )
        </>
      ) : null}
      {next ? (
        <>
          , {COMP_PHRASE[next.k](next.d > 0)}{' '}
          <Fig tone={next.d >= 0 ? 'good' : 'bad'}>
            {signedMoney(next.d, false)}
          </Fig>
        </>
      ) : null}
      .
    </>
  );
}

export function cashFlowFinding(
  rows: { month: string; income: number; spend: number; net: number }[],
  partial: boolean,
): ReactNode {
  if (!rows.length) return 'Nothing moved in this period.';
  const income = rows.reduce((s, r) => s + r.income, 0);
  const spend = rows.reduce((s, r) => s + r.spend, 0);
  const net = income - spend;
  if (rows.length === 1) {
    const r = rows[0];
    return (
      <>
        {monthName(r.month)}
        {partial ? ' so far' : ''}: <Fig>{m0(r.income)}</Fig> in,{' '}
        <Fig>{m0(r.spend)}</Fig> out,{' '}
        {r.net >= 0 ? (
          <Fig tone="good">{m0(r.net)} ahead</Fig>
        ) : (
          <Fig tone="bad">{m0(-r.net)} behind</Fig>
        )}
        {partial && r.net < 0 ? ', with paydays still to land' : ''}.
      </>
    );
  }
  const neg = rows.filter((r) => r.net < 0).sort((a, b) => a.net - b.net);
  const head =
    net >= 0 ? (
      <>
        Kept <Fig tone="good">{m0(net)}</Fig> of {m0(income)} in, a{' '}
        <Fig>{income ? pct(net / income) : '—'}</Fig> rate
      </>
    ) : (
      <>
        Spent <Fig tone="bad">{m0(-net)}</Fig> more than the {m0(income)} that
        came in
      </>
    );
  const tail =
    neg.length === 0 ? (
      'every month came out ahead'
    ) : neg.length === 1 ? (
      <>
        {monthName(neg[0].month)} was the only month spending outran income (
        <Fig tone="bad">{signedMoney(neg[0].net, false)}</Fig>)
      </>
    ) : (
      <>
        {count(neg.length)} months leaned on savings, {monthName(neg[0].month)}{' '}
        hardest at <Fig tone="bad">{signedMoney(neg[0].net, false)}</Fig>
      </>
    );
  return (
    <>
      {head}; {tail}.
    </>
  );
}

const RUN_NOUN: Record<string, [string, string]> = {
  groceries: ['run', 'runs'],
  fuel: ['fill-up', 'fill-ups'],
  restaurants: ['visit', 'visits'],
  coffee: ['visit', 'visits'],
};

export function spendFinding({
  ledger,
  cur,
  bases,
  baseline,
  visible,
}: {
  ledger: Ledger;
  cur: Agg;
  bases: Agg[];
  baseline: Baseline | null;
  visible: Set<string>;
}): ReactNode {
  const top = topResolver(ledger.categories);
  const name = new Map(ledger.categories.map((c) => [c.id, c.name]));
  const shown = (id: string) => visible.has(top(id).id);
  if (!baseline) {
    const groups = [...cur.group.entries()]
      .filter(([g]) => visible.has(g))
      .sort((a, b) => b[1] - a[1]);
    const leaves = [...cur.leaf.entries()]
      .filter(([l]) => shown(l))
      .sort((a, b) => b[1] - a[1]);
    const total = groups.reduce((s, [, v]) => s + v, 0);
    if (!groups.length || !total) return 'No spending in this slice.';
    return (
      <>
        {name.get(groups[0][0])} took <Fig>{pct(groups[0][1] / total)}</Fig> of{' '}
        {m0(total)}; {lower(name.get(leaves[0][0]) ?? '')}{' '}
        {be(name.get(leaves[0][0]) ?? '')} the largest single category at{' '}
        <Fig>{m0(leaves[0][1])}</Fig>.
      </>
    );
  }
  const ids = new Set(
    [...cur.leaf.keys(), ...bases.flatMap((b) => [...b.leaf.keys()])].filter(
      shown,
    ),
  );
  const deltas = [...ids]
    .map((id) => ({
      id,
      delta: (cur.leaf.get(id) ?? 0) - avgOf(bases, (b) => b.leaf.get(id) ?? 0),
    }))
    .sort((a, b) => b.delta - a.delta);
  const best = deltas[0];
  if (!best) return 'No spending in this slice.';
  if (best.delta < 20) {
    const low = deltas[deltas.length - 1];
    return (
      <>
        Every category ran at or under {baseline.name}
        {low && low.delta < -20 ? (
          <>
            ; {lower(name.get(low.id) ?? '')} came in{' '}
            <Fig tone="good">{m0(-low.delta)}</Fig> lighter
          </>
        ) : null}
        .
      </>
    );
  }
  const prefix = `${best.id}|`;
  const merchants = [...cur.merch.entries()]
    .filter(([k]) => k.startsWith(prefix))
    .map(([k, v]) => {
      const was = avgOf(bases, (b) => b.merch.get(k)?.total ?? 0);
      const wasN = avgOf(bases, (b) => b.merch.get(k)?.count ?? 0);
      return {
        merchant: k.slice(prefix.length),
        d: v.total - was,
        n: v.count,
        wasN: Math.round(wasN),
      };
    })
    .sort((a, b) => b.d - a.d);
  const m = merchants[0];
  const [one, many] = RUN_NOUN[best.id] ?? ['charge', 'charges'];
  const share = m ? m.d / best.delta : 0;
  const self =
    m && m.merchant.toLowerCase() === (name.get(best.id) ?? '').toLowerCase();
  const tail =
    m && self
      ? m.n > m.wasN
        ? `${plural(m.n, one, many)} landed where ${count(m.wasN)} usually ${m.wasN === 1 ? 'does' : 'do'}`
        : `the ${m.n === 1 ? one : many} ran larger than usual`
      : m && share >= 0.6
        ? `${count(m.n)} ${m.merchant} ${m.n === 1 ? one : many} did it`
        : m && share >= 0.35
          ? `${m.merchant} did most of it, over ${plural(m.n, one, many)}`
          : `spread across ${plural(merchants.length, 'merchant')}`;
  return (
    <>
      {name.get(best.id)} ran <Fig tone="bad">{m0(best.delta)}</Fig> over{' '}
      {baseline.name}; {tail}.
    </>
  );
}

export function merchantFinding({
  merchants,
  spendTotal,
  bases,
}: {
  merchants: { merchant: string; total: number; count: number }[];
  spendTotal: number;
  bases: Agg[];
}): ReactNode {
  const [first] = merchants;
  if (!first || !spendTotal) return null;
  const five = merchants.slice(0, 5);
  const newcomer = bases.length
    ? five.find(
        (m) =>
          m.total > 150 &&
          avgOf(bases, (b) => b.byMerchant.get(m.merchant)?.total ?? 0) <
            m.total * 0.25,
      )
    : undefined;
  const share5 = five.reduce((s, m) => s + m.total, 0) / spendTotal;
  return (
    <>
      {first.merchant} alone was <Fig>{pct(first.total / spendTotal)}</Fig> of
      spend;{' '}
      {newcomer && newcomer !== first ? (
        <>{newcomer.merchant} is new to the top five</>
      ) : (
        <>
          the top five took <Fig>{pct(share5)}</Fig>
        </>
      )}
      .
    </>
  );
}

// The Sankey's voice ----------------------------------------------------------

export type FlowEnd = {
  id: string;
  name: string;
  kind: string;
  value: number;
  /** For a group: its leaves, largest first. For a leaf: its group. */
  children: { name: string; value: number }[];
  parent: { name: string; value: number } | null;
};

export type FlowFocus =
  | { kind: 'link'; source: FlowEnd; target: FlowEnd; value: number }
  | { kind: 'node'; node: FlowEnd };

function groupLine(g: FlowEnd, income: number) {
  const child = g.children[0];
  return (
    <>
      {g.name} took <Fig>{pct(g.value / income)}</Fig> of income
      {child && g.children.length > 1 ? (
        <>
          ; {lower(child.name)} {be(child.name)}{' '}
          <Fig>{pct(child.value / g.value)}</Fig> of {g.name}
        </>
      ) : null}
      .
    </>
  );
}

function leafLine(l: FlowEnd, income: number) {
  if (l.id === 'leaf:saved')
    return (
      <>
        <Fig tone="good">{m0(l.value)}</Fig> stayed:{' '}
        <Fig tone="good">{pct(l.value / income)}</Fig> of income was saved.
      </>
    );
  const p = l.parent;
  return (
    <>
      {l.name} {be(l.name)}{' '}
      {p ? (
        <>
          <Fig>{pct(l.value / p.value)}</Fig> of {p.name},{' '}
        </>
      ) : null}
      <Fig>{m0(l.value)}</Fig> and {pct(l.value / income, 1)} of all income.
    </>
  );
}

function sourceLine(s: FlowEnd, income: number) {
  if (s.id === 'src:drawdown')
    return (
      <>
        Spending outran income by <Fig tone="bad">{m0(s.value)}</Fig>; the gap
        came out of savings.
      </>
    );
  return (
    <>
      {s.name} brought in <Fig>{m0(s.value)}</Fig>,{' '}
      <Fig>{pct(s.value / income)}</Fig> of income.
    </>
  );
}

export function flowSentence(
  f: FlowFocus | null,
  ctx: { income: number; groups: FlowEnd[]; saved: number; drawn: number },
): ReactNode {
  const { income } = ctx;
  if (!income) return 'No income in this slice, so nothing to follow.';
  if (!f) {
    const g = [...ctx.groups].sort((a, b) => b.value - a.value)[0];
    return (
      <>
        Of <Fig>{m0(income)}</Fig> in,{' '}
        {g ? (
          <>
            {lower(g.name)} took the most at <Fig>{pct(g.value / income)}</Fig>
          </>
        ) : null}
        {ctx.saved > 0 ? (
          <>
            ; <Fig tone="good">{m0(ctx.saved)}</Fig> was saved,{' '}
            {pct(ctx.saved / income)} of income
          </>
        ) : ctx.drawn > 0 ? (
          <>
            ; spending outran it by <Fig tone="bad">{m0(ctx.drawn)}</Fig>
          </>
        ) : null}
        . Hover a ribbon to follow it.
      </>
    );
  }
  if (f.kind === 'node') {
    const n = f.node;
    if (n.kind === 'source') return sourceLine(n, income);
    if (n.id === 'all')
      return (
        <>
          <Fig>{m0(income)}</Fig> came in and split across{' '}
          {plural(ctx.groups.length, 'group')}
          {ctx.saved > 0 ? ' and savings' : ''}.
        </>
      );
    if (n.kind === 'group') return groupLine(n, income);
    return leafLine(n, income);
  }
  if (f.source.kind === 'source') return sourceLine(f.source, income);
  if (f.target.kind === 'group') return groupLine(f.target, income);
  return leafLine(f.target, income);
}

// Transactions ----------------------------------------------------------------

export function dayTitle(iso: string) {
  const [y, m, d] = iso.split('-').map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-CA', {
    weekday: 'short',
    timeZone: 'UTC',
  });
  return `${wd} ${d} ${MONTHS[m - 1].slice(0, 3)}`;
}

export function dayLine({
  charges,
  spend,
  groups,
  income,
  payer,
  transfers,
}: {
  charges: number;
  spend: number;
  groups: [string, number][];
  income: number;
  payer: string | null;
  transfers: number;
}): ReactNode {
  const parts: ReactNode[] = [];
  if (charges) {
    const [g1, g2] = groups;
    const lead =
      g1 && charges === 1
        ? g1[0]
        : g1 && groups.length === 1
          ? `all ${g1[0]}`
          : g1 && g1[1] / spend >= 0.5
            ? `mostly ${g1[0]}`
            : g1 && g2
              ? `${g1[0]} and ${g2[0]}`
              : g1
                ? g1[0]
                : '';
    parts.push(
      <>
        {plural(charges, 'charge')}, <Fig>{m0(spend)}</Fig>
        {lead ? `, ${lead}` : ''}
      </>,
    );
  }
  if (income)
    parts.push(
      <>
        <Fig tone="good">+{m0(income)}</Fig> in{payer ? ` from ${payer}` : ''}
      </>,
    );
  if (transfers) parts.push(<>{plural(transfers, 'transfer')}</>);
  return parts.map((p, i) => (
    <span key={i}>
      {i ? '; ' : ', '}
      {p}
    </span>
  ));
}

export { cap };
