import { monthKey } from '~/fixtures/derive';

export type PeriodKey = 'month' | 'last3' | 'ytd' | 'y2025' | 'all';

export const PERIODS: { key: PeriodKey; label: string }[] = [
  { key: 'month', label: 'This month' },
  { key: 'last3', label: 'Last 3' },
  { key: 'ytd', label: 'YTD' },
  { key: 'y2025', label: '2025' },
  { key: 'all', label: 'All' },
];

export type Period = {
  key: PeriodKey;
  label: string;
  /** ISO dates, inclusive. */
  from: string;
  to: string;
  /** Month keys, inclusive. */
  fromM: string;
  toM: string;
  /** Months inside the period. */
  months: string[];
  /** Months a monthly chart shows: the period, padded to at least a year. */
  window: string[];
  /** The months before `from` used for deltas. */
  priorM: string | null;
};

export function addMonths(ym: string, n: number) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

function span(from: string, to: string) {
  const out: string[] = [];
  for (let m = from; m <= to; m = addMonths(m, 1)) out.push(m);
  return out;
}

export function resolvePeriod(
  key: PeriodKey,
  asOf: string,
  allMonths: string[],
): Period {
  const label = PERIODS.find((p) => p.key === key)!.label;
  const now = monthKey(asOf);
  const first = allMonths[0];
  const year = asOf.slice(0, 4);
  const [fromM, toM] = (
    {
      month: [now, now],
      last3: [addMonths(now, -2), now],
      ytd: [`${year}-01`, now],
      y2025: ['2025-01', '2025-12'],
      all: [first, now],
    } as const
  )[key];
  const months = span(fromM, toM);
  const window = months.length >= 12 ? months : span(addMonths(toM, -11), toM);
  const priorM = fromM > first ? addMonths(fromM, -1) : null;
  const to = toM === now ? asOf : `${toM}-31`;
  return {
    key,
    label,
    from: `${fromM}-01`,
    to,
    fromM,
    toM,
    months,
    window: window.filter((m) => m >= first),
    priorM,
  };
}
