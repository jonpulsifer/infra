import { curveMonotoneX, line } from 'd3-shape';
import { AlertTriangle } from 'lucide-react';
import { monthLong, monthShort, shiftMonth } from '../model';
import type { Palette } from '../theme';

export function Sparkline({
  values,
  color,
  pal,
  width = 132,
  height = 40,
}: {
  values: number[];
  color: string;
  pal: Palette;
  width?: number;
  height?: number;
}) {
  if (values.length < 2) return <div style={{ width, height }} />;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = 5;
  const x = (i: number) => pad + (i / (values.length - 1)) * (width - pad * 2);
  const y = (v: number) =>
    pad + (1 - (v - min) / (max - min || 1)) * (height - pad * 2);
  const d =
    line<number>()
      .x((_, i) => x(i))
      .y((v) => y(v))
      .curve(curveMonotoneX)(values) ?? '';
  const last = values.length - 1;
  return (
    <svg width={width} height={height} aria-hidden className="block">
      <path
        d={d}
        fill="none"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle
        cx={x(last)}
        cy={y(values[last])}
        r={4}
        fill={color}
        stroke={pal.surface}
        strokeWidth={2}
      />
    </svg>
  );
}

/** Year rows of month cells; the months with no statement are red. */
export function GapTimeline({
  since,
  asOf,
  from,
  to,
}: {
  since: string;
  asOf: string;
  from: string;
  to: string;
}) {
  const y0 = Number(since.slice(0, 4));
  const y1 = Number(asOf.slice(0, 4));
  const years = Array.from({ length: y1 - y0 + 1 }, (_, i) => y0 + i);
  const gapFrom = from.slice(0, 7);
  const gapTo = to.slice(0, 7);
  const first = since.slice(0, 7);
  const lastM = asOf.slice(0, 7);
  const label =
    gapFrom === gapTo
      ? monthLong(gapFrom, true)
      : `${monthShort(gapFrom)}–${monthLong(gapTo, true)}`;
  return (
    <figure>
      <div className="grid grid-cols-[2.5rem_1fr] items-center gap-x-2 gap-y-1.5">
        <span />
        <div className="grid grid-cols-12 gap-1 text-center text-[10px] text-stone-500">
          {Array.from({ length: 12 }, (_, i) => (
            <span key={i}>
              {monthShort(`2000-${String(i + 1).padStart(2, '0')}`)[0]}
            </span>
          ))}
        </div>
        {years.map((yr) => (
          <Row
            key={yr}
            year={yr}
            first={first}
            last={lastM}
            gapFrom={gapFrom}
            gapTo={gapTo}
          />
        ))}
      </div>
      <figcaption className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-stone-600 dark:text-stone-400">
        <span className="inline-flex items-center gap-1.5 font-medium text-red-700 dark:text-red-300">
          <AlertTriangle className="size-3.5" aria-hidden />
          {label} missing
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-stone-300 dark:bg-stone-600" />
          Statement on file
        </span>
      </figcaption>
    </figure>
  );
}

function Row({
  year,
  first,
  last,
  gapFrom,
  gapTo,
}: {
  year: number;
  first: string;
  last: string;
  gapFrom: string;
  gapTo: string;
}) {
  return (
    <>
      <span className="text-xs font-medium text-stone-500 tabular-nums">
        {year}
      </span>
      <div className="grid grid-cols-12 gap-1">
        {Array.from({ length: 12 }, (_, i) => {
          const m = `${year}-${String(i + 1).padStart(2, '0')}`;
          const out = m < first || m > last;
          const gap = m >= gapFrom && m <= gapTo;
          const edge = gap && (m === gapFrom || shiftMonth(m, 1) > gapTo);
          return (
            <span
              key={m}
              title={`${monthLong(m, true)}: ${out ? 'no account yet' : gap ? 'missing' : 'on file'}`}
              className={`h-5 rounded-md ${
                out
                  ? 'bg-transparent ring-1 ring-stone-200 ring-inset dark:ring-stone-800'
                  : gap
                    ? `bg-[#d03b3b] ${edge ? 'ring-2 ring-red-300 dark:ring-red-900' : ''}`
                    : 'bg-stone-300 dark:bg-stone-600'
              }`}
            />
          );
        })}
      </div>
    </>
  );
}
