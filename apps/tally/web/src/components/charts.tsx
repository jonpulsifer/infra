import {
  sankey as d3Sankey,
  type SankeyLink,
  type SankeyNode,
  sankeyLinkHorizontal,
} from 'd3-sankey';
import {
  area,
  curveMonotoneX,
  line,
  type SeriesPoint,
  stack,
  stackOffsetDiverging,
} from 'd3-shape';
import { useMemo } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { NetWorthPoint } from '~/fixtures/derive';
import { mLong, mShort } from '~/lib/dates';
import { kmoney, magnitude, money } from '~/lib/money';
import {
  type FlowLink,
  type FlowNode,
  linkSubject,
  NW_PARTS,
  type NwKey,
  nodeSubject,
  type Subject,
  sameSubject,
} from '~/lib/reader';
import { CAT_ORDER, cx, groupColor, type Palette, tw } from '~/lib/theme';
import { TipBox, TipRow, useWidth } from './bits';
import { serif } from './ui';

const AXIS_W = 44;
const X_BAND = 18;

// Small charts for the inspector ---------------------------------------------------

export function Sparkline({
  values,
  width,
  height = 22,
  color,
  fill,
}: {
  values: (number | null)[];
  width: number;
  height?: number;
  color: string;
  fill?: boolean;
}) {
  const pts = values
    .map((v, i) => (v == null ? null : ([i, v] as const)))
    .filter((p): p is readonly [number, number] => p !== null);
  if (pts.length < 2 || width <= 0)
    return <svg width={width} height={height} />;
  const vs = pts.map((p) => p[1]);
  const lo = Math.min(...vs);
  const hi = Math.max(...vs);
  const pad = 3;
  const sx = (i: number) => pad + (i / (values.length - 1)) * (width - pad * 2);
  const sy = (v: number) =>
    hi === lo
      ? height / 2
      : pad + (1 - (v - lo) / (hi - lo)) * (height - pad * 2);
  const d = pts
    .map(
      ([i, v], k) => `${k ? 'L' : 'M'}${sx(i).toFixed(1)},${sy(v).toFixed(1)}`,
    )
    .join('');
  const last = pts[pts.length - 1];
  const area = `${d}L${sx(last[0]).toFixed(1)},${height}L${sx(pts[0][0]).toFixed(1)},${height}Z`;
  return (
    <svg width={width} height={height} aria-hidden="true" className="block">
      {fill ? <path d={area} fill={color} opacity={0.08} /> : null}
      <path
        d={d}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={sx(last[0])} cy={sy(last[1])} r={2.5} fill={color} />
    </svg>
  );
}

