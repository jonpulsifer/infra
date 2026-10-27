import { monthKey } from '~/fixtures/derive';
import { addMonths } from './dates';

export type PeriodKey = 'month' | 'last3' | 'ytd' | 'year' | 'all';

export const PERIOD_KEYS: PeriodKey[] = [
  'month',
  'last3',
  'ytd',
  'year',
  'all',
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
  /** The month before `from`, used for deltas, when the ledger reaches it. */
  priorM: string | null;
};

/** The last full calendar year before the one the ledger ends in. */
export function lastYear(asOf: string) {
  return String(Number(asOf.slice(0, 4)) - 1);
}

export function periodOptions(
  asOf: string,
): { key: PeriodKey; label: string }[] {
  return PERIOD_KEYS.map((key) => ({ key, label: periodLabel(key, asOf) }));
}

function periodLabel(key: PeriodKey, asOf: string) {
  switch (key) {
    case 'month':
      return 'This month';
    case 'last3':
      return 'Last 3';
    case 'ytd':
      return 'YTD';
    case 'year':
      return lastYear(asOf);
    case 'all':
      return 'All';
  }
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
  const now = monthKey(asOf);
  const first = allMonths[0] ?? now;
  const year = asOf.slice(0, 4);
  const prev = lastYear(asOf);
  const [fromM, toM] = (
    {
      month: [now, now],
      last3: [addMonths(now, -2), now],
      ytd: [`${year}-01`, now],
      year: [`${prev}-01`, `${prev}-12`],
      all: [first, now],
    } as const
  )[key];
  const months = span(fromM, toM);
  const window = months.length >= 12 ? months : span(addMonths(toM, -11), toM);
  const priorM = fromM > first ? addMonths(fromM, -1) : null;
  const to = toM === now ? asOf : `${toM}-31`;
  return {
    key,
    label: periodLabel(key, asOf),
    from: `${fromM}-01`,
    to,
    fromM,
    toM,
    months,
    window: window.filter((m) => m >= first),
    priorM,
  };
}
