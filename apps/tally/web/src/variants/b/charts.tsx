import {
  area,
  curveMonotoneX,
  curveStepAfter,
  line,
  type SeriesPoint as StackPoint,
  stack,
  stackOffsetDiverging,
} from 'd3-shape';
import { type PointerEvent, useState } from 'react';
import { monthLabel, type NetWorthPoint } from '~/fixtures/derive';
import type { Valuation } from '~/fixtures/types';
import {
  barPath,
  linear,
  niceTicks,
  type TipRow,
  Tooltip,
  tickLabel,
  useWidth,
} from './bits';
import { compactMoney, longDate, money, type SeriesPoint } from './model';

// Shared ----------------------------------------------------------------------

function nearestIndex(
  e: PointerEvent<SVGRectElement>,
  step: number,
  n: number,
) {
  const box = e.currentTarget.getBoundingClientRect();
  const px = e.clientX - box.left - step / 2;
  return Math.max(0, Math.min(n - 1, Math.round(px / step)));
}

function xTickIndexes(months: string[], maxTicks: number) {
  const n = months.length;
  if (n <= maxTicks) return months.map((_, i) => i);
  const every = Math.ceil(n / maxTicks);
  const out: number[] = [];
  for (let i = n - 1; i >= 0; i -= every) out.unshift(i);
  return out;
}

function YGrid({
  ticks,
  y,
  left,
  right,
}: {
  ticks: number[];
  y: (v: number) => number;
  left: number;
  right: number;
}) {
  return (
    <g>
      {ticks.map((t) => (
        <g key={t}>
          <line
            x1={left}
            x2={right}
            y1={y(t)}
            y2={y(t)}
            stroke={t === 0 ? 'var(--axis)' : 'var(--grid)'}
            strokeWidth={1}
            shapeRendering="crispEdges"
          />
          <text
            x={left - 10}
            y={y(t)}
            dy="0.32em"
            textAnchor="end"
            className="num"
            fontSize={11}
            fill="var(--faint)"
          >
            {tickLabel(t)}
          </text>
        </g>
      ))}
    </g>
  );
}

// Net worth: diverging stacked area with inline right-edge labels -------------

const NW_KEYS = [
  { key: 'house', label: 'House', color: 'var(--s1)' },
  { key: 'investments', label: 'Investments', color: 'var(--s3)' },
  { key: 'cash', label: 'Cash', color: 'var(--s4)' },
  { key: 'mortgage', label: 'Mortgage', color: 'var(--s7)' },
] as const;

type NwKey = (typeof NW_KEYS)[number]['key'];