export function SeriesChart({
  rows,
  series,
  pal,
  height = 170,
  step,
  dateKey = 'date',
  zeroBase,
  dotFor,
}: {
  rows: Record<string, any>[];
  series: {
    key: string;
    label: string;
    color: string;
    dashed?: boolean;
    area?: boolean;
  }[];
  pal: Palette;
  height?: number;
  step?: boolean;
  dateKey?: string;
  zeroBase?: boolean;
  dotFor?: (row: Record<string, any>) => 'filled' | 'hollow' | 'square' | null;
}) {
  const fmtX = (d: string) =>
    d.length > 7 ? `${mShort(d.slice(0, 7))} ’${d.slice(2, 4)}` : mLong(d);
  const tooltip = ({ active, payload }: any) => {
    if (!active || !payload?.length) return null;
    const r = payload[0].payload;
    return (
      <TipBox>
        <div className={cx('mb-1 font-medium', tw.ink2)}>
          {String(r[dateKey]).length > 7
            ? String(r[dateKey])
            : mLong(r[dateKey])}
        </div>
        {series.map((s) => (
          <TipRow
            key={s.key}
            color={s.color}
            label={s.label}
            value={money(Number(r[s.key]), false)}
          />
        ))}
        {r.note ? (
          <div className={cx('mt-1 text-[10px]', tw.ink3)}>{r.note}</div>
        ) : null}
      </TipBox>
    );
  };
  const axes = (
    <>
      <CartesianGrid vertical={false} stroke={pal.grid} />
      <XAxis
        dataKey={dateKey}
        tickFormatter={fmtX}
        minTickGap={28}
        tick={{ fill: pal.ink3, fontSize: 10 }}
        tickLine={false}
        axisLine={{ stroke: pal.axis }}
        height={X_BAND}
      />
      <YAxis
        width={AXIS_W}
        tickFormatter={(v: number) => kmoney(v)}
        tick={{ fill: pal.ink3, fontSize: 10 }}
        tickLine={false}
        axisLine={false}
        domain={zeroBase ? [0, 'auto'] : ['auto', 'auto']}
        tickCount={4}
      />
      <Tooltip
        cursor={{ stroke: pal.ink3, strokeWidth: 1 }}
        isAnimationActive={false}
        content={tooltip}
      />
    </>
  );
  const renderDot = (color: string) => (props: any) => {
    const kind = dotFor?.(props.payload);
    const { cx: x, cy: y, index } = props;
    if (!kind || x == null || y == null) return <g key={index} />;
    if (kind === 'square')
      return (
        <rect
          key={index}
          x={x - 4}
          y={y - 4}
          width={8}
          height={8}
          fill={color}
          stroke={pal.surface}
          strokeWidth={2}
        />
      );
    return (
      <circle
        key={index}
        cx={x}
        cy={y}
        r={4}
        fill={kind === 'hollow' ? pal.surface : color}
        stroke={kind === 'hollow' ? color : pal.surface}
        strokeWidth={2}
      />
    );
  };
  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        {series.some((s) => s.area) ? (
          <AreaChart
            data={rows}
            margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
          >
            {axes}
            {series.map((s) => (
              <Area
                key={s.key}
                type={step ? 'stepAfter' : 'monotone'}
                dataKey={s.key}
                stroke={s.color}
                strokeWidth={s.dashed ? 1.5 : 2}
                strokeDasharray={s.dashed ? '4 3' : undefined}
                fill={s.color}
                fillOpacity={s.area ? 0.08 : 0}
                isAnimationActive={false}
                dot={dotFor ? renderDot(s.color) : false}
                activeDot={{
                  r: 4,
                  fill: s.color,
                  stroke: pal.surface,
                  strokeWidth: 2,
                }}
              />
            ))}
          </AreaChart>
        ) : (
          <LineChart
            data={rows}
            margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
          >
            {axes}
            {series.map((s) => (
              <Line
                key={s.key}
                type={step ? 'stepAfter' : 'monotone'}
                dataKey={s.key}
                stroke={s.color}
                strokeWidth={2}
                isAnimationActive={false}
                dot={dotFor ? renderDot(s.color) : false}
                activeDot={{
                  r: 4,
                  fill: s.color,
                  stroke: pal.surface,
                  strokeWidth: 2,
                }}
              />
            ))}
          </LineChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}

// Scales ----------------------------------------------------------------------

function niceTicks(min: number, max: number, count = 4) {
  const span = max - min || Math.abs(max) || 1;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step =
    [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count) ??
    10 * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const out: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) out.push(Math.round(v));
  return out;
}

function linear([d0, d1]: [number, number], [r0, r1]: [number, number]) {
  const k = d1 === d0 ? 0 : (r1 - r0) / (d1 - d0);
  return (v: number) => r0 + (v - d0) * k;
}

function xTicks(ms: string[], max: number) {
  const n = ms.length;
  if (n <= max) return ms.map((_, i) => i);
  const every = Math.ceil(n / max);
  const out: number[] = [];
  for (let i = n - 1; i >= 0; i -= every) out.unshift(i);
  return out;
}

function monthTick(m: string, long: boolean) {
  if (long) return m.endsWith('-01') ? m.slice(0, 4) : `${mShort(m)}`;
  return m.endsWith('-01') ? `${mShort(m)} ’${m.slice(2, 4)}` : mShort(m);
}

function barPath(x: number, base: number, end: number, w: number, r = 3) {
  const h = Math.abs(end - base);
  const rr = Math.min(r, w / 2, h);
  if (h < 0.5) return '';
  if (end <= base)
    return `M${x},${base}V${end + rr}Q${x},${end} ${x + rr},${end}H${x + w - rr}Q${x + w},${end} ${x + w},${end + rr}V${base}Z`;
  return `M${x},${base}V${end - rr}Q${x},${end} ${x + rr},${end}H${x + w - rr}Q${x + w},${end} ${x + w},${end - rr}V${base}Z`;
}

function Grid({
  ticks,
  y,
  left,
  right,
  pal,
}: {
  ticks: number[];
  y: (v: number) => number;
  left: number;
  right: number;
  pal: Palette;
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
            stroke={t === 0 ? pal.axis : pal.grid}
            shapeRendering="crispEdges"
          />
          <text
            x={left - 8}
            y={y(t)}
            dy="0.32em"
            textAnchor="end"
            fontSize={10}
            fill={pal.ink3}
            className="font-mono tabular-nums"
          >
            {kmoney(t)}
          </text>
        </g>
      ))}
    </g>
  );
}