export function NetWorthChart({ points }: { points: NetWorthPoint[] }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const compactLabels = width < 640;
  const h = compactLabels ? 300 : 380;
  const m = { top: 20, right: compactLabels ? 16 : 168, bottom: 32, left: 58 };
  const n = points.length;
  const series = stack<NetWorthPoint, NwKey>()
    .keys(NW_KEYS.map((k) => k.key))
    .value((d, k) => d[k])
    .offset(stackOffsetDiverging)(points);
  const lo = Math.min(0, ...series.flatMap((s) => s.map((p) => p[0])));
  const hi = Math.max(0, ...series.flatMap((s) => s.map((p) => p[1])));
  const ticks = niceTicks(lo, hi, 5);
  const y = linear([ticks[0], ticks[ticks.length - 1]], [h - m.bottom, m.top]);
  const innerW = Math.max(10, width - m.left - m.right);
  const step = n > 1 ? innerW / (n - 1) : innerW;
  const x = (i: number) => m.left + i * step;

  const areaGen = area<StackPoint<NetWorthPoint>>()
    .x((_, i) => x(i))
    .y0((d) => y(d[0]))
    .y1((d) => y(d[1]))
    .curve(curveMonotoneX);
  const edge = (s: (typeof series)[number]) =>
    line<StackPoint<NetWorthPoint>>()
      .x((_, i) => x(i))
      .y((d) => (s.key === 'mortgage' || s.key === 'cash' ? y(d[0]) : y(d[1])))
      .curve(curveMonotoneX)(s);
  const totalLine = line<NetWorthPoint>()
    .x((_, i) => x(i))
    .y((d) => y(d.total))
    .curve(curveMonotoneX);

  // Right-edge labels: centred on each band, pushed apart with a leader when they collide.
  const last = n - 1;
  const labels = series
    .map((s) => {
      const p = s[last];
      const def = NW_KEYS.find((k) => k.key === s.key)!;
      return {
        key: s.key,
        label: def.label,
        color: def.color,
        value: points[last]?.[s.key] ?? 0,
        anchor: (y(p[0]) + y(p[1])) / 2,
        at: (y(p[0]) + y(p[1])) / 2,
      };
    })
    .filter((l) => Math.abs(l.value) > 0)
    .sort((a, b) => a.anchor - b.anchor);
  for (let i = 1; i < labels.length; i++)
    labels[i].at = Math.max(labels[i].at, labels[i - 1].at + 34);
  const overflow = labels.length
    ? labels[labels.length - 1].at - (h - m.bottom)
    : 0;
  if (overflow > 0) for (const l of labels) l.at -= overflow;

  const showRings = n <= 24;
  const months = points.map((p) => p.month);
  const tickIdx = xTickIndexes(months, Math.max(3, Math.floor(innerW / 90)));
  const hp = hover == null ? null : points[hover];

  const tipRows: TipRow[] = hp
    ? [
        { label: 'Net worth', value: money(hp.total) },
        ...NW_KEYS.map((k) => ({
          label: k.label,
          value: money(hp[k.key]),
          color: k.color,
        })),
      ]
    : [];

  return (
    <div ref={ref} className="relative w-full">
      {width > 0 ? (
        <svg
          width={width}
          height={h}
          role="img"
          aria-label="Net worth by month, stacked by house, investments, cash and mortgage"
          className="block overflow-visible"
        >
          <YGrid ticks={ticks} y={y} left={m.left} right={m.left + innerW} />
          {series.map((s) => {
            const def = NW_KEYS.find((k) => k.key === s.key)!;
            return (
              <g key={s.key}>
                <path
                  d={areaGen(s) ?? ''}
                  fill={def.color}
                  fillOpacity={0.16}
                />
                <path
                  d={edge(s) ?? ''}
                  fill="none"
                  stroke={def.color}
                  strokeWidth={1.5}
                  strokeOpacity={0.9}
                />
              </g>
            );
          })}
          <path
            d={totalLine(points) ?? ''}
            fill="none"
            stroke="var(--ink)"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          {points.map((p, i) =>
            p.estimated ? (
              showRings ? (
                <circle
                  key={p.month}
                  cx={x(i)}
                  cy={y(p.total)}
                  r={3.5}
                  fill="var(--page)"
                  stroke="var(--ink)"
                  strokeOpacity={0.4}
                  strokeWidth={1.5}
                />
              ) : null
            ) : (
              <circle
                key={p.month}
                cx={x(i)}
                cy={y(p.total)}
                r={4}
                fill="var(--ink)"
                stroke="var(--page)"
                strokeWidth={2}
              />
            ),
          )}
          {tickIdx.map((i) => (
            <text
              key={months[i]}
              x={x(i)}
              y={h - 8}
              textAnchor={i === 0 ? 'start' : i === last ? 'end' : 'middle'}
              fontSize={11}
              fill="var(--faint)"
            >
              {monthLabel(months[i])}
            </text>
          ))}
          {!compactLabels
            ? labels.map((l) => (
                <g key={l.key}>
                  {Math.abs(l.at - l.anchor) > 2 ? (
                    <path
                      d={`M${x(last) + 6},${l.anchor}C${x(last) + 16},${l.anchor} ${x(last) + 10},${l.at} ${x(last) + 22},${l.at}`}
                      fill="none"
                      stroke="var(--axis)"
                    />
                  ) : null}
                  <rect
                    x={x(last) + 24}
                    y={l.at - 13}
                    width={3}
                    height={26}
                    rx={1.5}
                    fill={l.color}
                  />
                  <text
                    x={x(last) + 34}
                    y={l.at - 2}
                    fontSize={12}
                    fill="var(--ink2)"
                  >
                    {l.label}
                  </text>
                  <text
                    x={x(last) + 34}
                    y={l.at + 13}
                    fontSize={13}
                    fontWeight={600}
                    fill="var(--ink)"
                    className="num"
                  >
                    {compactMoney(l.value)}
                  </text>
                </g>
              ))
            : null}
          {hp && hover != null ? (
            <line
              x1={x(hover)}
              x2={x(hover)}
              y1={m.top}
              y2={h - m.bottom}
              stroke="var(--ink2)"
              strokeOpacity={0.5}
              shapeRendering="crispEdges"
            />
          ) : null}
          <rect
            x={m.left - step / 2}
            y={m.top}
            width={innerW + step}
            height={h - m.top - m.bottom}
            fill="transparent"
            onPointerMove={(e) => setHover(nearestIndex(e, step, n))}
            onPointerLeave={() => setHover(null)}
          />
        </svg>
      ) : (
        <div style={{ height: h }} />
      )}
      {hp && hover != null ? (
        <Tooltip
          x={x(hover)}
          y={y(hp.total)}
          width={width}
          title={monthLabel(hp.month)}
          rows={tipRows}
          note={
            hp.estimated
              ? 'Estimate: a component is carried forward'
              : 'Every component from a statement this month'
          }
        />
      ) : null}
      {compactLabels ? (
        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-[13px]">
          {NW_KEYS.map((k) => (
            <span
              key={k.key}
              className="inline-flex items-center gap-2 text-(--ink2)"
            >
              <span
                className="size-2.5 rounded-[3px]"
                style={{ background: k.color }}
              />
              {k.label}
              <span className="num font-semibold text-(--ink)">
                {compactMoney(points[last]?.[k.key] ?? 0)}
              </span>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// Cash flow: paired columns, net as a line on the same axis ------------------

export type CashRow = {
  month: string;
  income: number;
  spend: number;
  net: number;
};

export function CashFlowChart({
  rows,
  partialMonth,
}: {
  rows: CashRow[];
  partialMonth?: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const h = 320;
  const m = { top: 16, right: 12, bottom: 32, left: 58 };
  const n = rows.length;
  const innerW = Math.max(10, width - m.left - m.right);
  const band = innerW / Math.max(1, n);
  const barW = Math.max(
    2,
    Math.min(24, (band - Math.min(12, band * 0.3)) / 2 - 1),
  );
  const lo = Math.min(0, ...rows.map((r) => r.net));
  const hi = Math.max(0, ...rows.map((r) => Math.max(r.income, r.spend)));
  const ticks = niceTicks(lo, hi, 5);
  const y = linear([ticks[0], ticks[ticks.length - 1]], [h - m.bottom, m.top]);
  const cx = (i: number) => m.left + band * (i + 0.5);
  const netLine = line<CashRow>()
    .x((_, i) => cx(i))
    .y((d) => y(d.net))
    .curve(curveMonotoneX);
  const months = rows.map((r) => r.month);
  const tickIdx = xTickIndexes(months, Math.max(3, Math.floor(innerW / 64)));
  const hr = hover == null ? null : rows[hover];

  return (
    <div ref={ref} className="relative w-full">
      {width > 0 ? (
        <svg
          width={width}
          height={h}
          role="img"
          aria-label="Monthly income and spending, with net as a line"
          className="block"
        >
          <YGrid ticks={ticks} y={y} left={m.left} right={m.left + innerW} />
          {rows.map((r, i) => {
            const dim = hover != null && hover !== i;
            return (
              <g
                key={r.month}
                opacity={dim ? 0.45 : 1}
                className="transition-opacity duration-150"
              >
                <path
                  d={barPath(cx(i) - barW - 1, y(0), y(r.income), barW)}
                  fill="var(--s1)"
                />
                <path
                  d={barPath(cx(i) + 1, y(0), y(r.spend), barW)}
                  fill="var(--s2)"
                />
              </g>
            );
          })}
          <path
            d={netLine(rows) ?? ''}
            fill="none"
            stroke="var(--ink)"
            strokeWidth={2}
            strokeLinejoin="round"
          />
          {rows.map((r, i) =>
            n <= 24 || hover === i ? (
              <circle
                key={r.month}
                cx={cx(i)}
                cy={y(r.net)}
                r={4}
                fill="var(--ink)"
                stroke="var(--page)"
                strokeWidth={2}
              />
            ) : null,
          )}
          {tickIdx.map((i) => (
            <text
              key={months[i]}
              x={cx(i)}
              y={h - 8}
              textAnchor="middle"
              fontSize={11}
              fill="var(--faint)"
            >
              {monthLabel(months[i])}
              {months[i] === partialMonth ? '*' : ''}
            </text>
          ))}
          {rows.map((r, i) => (
            <rect
              key={r.month}
              x={m.left + band * i}
              y={m.top}
              width={band}
              height={h - m.top - m.bottom}
              fill="transparent"
              onPointerEnter={() => setHover(i)}
              onPointerLeave={() => setHover(null)}
            />
          ))}
        </svg>
      ) : (
        <div style={{ height: h }} />
      )}
      {hr && hover != null ? (
        <Tooltip
          x={cx(hover)}
          y={y(Math.max(hr.income, hr.spend))}
          width={width}
          title={`${monthLabel(hr.month)}${hr.month === partialMonth ? ', month to date' : ''}`}
          rows={[
            {
              label: 'Income',
              value: money(hr.income),
              color: 'var(--s1)',
              mark: 'dot',
            },
            {
              label: 'Spending',
              value: money(hr.spend),
              color: 'var(--s2)',
              mark: 'dot',
            },
            { label: 'Net', value: money(hr.net), color: 'var(--ink)' },
          ]}
        />
      ) : null}
    </div>
  );
}

// Single-series line with crosshair, for account histories -----------------

export function LineChart({
  points,
  height = 260,
  color = 'var(--s1)',
  label,
}: {
  points: SeriesPoint[];
  height?: number;
  color?: string;
  label: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const m = { top: 16, right: 16, bottom: 30, left: 58 };
  const n = points.length;
  const innerW = Math.max(10, width - m.left - m.right);
  const step = n > 1 ? innerW / (n - 1) : innerW;
  const x = (i: number) => m.left + i * step;
  const vals = points.map((p) => p.value);
  const ticks = niceTicks(Math.min(0, ...vals), Math.max(0, ...vals), 4);
  const y = linear(
    [ticks[0], ticks[ticks.length - 1]],
    [height - m.bottom, m.top],
  );
  const lineGen = line<SeriesPoint>()
    .x((_, i) => x(i))
    .y((d) => y(d.value))
    .curve(curveMonotoneX);
  const areaGen = area<SeriesPoint>()
    .x((_, i) => x(i))
    .y0(y(0))
    .y1((d) => y(d.value))
    .curve(curveMonotoneX);
  const tickIdx = xTickIndexes(
    points.map((p) => p.date),
    Math.max(3, Math.floor(innerW / 90)),
  );
  const hp = hover == null ? null : points[hover];
  if (!n) return null;
  return (
    <div ref={ref} className="relative w-full">
      {width > 0 ? (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={label}
          className="block"
        >
          <YGrid ticks={ticks} y={y} left={m.left} right={m.left + innerW} />
          <path d={areaGen(points) ?? ''} fill={color} fillOpacity={0.1} />
          <path
            d={lineGen(points) ?? ''}
            fill="none"
            stroke={color}
            strokeWidth={2}
            strokeLinejoin="round"
          />
          <circle
            cx={x(n - 1)}
            cy={y(points[n - 1].value)}
            r={4}
            fill={color}
            stroke="var(--page)"
            strokeWidth={2}
          />
          {tickIdx.map((i) => (
            <text
              key={points[i].date}
              x={x(i)}
              y={height - 8}
              textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}
              fontSize={11}
              fill="var(--faint)"
            >
              {monthLabel(points[i].date.slice(0, 7))}
            </text>
          ))}
          {hp && hover != null ? (
            <>
              <line
                x1={x(hover)}
                x2={x(hover)}
                y1={m.top}
                y2={height - m.bottom}
                stroke="var(--ink2)"
                strokeOpacity={0.5}
              />
              <circle
                cx={x(hover)}
                cy={y(hp.value)}
                r={4}
                fill={color}
                stroke="var(--page)"
                strokeWidth={2}
              />
            </>
          ) : null}
          <rect
            x={m.left - step / 2}
            y={m.top}
            width={innerW + step}
            height={height - m.top - m.bottom}
            fill="transparent"
            onPointerMove={(e) => setHover(nearestIndex(e, step, n))}
            onPointerLeave={() => setHover(null)}
          />
        </svg>
      ) : (
        <div style={{ height }} />
      )}
      {hp && hover != null ? (
        <Tooltip
          x={x(hover)}
          y={y(hp.value)}
          width={width}
          title={longDate(hp.date)}
          rows={[{ label: 'Balance', value: money(hp.value), color }]}
        />
      ) : null}
    </div>
  );
}

// House valuations: a step line with source markers ------------------------

const SOURCE_LABEL: Record<Valuation['source'], string> = {
  purchase: 'Purchase price',
  assessment: 'Municipal assessment',
  estimate: 'Your estimate',
};

export function ValuationMarker({
  source,
  x,
  y,
  r = 5,
}: {
  source: Valuation['source'];
  x: number;
  y: number;
  r?: number;
}) {
  if (source === 'purchase')
    return (
      <rect
        x={x - r}
        y={y - r}
        width={r * 2}
        height={r * 2}
        transform={`rotate(45 ${x} ${y})`}
        fill="var(--s1)"
        stroke="var(--page)"
        strokeWidth={2}
      />
    );
  if (source === 'estimate')
    return (
      <circle
        cx={x}
        cy={y}
        r={r}
        fill="var(--page)"
        stroke="var(--s1)"
        strokeWidth={2}
      />
    );
  return (
    <circle
      cx={x}
      cy={y}
      r={r}
      fill="var(--s1)"
      stroke="var(--page)"
      strokeWidth={2}
    />
  );
}

function dayNumber(iso: string) {
  return Date.parse(`${iso}T00:00:00Z`) / 86_400_000;
}

export function ValuationChart({
  valuations,
  asOf,
  height = 280,
}: {
  valuations: Valuation[];
  asOf: string;
  height?: number;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const m = { top: 28, right: 24, bottom: 30, left: 64 };
  const innerW = Math.max(10, width - m.left - m.right);
  const t0 = dayNumber(valuations[0]?.date ?? asOf);
  const t1 = dayNumber(asOf);
  const x = linear([t0, t1], [m.left, m.left + innerW]);
  const vals = valuations.map((v) => v.value);
  const ticks = niceTicks(
    Math.min(...vals) * 0.96,
    Math.max(...vals) * 1.02,
    4,
  );
  const y = linear(
    [ticks[0], ticks[ticks.length - 1]],
    [height - m.bottom, m.top],
  );
  const pts = [
    ...valuations.map((v) => ({ t: dayNumber(v.date), value: v.value })),
    { t: t1, value: vals[vals.length - 1] ?? 0 },
  ];
  const step = line<{ t: number; value: number }>()
    .x((d) => x(d.t))
    .y((d) => y(d.value))
    .curve(curveStepAfter);
  const years: number[] = [];
  for (
    let yr = Number(valuations[0]?.date.slice(0, 4) ?? 2022) + 1;
    yr <= Number(asOf.slice(0, 4));
    yr++
  )
    years.push(yr);
  const hv = hover == null ? null : valuations[hover];
  return (
    <div ref={ref} className="relative w-full">
      {width > 0 ? (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label="House valuations over time"
          className="block"
        >
          {ticks.map((t) => (
            <g key={t}>
              <line
                x1={m.left}
                x2={m.left + innerW}
                y1={y(t)}
                y2={y(t)}
                stroke="var(--grid)"
                shapeRendering="crispEdges"
              />
              <text
                x={m.left - 10}
                y={y(t)}
                dy="0.32em"
                textAnchor="end"
                fontSize={11}
                fill="var(--faint)"
                className="num"
              >
                {tickLabel(t)}
              </text>
            </g>
          ))}
          {years.map((yr) => (
            <text
              key={yr}
              x={x(dayNumber(`${yr}-01-01`))}
              y={height - 8}
              textAnchor="middle"
              fontSize={11}
              fill="var(--faint)"
            >
              {yr}
            </text>
          ))}
          <path
            d={step(pts) ?? ''}
            fill="none"
            stroke="var(--s1)"
            strokeWidth={2}
            strokeLinejoin="round"
          />
          {valuations.map((v, i) => {
            const cx = x(dayNumber(v.date));
            const cy = y(v.value);
            const labelled = i === 0 || i === valuations.length - 1;
            return (
              <g key={v.date}>
                <ValuationMarker
                  source={v.source}
                  x={cx}
                  y={cy}
                  r={hover === i ? 6 : 5}
                />
                {labelled ? (
                  <text
                    x={cx}
                    y={cy - 14}
                    textAnchor={i === 0 ? 'start' : 'end'}
                    fontSize={12}
                    fontWeight={600}
                    fill="var(--ink)"
                    className="num halo"
                  >
                    {compactMoney(v.value)}
                  </text>
                ) : null}
                <circle
                  cx={cx}
                  cy={cy}
                  r={14}
                  fill="transparent"
                  onPointerEnter={() => setHover(i)}
                  onPointerLeave={() => setHover(null)}
                />
              </g>
            );
          })}
        </svg>
      ) : (
        <div style={{ height }} />
      )}
      {hv && hover != null ? (
        <Tooltip
          x={x(dayNumber(hv.date))}
          y={y(hv.value)}
          width={width}
          title={longDate(hv.date)}
          rows={[
            {
              label: SOURCE_LABEL[hv.source],
              value: money(hv.value),
              color: 'var(--s1)',
              mark: 'dot',
            },
          ]}
        />
      ) : null}
    </div>
  );
}

export { SOURCE_LABEL };

// Sparkline -----------------------------------------------------------------

export function Sparkline({
  points,
  stepped = false,
  markers,
  height = 44,
}: {
  points: SeriesPoint[];
  stepped?: boolean;
  markers?: Valuation['source'][];
  height?: number;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const n = points.length;
  const vals = points.map((p) => p.value);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const pad = 6;
  const x = linear(
    [0, Math.max(1, n - 1)],
    [pad, Math.max(pad + 1, width - pad)],
  );
  const y = linear(min === max ? [min - 1, max + 1] : [min, max], [
    height - pad,
    pad,
  ]);
  const gen = line<SeriesPoint>()
    .x((_, i) => x(i))
    .y((d) => y(d.value))
    .curve(stepped ? curveStepAfter : curveMonotoneX);
  return (
    <div ref={ref} className="w-full" aria-hidden>
      {width > 0 && n > 0 ? (
        <svg width={width} height={height} className="block overflow-visible">
          <path
            d={gen(points) ?? ''}
            fill="none"
            stroke="var(--ink2)"
            strokeOpacity={0.7}
            strokeWidth={1.5}
            strokeLinejoin="round"
          />
          {markers ? (
            points.map((p, i) => (
              <ValuationMarker
                key={p.date}
                source={markers[i]}
                x={x(i)}
                y={y(p.value)}
                r={3.5}
              />
            ))
          ) : (
            <circle
              cx={x(n - 1)}
              cy={y(vals[n - 1])}
              r={4}
              fill="var(--s1)"
              stroke="var(--raise)"
              strokeWidth={2}
            />
          )}
        </svg>
      ) : (
        <div style={{ height }} />
      )}
    </div>
  );
}