/**
 * The one Tab stop of a chart whose marks are pointer targets only. It takes
 * no pointer events; focus hands the reader its lead subject, then h and l
 * step and Enter pins (the reader owns those keys).
 */
function FocusStop({
  width,
  height,
  label,
  pal,
  onFocus,
  onBlur,
}: {
  width: number;
  height: number;
  label: string;
  pal: Palette;
  onFocus: () => void;
  onBlur: () => void;
}) {
  return (
    <rect
      x={1}
      y={1}
      width={Math.max(0, width - 2)}
      height={Math.max(0, height - 2)}
      rx={3}
      fill="none"
      stroke={pal.accent}
      strokeWidth={1.5}
      strokeDasharray="3 3"
      pointerEvents="none"
      role="button"
      tabIndex={0}
      aria-label={label}
      className="opacity-0 outline-none focus-visible:opacity-100"
      onFocus={onFocus}
      onBlur={onBlur}
    />
  );
}

/** Says what the inspector now shows, for a screen reader. */
function Announce({ text }: { text: string }) {
  return (
    <span className="sr-only" aria-live="polite">
      {text}
    </span>
  );
}

// I. Net worth: diverging stack, total line, right-edge labels ---------------

export function NetWorthStack({
  points,
  pal,
  colors,
  active,
  onHover,
  onPick,
}: {
  points: NetWorthPoint[];
  pal: Palette;
  colors: Record<NwKey, string>;
  active: string | null;
  onHover: (month: string | null) => void;
  onPick: (month: string) => void;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const narrow = width < 560;
  const h = 300;
  const m = { top: 22, right: narrow ? 12 : 132, bottom: 24, left: 50 };
  const n = points.length;
  const series = stack<NetWorthPoint, NwKey>()
    .keys(NW_PARTS.map((p) => p.key))
    .value((d, k) => d[k])
    .offset(stackOffsetDiverging)(points);
  const lo = Math.min(0, ...series.flatMap((s) => s.map((p) => p[0])));
  const hi = Math.max(0, ...series.flatMap((s) => s.map((p) => p[1])));
  const ticks = niceTicks(lo, hi, 4);
  const y = linear([ticks[0], ticks[ticks.length - 1]], [h - m.bottom, m.top]);
  const innerW = Math.max(10, width - m.left - m.right);
  const step = n > 1 ? innerW / (n - 1) : innerW;
  const x = (i: number) => m.left + i * step;
  const areaGen = area<SeriesPoint<NetWorthPoint>>()
    .x((_, i) => x(i))
    .y0((d) => y(d[0]))
    .y1((d) => y(d[1]))
    .curve(curveMonotoneX);
  const edge = (key: NwKey) =>
    line<SeriesPoint<NetWorthPoint>>()
      .x((_, i) => x(i))
      .y((d) => (d.data[key] < 0 ? y(d[0]) : y(d[1])))
      .curve(curveMonotoneX);
  const total = line<NetWorthPoint>()
    .x((_, i) => x(i))
    .y((d) => y(d.total))
    .curve(curveMonotoneX);

  const last = n - 1;
  const labels = series
    .map((s) => {
      const p = s[last];
      const def = NW_PARTS.find((k) => k.key === s.key)!;
      const mid = p ? (y(p[0]) + y(p[1])) / 2 : 0;
      return {
        key: s.key,
        label: def.label,
        value: points[last]?.[s.key] ?? 0,
        anchor: mid,
        at: mid,
      };
    })
    .filter((l) => Math.abs(l.value) > 0)
    .sort((a, b) => a.anchor - b.anchor);
  for (let i = 1; i < labels.length; i++)
    labels[i].at = Math.max(labels[i].at, labels[i - 1].at + 30);
  const over = labels.length
    ? labels[labels.length - 1].at - (h - m.bottom)
    : 0;
  if (over > 0) for (const l of labels) l.at -= over;

  const ai = active ? points.findIndex((p) => p.month === active) : -1;
  const ap = ai >= 0 ? points[ai] : null;
  const ms = points.map((p) => p.month);
  const tickIdx = xTicks(ms, Math.max(3, Math.floor(innerW / 70)));
  const nearest = (clientX: number, el: Element) => {
    const box = el.getBoundingClientRect();
    const i = Math.round((clientX - box.left - step / 2) / step);
    return points[Math.max(0, Math.min(n - 1, i))]?.month ?? null;
  };

  return (
    <div ref={ref} className="relative w-full">
      {width > 0 && n > 1 ? (
        <svg
          width={width}
          height={h}
          role="img"
          aria-label="Net worth by month, stacked by house, investments, cash and mortgage"
          className="block overflow-visible"
        >
          <Grid
            ticks={ticks}
            y={y}
            left={m.left}
            right={m.left + innerW}
            pal={pal}
          />
          {series.map((s) => (
            <g key={s.key}>
              <path
                d={areaGen(s) ?? ''}
                fill={colors[s.key]}
                fillOpacity={0.14}
              />
              <path
                d={edge(s.key)(s) ?? ''}
                fill="none"
                stroke={colors[s.key]}
                strokeWidth={1.5}
              />
            </g>
          ))}
          <path
            d={total(points) ?? ''}
            fill="none"
            stroke={pal.ink}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          {n <= 24
            ? points.map((p, i) => (
                <circle
                  key={p.month}
                  cx={x(i)}
                  cy={y(p.total)}
                  r={p.estimated ? 3 : 3.5}
                  fill={p.estimated ? pal.surface : pal.ink}
                  stroke={p.estimated ? pal.ink3 : pal.surface}
                  strokeWidth={1.5}
                />
              ))
            : null}
          {tickIdx.map((i) => (
            <text
              key={ms[i]}
              x={x(i)}
              y={h - 6}
              textAnchor={i === 0 ? 'start' : i === last ? 'end' : 'middle'}
              fontSize={10}
              fill={pal.ink3}
            >
              {monthTick(ms[i], n > 24)}
            </text>
          ))}
          {!narrow
            ? labels.map((l) => (
                <g key={l.key}>
                  {Math.abs(l.at - l.anchor) > 2 ? (
                    <path
                      d={`M${x(last) + 4},${l.anchor}C${x(last) + 14},${l.anchor} ${x(last) + 8},${l.at} ${x(last) + 18},${l.at}`}
                      fill="none"
                      stroke={pal.axis}
                    />
                  ) : null}
                  <rect
                    x={x(last) + 20}
                    y={l.at - 11}
                    width={2}
                    height={22}
                    rx={1}
                    fill={colors[l.key]}
                  />
                  <text
                    x={x(last) + 28}
                    y={l.at - 2}
                    fontSize={11}
                    fill={pal.ink2}
                  >
                    {l.label}
                  </text>
                  <text
                    x={x(last) + 28}
                    y={l.at + 11}
                    fontSize={11}
                    fill={pal.ink}
                    className="font-mono tabular-nums"
                  >
                    {kmoney(l.value)}
                  </text>
                </g>
              ))
            : null}
          {ap ? (
            <g pointerEvents="none">
              <line
                x1={x(ai)}
                x2={x(ai)}
                y1={m.top}
                y2={h - m.bottom}
                stroke={pal.ink2}
                strokeOpacity={0.6}
                shapeRendering="crispEdges"
              />
              <circle
                cx={x(ai)}
                cy={y(ap.total)}
                r={4.5}
                fill={pal.ink}
                stroke={pal.surface}
                strokeWidth={2}
              />
              <text
                x={x(ai)}
                y={m.top - 8}
                textAnchor={
                  ai > n * 0.75 ? 'end' : ai < n * 0.2 ? 'start' : 'middle'
                }
                fontSize={11}
                fill={pal.ink}
                stroke={pal.surface}
                strokeWidth={3}
                paintOrder="stroke"
                className="font-mono tabular-nums"
              >
                {mLong(ap.month)} · {money(ap.total, false)}
              </text>
            </g>
          ) : null}
          <rect
            x={m.left - step / 2}
            y={m.top}
            width={innerW + step}
            height={h - m.top - m.bottom}
            fill="transparent"
            className="cursor-crosshair outline-none"
            role="button"
            tabIndex={0}
            aria-label="Net worth by month. Enter pins the month shown."
            onFocus={() => onHover(active ?? points[last]?.month ?? null)}
            onBlur={() => onHover(null)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              e.preventDefault();
              const mm = active ?? points[last]?.month;
              if (mm) onPick(mm);
            }}
            onPointerMove={(e) => onHover(nearest(e.clientX, e.currentTarget))}
            onPointerLeave={() => onHover(null)}
            onClick={(e) => {
              const mm = nearest(e.clientX, e.currentTarget);
              if (mm) onPick(mm);
            }}
          />
        </svg>
      ) : (
        <div style={{ height: h }} />
      )}
      <Announce
        text={
          ap ? `${mLong(ap.month)}, net worth ${money(ap.total, false)}` : ''
        }
      />
      {narrow ? (
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
          {NW_PARTS.map((p) => (
            <span key={p.key} className="inline-flex items-center gap-1.5">
              <span
                className="h-2.5 w-2.5 rounded-[2px]"
                style={{ background: colors[p.key] }}
              />
              <span style={{ color: pal.ink2 }}>{p.label}</span>
              <span className="font-mono" style={{ color: pal.ink }}>
                {kmoney(points[last]?.[p.key] ?? 0)}
              </span>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// II. Where the money went -----------------------------------------------------

type N = SankeyNode<FlowNode, FlowLink>;
type L = SankeyLink<FlowNode, FlowLink>;

function rank(n: FlowNode) {
  if (n.id === 'src:savings' || n.id === 'leaf:saved') return 1000;
  if (n.kind === 'source' || n.id === 'all') return 0;
  const g = (CAT_ORDER as readonly string[]).indexOf(n.groupId);
  return (g < 0 ? 50 : g) * 10 + (n.kind === 'group' ? 0 : 1);
}

export function SankeyFlow({
  nodes,
  links,
  income,
  pal,
  active,
  lead,
  onHover,
  onPick,
}: {
  nodes: FlowNode[];
  links: FlowLink[];
  income: number;
  pal: Palette;
  active: Subject | null;
  /** What focus shows first. */
  lead: Subject | null;
  onHover: (s: Subject | null) => void;
  onPick: (s: Subject) => void;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const narrow = width < 620;
  const h = narrow ? 500 : 560;
  const m = narrow
    ? { left: 104, right: 118, top: 10, bottom: 10 }
    : { left: 132, right: 158, top: 12, bottom: 12 };

  const graph = useMemo(() => {
    if (width <= 0 || !links.length) return null;
    const layout = d3Sankey<FlowNode, FlowLink>()
      .nodeId((d) => d.id)
      .nodeWidth(6)
      .nodePadding(narrow ? 8 : 10)
      .nodeSort((a, b) => rank(a) - rank(b) || (b.value ?? 0) - (a.value ?? 0))
      .extent([
        [m.left, m.top],
        [width - m.right, h - m.bottom],
      ]);
    return layout({
      nodes: nodes.map((n) => ({ ...n })),
      links: links.map((l) => ({ ...l })),
    });
  }, [nodes, links, width, narrow, h]);

  const path = sankeyLinkHorizontal<FlowNode, FlowLink>();
  const maxX = graph ? Math.max(...graph.nodes.map((n) => n.x0 ?? 0)) : 0;
  const groupOf = useMemo(
    () => new Map(nodes.map((n) => [n.id, n.groupId])),
    [nodes],
  );
  const activeCat = active?.kind === 'category' ? active.id : null;
  const activeGroup = activeCat
    ? (groupOf.get(`leaf:${activeCat}`) ?? activeCat)
    : null;

  const linkOn = (l: L) => {
    if (!active) return null;
    const s = (l.source as N).id;
    const t = (l.target as N).id;
    if (sameSubject(linkSubject(s, t), active)) return true;
    if (activeCat && s === `grp:${activeCat}`) return true;
    if (activeCat && s === 'all' && t === `grp:${activeGroup}`) return true;
    return false;
  };
  const nodeOn = (n: N) => {
    if (!active) return true;
    if (sameSubject(nodeSubject(n.id), active)) return true;
    return graph
      ? graph.links.some(
          (l) =>
            linkOn(l) &&
            ((l.source as N).id === n.id || (l.target as N).id === n.id),
        )
      : false;
  };

  const color = (n: N) =>
    n.kind === 'source' || n.id === 'all'
      ? pal.ink2
      : groupColor(pal, n.groupId);
  const linkColor = (l: L) => {
    const t = l.target as N;
    if (t.id === 'all')
      return (l.source as N).id === 'src:savings' ? pal.bad : pal.axis;
    return groupColor(pal, t.groupId);
  };

  return (
    <div ref={ref} className="relative w-full">
      {graph ? (
        <svg
          width={width}
          height={h}
          role="img"
          aria-label="Where income went: sources into income, then spending groups and categories, and what was kept"
          className="block"
          onPointerLeave={() => onHover(null)}
        >
          <FocusStop
            width={width}
            height={h}
            pal={pal}
            label="Where the money went. h and l step through the groups, Enter pins one."
            onFocus={() => onHover(active ?? lead)}
            onBlur={() => onHover(null)}
          />
          <g fill="none">
            {graph.links.map((l) => {
              const s = (l.source as N).id;
              const t = (l.target as N).id;
              const on = linkOn(l);
              const kept = t === 'leaf:saved' || s === 'src:savings';
              return (
                <path
                  key={`${s}-${t}`}
                  d={path(l) ?? ''}
                  stroke={linkColor(l)}
                  strokeOpacity={
                    on === null ? (kept ? 0.62 : 0.3) : on ? 0.78 : 0.06
                  }
                  strokeWidth={Math.max(1, l.width ?? 1)}
                  className="cursor-pointer outline-none transition-[stroke-opacity] duration-150"
                  role="button"
                  tabIndex={-1}
                  aria-label={`${(l.source as N).name} to ${(l.target as N).name}, ${magnitude(l.value, false)}`}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter') return;
                    e.preventDefault();
                    onPick(linkSubject(s, t));
                  }}
                  onPointerMove={() => onHover(linkSubject(s, t))}
                  onClick={() => onPick(linkSubject(s, t))}
                />
              );
            })}
          </g>
          {graph.nodes.map((n) => {
            const x0 = n.x0 ?? 0;
            const x1 = n.x1 ?? 0;
            const y0 = n.y0 ?? 0;
            const y1 = n.y1 ?? 0;
            const nh = y1 - y0;
            const right = x0 >= maxX - 1;
            const left = n.kind === 'source';
            const lx = left ? x0 - 8 : x1 + 8;
            const big = n.id === 'all' || n.id === 'leaf:saved';
            const twoLine = nh >= 26 || big;
            const show = nh >= 8 || big;
            return (
              <g
                key={n.id}
                opacity={nodeOn(n) ? 1 : 0.5}
                className="cursor-pointer outline-none transition-opacity duration-150"
                role="button"
                tabIndex={-1}
                aria-label={`${n.name}, ${magnitude(n.value ?? 0, false)}`}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return;
                  e.preventDefault();
                  onPick(nodeSubject(n.id));
                }}
                onPointerMove={() => onHover(nodeSubject(n.id))}
                onClick={() => onPick(nodeSubject(n.id))}
              >
                <rect
                  x={x0}
                  y={y0}
                  width={x1 - x0}
                  height={Math.max(1, nh)}
                  rx={1.5}
                  fill={color(n)}
                />
                {show ? (
                  <text
                    x={lx}
                    y={(y0 + y1) / 2}
                    textAnchor={left ? 'end' : 'start'}
                    fill={pal.ink}
                    stroke={!left && !right ? pal.surface : 'none'}
                    strokeWidth={3}
                    paintOrder="stroke"
                    strokeLinejoin="round"
                  >
                    {twoLine ? (
                      <>
                        <tspan
                          x={lx}
                          dy="-0.2em"
                          fontSize={big ? 14 : 12}
                          className={big ? serif : undefined}
                        >
                          {n.name}
                        </tspan>
                        <tspan
                          x={lx}
                          dy="1.25em"
                          fontSize={10.5}
                          fill={pal.ink2}
                          className="font-mono tabular-nums"
                        >
                          {magnitude(n.value ?? 0, false)}
                          {n.id === 'leaf:saved' && income
                            ? ` · ${Math.round(((n.value ?? 0) / income) * 100)}%`
                            : ''}
                        </tspan>
                      </>
                    ) : (
                      <tspan dy="0.32em" fontSize={11}>
                        {n.name}
                        {narrow && right ? null : (
                          <tspan
                            fill={pal.ink3}
                            fontSize={10}
                            className="font-mono tabular-nums"
                          >
                            {'  '}
                            {kmoney(n.value ?? 0)}
                          </tspan>
                        )}
                      </tspan>
                    )}
                  </text>
                ) : null}
                <rect
                  x={x0 - 6}
                  y={y0 - 2}
                  width={x1 - x0 + 12}
                  height={Math.max(10, nh + 4)}
                  fill="transparent"
                />
              </g>
            );
          })}
        </svg>
      ) : (
        <div style={{ height: h }} />
      )}
      <Announce text={announceNode(graph?.nodes ?? [], active)} />
    </div>
  );
}

function announceNode(nodes: N[], active: Subject | null) {
  if (!active) return '';
  const n = nodes.find((x) => sameSubject(nodeSubject(x.id), active));
  return n ? `${n.name}, ${magnitude(n.value ?? 0, false)}` : '';
}

// V. Cash flow: paired columns, net as a line on the same axis -----------------

export type FlowRow = {
  month: string;
  income: number;
  spend: number;
  net: number;
};

export function CashColumns({
  rows,
  inPeriod,
  pal,
  active,
  onHover,
  onPick,
}: {
  rows: FlowRow[];
  inPeriod: Set<string>;
  pal: Palette;
  active: string | null;
  onHover: (month: string | null) => void;
  onPick: (month: string) => void;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const h = 250;
  const m = { top: 12, right: 4, bottom: 24, left: 50 };
  const n = rows.length;
  const innerW = Math.max(10, width - m.left - m.right);
  const band = innerW / Math.max(1, n);
  const barW = Math.max(
    2,
    Math.min(14, (band - Math.min(10, band * 0.3)) / 2 - 1),
  );
  const lo = Math.min(0, ...rows.map((r) => r.net));
  const hi = Math.max(1, ...rows.map((r) => Math.max(r.income, r.spend)));
  const ticks = niceTicks(lo, hi, 4);
  const y = linear([ticks[0], ticks[ticks.length - 1]], [h - m.bottom, m.top]);
  const cx = (i: number) => m.left + band * (i + 0.5);
  const net = line<FlowRow>()
    .x((_, i) => cx(i))
    .y((d) => y(d.net))
    .curve(curveMonotoneX);
  const ms = rows.map((r) => r.month);
  const tickIdx = xTicks(ms, Math.max(3, Math.floor(innerW / 54)));

  return (
    <div ref={ref} className="w-full">
      {width > 0 ? (
        <svg
          width={width}
          height={h}
          role="img"
          aria-label="Monthly income and spending, with net as a line"
          className="block"
          onPointerLeave={() => onHover(null)}
        >
          <FocusStop
            width={width}
            height={h}
            pal={pal}
            label="Cash flow by month. h and l step through the months, Enter pins one."
            onFocus={() => onHover(active ?? ms[ms.length - 1] ?? null)}
            onBlur={() => onHover(null)}
          />
          {active && ms.includes(active) ? (
            <rect
              x={m.left + band * ms.indexOf(active)}
              y={m.top}
              width={band}
              height={h - m.top - m.bottom}
              fill={pal.grid}
              opacity={0.7}
            />
          ) : null}
          <Grid
            ticks={ticks}
            y={y}
            left={m.left}
            right={m.left + innerW}
            pal={pal}
          />
          {rows.map((r, i) => (
            <g
              key={r.month}
              opacity={inPeriod.has(r.month) ? 1 : 0.4}
              className="transition-opacity duration-150"
            >
              <path
                d={barPath(cx(i) - barW - 1, y(0), y(r.income), barW)}
                fill={pal.income}
              />
              <path
                d={barPath(cx(i) + 1, y(0), y(r.spend), barW)}
                fill={pal.spend}
              />
            </g>
          ))}
          <path
            d={net(rows) ?? ''}
            fill="none"
            stroke={pal.ink}
            strokeWidth={1.75}
            strokeLinejoin="round"
          />
          {rows.map((r, i) =>
            n <= 24 || active === r.month ? (
              <circle
                key={r.month}
                cx={cx(i)}
                cy={y(r.net)}
                r={active === r.month ? 4.5 : 3}
                fill={pal.ink}
                stroke={pal.surface}
                strokeWidth={1.5}
              />
            ) : null,
          )}
          {tickIdx.map((i) => (
            <text
              key={ms[i]}
              x={cx(i)}
              y={h - 6}
              textAnchor="middle"
              fontSize={10}
              fill={pal.ink3}
            >
              {monthTick(ms[i], n > 24)}
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
              className="cursor-pointer outline-none"
              role="button"
              tabIndex={-1}
              aria-label={`${mLong(r.month)}: ${magnitude(r.income, false)} in, ${magnitude(r.spend, false)} spent`}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                onPick(r.month);
              }}
              onPointerEnter={() => onHover(r.month)}
              onClick={() => onPick(r.month)}
            />
          ))}
        </svg>
      ) : (
        <div style={{ height: h }} />
      )}
      <Announce
        text={(() => {
          const r = rows.find((x) => x.month === active);
          return r
            ? `${mLong(r.month)}: ${magnitude(r.income, false)} in, ${magnitude(r.spend, false)} spent`
            : '';
        })()}
      />
    </div>
  );
}
