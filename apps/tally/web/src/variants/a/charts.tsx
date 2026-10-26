import {
  sankey as d3Sankey,
  type SankeyLink,
  type SankeyNode,
  sankeyJustify,
  sankeyLinkHorizontal,
} from 'd3-sankey';
import { useMemo, useState } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { SankeyData } from '~/fixtures/derive';
import { TipBox, TipLayer, TipRow, useTip, useWidth } from './bits';
import { CAT_ORDER, cx, kmoney, money, type Palette, pct, tw } from './theme';

const MONTHS = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');

export function mShort(ym: string) {
  return MONTHS[Number(ym.slice(5, 7)) - 1];
}

export function mLong(ym: string) {
  return `${mShort(ym)} ${ym.slice(0, 4)}`;
}

function niceStep(v: number) {
  if (v <= 0) return 1;
  const e = 10 ** Math.floor(Math.log10(v));
  const f = v / e;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * e;
}

function ticksFor(max: number, count = 4) {
  const step = niceStep(max / count);
  const top = Math.max(step, Math.ceil(max / step) * step);
  const out: number[] = [];
  for (let v = 0; v <= top + step / 2; v += step) out.push(v);
  return out;
}

/** Cap the scale when one month dwarfs the rest, so the others stay readable. */
function capFor(values: number[]) {
  const sorted = [...values].filter((v) => v > 0).sort((a, b) => a - b);
  if (sorted.length < 6) return sorted[sorted.length - 1] ?? 0;
  const max = sorted[sorted.length - 1];
  const q = sorted[Math.floor(0.9 * (sorted.length - 1))];
  return max > q * 2.2 ? q * 1.35 : max;
}

function xLabels(window: string[], width: number) {
  if (window.length > 24) {
    return window.map((m) => (m.endsWith('-01') ? m.slice(0, 4) : ''));
  }
  const step = Math.max(
    1,
    Math.ceil((window.length * 34) / Math.max(1, width)),
  );
  return window.map((m, i) =>
    i % step === 0 || m.endsWith('-01')
      ? m.endsWith('-01')
        ? `${mShort(m)} ’${m.slice(2, 4)}`
        : mShort(m)
      : '',
  );
}

function topRounded(x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, h, w / 2);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

function bottomRounded(x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, h, w / 2);
  return `M${x},${y}H${x + w}V${y + h - rr}Q${x + w},${y + h} ${x + w - rr},${y + h}H${x + rr}Q${x},${y + h} ${x},${y + h - rr}Z`;
}

const AXIS_W = 44;
const X_BAND = 18;

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

export type SpendRow = { month: string } & Record<string, number | string>;

export function SpendStack({
  rows,
  visible,
  names,
  window,
  inPeriod,
  pal,
  height = 188,
}: {
  rows: SpendRow[];
  visible: string[];
  names: Record<string, string>;
  window: string[];
  inPeriod: Set<string>;
  pal: Palette;
  height?: number;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const { host, tip, show, hide } = useTip();
  const [hover, setHover] = useState<{ m: string; k: string | null } | null>(
    null,
  );
  const byMonth = new Map(rows.map((r) => [r.month, r]));
  const val = (m: string, k: string) => Number(byMonth.get(m)?.[k] ?? 0);
  const keys = CAT_ORDER.filter((k) => visible.includes(k));
  const totals = window.map((m) => keys.reduce((s, k) => s + val(m, k), 0));
  const cap = capFor(totals);
  const ticks = ticksFor(cap || 1);
  const top = ticks[ticks.length - 1];
  const plotH = height - X_BAND;
  const plotW = Math.max(0, width - AXIS_W);
  const band = plotW / Math.max(1, window.length);
  const bw = Math.max(2, Math.min(24, band * 0.68));
  const sy = (v: number) => (v / top) * (plotH - 6);
  const labels = xLabels(window, plotW);

  const monthTip = (m: string, k: string | null) => {
    const total = keys.reduce((s, kk) => s + val(m, kk), 0);
    return (
      <>
        <div className={cx('mb-1 font-medium', tw.ink2)}>{mLong(m)}</div>
        {[...keys].reverse().map((kk) => (
          <div
            key={kk}
            className={cx(
              'rounded-[2px] px-1 -mx-1',
              kk === k && 'bg-[#f1f0ec] dark:bg-[#232321]',
            )}
          >
            <TipRow
              color={pal.cat[kk]}
              shape="rect"
              label={names[kk] ?? kk}
              value={money(val(m, kk), false)}
            />
          </div>
        ))}
        <div className={cx('mt-1 border-t pt-1', tw.rule)}>
          <TipRow label="Total" value={money(total, false)} />
        </div>
      </>
    );
  };

  return (
    <div ref={host} className="relative">
      <div ref={ref} className="w-full">
        {width > 0 ? (
          <svg
            width={width}
            height={height}
            role="img"
            aria-label="Monthly spend by category"
          >
            {ticks.map((t) => (
              <g key={t}>
                <line
                  x1={AXIS_W}
                  x2={width}
                  y1={plotH - sy(t)}
                  y2={plotH - sy(t)}
                  stroke={t === 0 ? pal.axis : pal.grid}
                  strokeWidth={1}
                  shapeRendering="crispEdges"
                />
                <text
                  x={AXIS_W - 8}
                  y={plotH - sy(t)}
                  dy="0.32em"
                  textAnchor="end"
                  fontSize={10}
                  fill={pal.ink3}
                  className="tabular-nums"
                >
                  {kmoney(t)}
                </text>
              </g>
            ))}
            {window.map((m, i) => {
              const x = AXIS_W + i * band + (band - bw) / 2;
              const dim = !inPeriod.has(m);
              let y = plotH;
              const total = totals[i];
              const clipped = total > top;
              const segs = keys
                .map((k) => ({ k, v: val(m, k) }))
                .filter((s) => s.v > 0);
              const isHover = hover?.m === m;
              return (
                <g
                  key={m}
                  opacity={dim ? 0.38 : 1}
                  style={{ transition: 'opacity 150ms' }}
                >
                  {segs.map((s, j) => {
                    const lastSeg = j === segs.length - 1;
                    let h = sy(s.v);
                    if (clipped) h = (s.v / total) * (plotH - 6);
                    const y0 = y - h;
                    y = y0;
                    const gap = lastSeg ? 0 : 2;
                    const hh = Math.max(0, h - gap);
                    const lift = isHover && hover?.k === s.k;
                    return lastSeg ? (
                      <path
                        key={s.k}
                        d={topRounded(x, y0, bw, hh, 3)}
                        fill={pal.cat[s.k]}
                        style={
                          lift ? { filter: 'brightness(1.15)' } : undefined
                        }
                      />
                    ) : (
                      <rect
                        key={s.k}
                        x={x}
                        y={y0 + gap}
                        width={bw}
                        height={hh}
                        fill={pal.cat[s.k]}
                        style={
                          lift ? { filter: 'brightness(1.15)' } : undefined
                        }
                      />
                    );
                  })}
                  {clipped ? (
                    <>
                      <path
                        d={`M${x - 2},${18}l${bw + 4},-5M${x - 2},${23}l${bw + 4},-5`}
                        stroke={pal.surface}
                        strokeWidth={2.5}
                      />
                      <text
                        x={x + bw + 4}
                        y={10}
                        fontSize={10}
                        fill={pal.ink2}
                        className="tabular-nums"
                      >
                        {kmoney(total)}
                      </text>
                    </>
                  ) : null}
                  <rect
                    x={AXIS_W + i * band}
                    y={0}
                    width={band}
                    height={plotH}
                    fill="transparent"
                    role="button"
                    tabIndex={0}
                    aria-label={`${mLong(m)}: ${money(total, false)}`}
                    className="outline-none"
                    onPointerMove={(e) => {
                      const ry =
                        e.clientY - e.currentTarget.getBoundingClientRect().top;
                      let acc = plotH;
                      let hit: string | null = null;
                      for (const s of segs) {
                        const h = clipped
                          ? (s.v / total) * (plotH - 6)
                          : sy(s.v);
                        if (ry <= acc && ry >= acc - h) hit = s.k;
                        acc -= h;
                      }
                      setHover({ m, k: hit });
                      show(e, monthTip(m, hit));
                    }}
                    onFocus={(e) => {
                      setHover({ m, k: null });
                      show(e, monthTip(m, null));
                    }}
                    onPointerLeave={() => {
                      setHover(null);
                      hide();
                    }}
                    onBlur={() => {
                      setHover(null);
                      hide();
                    }}
                  />
                </g>
              );
            })}
            {labels.map((l, i) =>
              l ? (
                <text
                  key={window[i]}
                  x={AXIS_W + i * band + band / 2}
                  y={height - 4}
                  fontSize={10}
                  textAnchor="middle"
                  fill={pal.ink3}
                >
                  {l}
                </text>
              ) : null,
            )}
          </svg>
        ) : (
          <div style={{ height }} />
        )}
      </div>
      <TipLayer tip={tip} width={width} />
    </div>
  );
}

export type FlowRow = {
  month: string;
  income: number;
  spend: number;
  net: number;
};

export function CashFlowPair({
  rows,
  window,
  inPeriod,
  pal,
  height = 188,
}: {
  rows: FlowRow[];
  window: string[];
  inPeriod: Set<string>;
  pal: Palette;
  height?: number;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const { host, tip, show, hide } = useTip();
  const [hover, setHover] = useState<string | null>(null);
  const by = new Map(rows.map((r) => [r.month, r]));
  const data = window.map(
    (m) => by.get(m) ?? { month: m, income: 0, spend: 0, net: 0 },
  );
  const cap = capFor([
    ...data.map((d) => d.income),
    ...data.map((d) => d.spend),
  ]);
  const ticks = ticksFor(cap || 1, 3);
  const top = ticks[ticks.length - 1];
  const plotH = height - X_BAND;
  const mid = plotH / 2;
  const half = mid - 4;
  const plotW = Math.max(0, width - AXIS_W);
  const band = plotW / Math.max(1, window.length);
  const bw = Math.max(2, Math.min(16, band * 0.5));
  const sy = (v: number) => (Math.min(Math.abs(v), top) / top) * half;
  const labels = xLabels(window, plotW);

  const tipFor = (d: FlowRow) => (
    <>
      <div className={cx('mb-1 font-medium', tw.ink2)}>{mLong(d.month)}</div>
      <TipRow
        color={pal.income}
        shape="rect"
        label="Income"
        value={money(d.income, false)}
      />
      <TipRow
        color={pal.spend}
        shape="rect"
        label="Spend"
        value={money(-d.spend, false)}
      />
      <div className={cx('mt-1 border-t pt-1', tw.rule)}>
        <TipRow
          color={pal.ink}
          shape="dot"
          label="Net"
          value={money(d.net, false)}
        />
        <TipRow
          label="Savings rate"
          value={d.income ? pct(d.net / d.income) : '—'}
        />
      </div>
    </>
  );

  return (
    <div ref={host} className="relative">
      <div ref={ref} className="w-full">
        {width > 0 ? (
          <svg
            width={width}
            height={height}
            role="img"
            aria-label="Monthly income and spend"
          >
            {[
              ...ticks
                .slice(1)
                .map((t) => -t)
                .reverse(),
              ...ticks,
            ].map((t) => (
              <g key={t}>
                <line
                  x1={AXIS_W}
                  x2={width}
                  y1={mid - Math.sign(t) * sy(t)}
                  y2={mid - Math.sign(t) * sy(t)}
                  stroke={t === 0 ? pal.axis : pal.grid}
                  shapeRendering="crispEdges"
                />
                <text
                  x={AXIS_W - 8}
                  y={mid - Math.sign(t) * sy(t)}
                  dy="0.32em"
                  textAnchor="end"
                  fontSize={10}
                  fill={pal.ink3}
                  className="tabular-nums"
                >
                  {kmoney(t)}
                </text>
              </g>
            ))}
            {data.map((d, i) => {
              const cx0 = AXIS_W + i * band + band / 2;
              const x = cx0 - bw / 2;
              const hi = sy(d.income);
              const hs = sy(d.spend);
              const ny = mid - Math.sign(d.net) * sy(d.net);
              const lifted = hover === d.month;
              return (
                <g
                  key={d.month}
                  opacity={inPeriod.has(d.month) ? 1 : 0.38}
                  style={{
                    transition: 'opacity 150ms',
                    filter: lifted ? 'brightness(1.1)' : undefined,
                  }}
                >
                  {hi > 0 ? (
                    <path
                      d={topRounded(x, mid - hi - 1, bw, hi, 3)}
                      fill={pal.income}
                    />
                  ) : null}
                  {hs > 0 ? (
                    <path
                      d={bottomRounded(x, mid + 1, bw, hs, 3)}
                      fill={pal.spend}
                    />
                  ) : null}
                  {d.spend > top || d.income > top ? (
                    <text
                      x={cx0}
                      y={d.spend > top ? plotH - 1 : 9}
                      fontSize={9}
                      textAnchor="middle"
                      fill={pal.ink2}
                    >
                      {kmoney(d.spend > top ? -d.spend : d.income)}
                    </text>
                  ) : null}
                  <circle
                    cx={cx0}
                    cy={ny}
                    r={3.5}
                    fill={pal.ink}
                    stroke={pal.surface}
                    strokeWidth={2}
                  />
                  <rect
                    x={AXIS_W + i * band}
                    y={0}
                    width={band}
                    height={plotH}
                    fill="transparent"
                    role="button"
                    tabIndex={0}
                    className="outline-none"
                    aria-label={`${mLong(d.month)}: in ${money(d.income, false)}, out ${money(d.spend, false)}`}
                    onPointerMove={(e) => {
                      setHover(d.month);
                      show(e, tipFor(d));
                    }}
                    onFocus={(e) => {
                      setHover(d.month);
                      show(e, tipFor(d));
                    }}
                    onPointerLeave={() => {
                      setHover(null);
                      hide();
                    }}
                    onBlur={() => {
                      setHover(null);
                      hide();
                    }}
                  />
                </g>
              );
            })}
            {labels.map((l, i) =>
              l ? (
                <text
                  key={window[i]}
                  x={AXIS_W + i * band + band / 2}
                  y={height - 4}
                  fontSize={10}
                  textAnchor="middle"
                  fill={pal.ink3}
                >
                  {l}
                </text>
              ) : null,
            )}
          </svg>
        ) : (
          <div style={{ height }} />
        )}
      </div>
      <TipLayer tip={tip} width={width} />
    </div>
  );
}

export type NWRow = {
  month: string;
  total: number;
  estimated: boolean;
} & Record<string, number | string | boolean>;

export function NetWorthChart({
  rows,
  comps,
  included,
  period,
  pal,
  height = 188,
}: {
  rows: NWRow[];
  comps: { key: string; label: string }[];
  included: string[];
  period: { fromM: string; toM: string; whole: boolean };
  pal: Palette;
  height?: number;
}) {
  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart
          data={rows}
          margin={{ top: 6, right: 4, bottom: 0, left: 0 }}
        >
          <CartesianGrid vertical={false} stroke={pal.grid} />
          {!period.whole ? (
            <ReferenceArea
              x1={period.fromM}
              x2={period.toM}
              fill={pal.accent}
              fillOpacity={0.07}
              ifOverflow="extendDomain"
            />
          ) : null}
          <XAxis
            dataKey="month"
            tickFormatter={(m: string) =>
              rows.length > 24
                ? m.endsWith('-01')
                  ? m.slice(0, 4)
                  : ''
                : m.endsWith('-01')
                  ? `${mShort(m)} ’${m.slice(2, 4)}`
                  : mShort(m)
            }
            interval={rows.length > 24 ? 0 : 'preserveStartEnd'}
            minTickGap={rows.length > 24 ? 0 : 16}
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
            domain={['auto', 'auto']}
            tickCount={4}
          />
          <Tooltip
            cursor={{ stroke: pal.ink3, strokeWidth: 1 }}
            isAnimationActive={false}
            content={({ active, payload }: any) => {
              if (!active || !payload?.length) return null;
              const r = payload[0].payload as NWRow;
              return (
                <TipBox>
                  <div className={cx('mb-1 font-medium', tw.ink2)}>
                    {mLong(r.month)}
                  </div>
                  <TipRow
                    color={pal.ink}
                    label="Net worth"
                    value={money(r.total, false)}
                  />
                  <div className={cx('mt-1 border-t pt-1', tw.rule)}>
                    {comps.map((c) => (
                      <div
                        key={c.key}
                        className={
                          included.includes(c.key)
                            ? ''
                            : 'opacity-40 line-through'
                        }
                      >
                        <TipRow
                          label={c.label}
                          value={money(Number(r[c.key]), false)}
                        />
                      </div>
                    ))}
                  </div>
                  {r.estimated ? (
                    <div className={cx('mt-1 text-[10px]', tw.ink3)}>
                      Carries an older statement forward
                    </div>
                  ) : null}
                </TipBox>
              );
            }}
          />
          <Area
            type="monotone"
            dataKey="total"
            stroke={pal.ink}
            strokeWidth={2}
            fill={pal.ink}
            fillOpacity={0.06}
            isAnimationActive={false}
            activeDot={{
              r: 4,
              fill: pal.ink,
              stroke: pal.surface,
              strokeWidth: 2,
            }}
            dot={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
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

type SNode = { id: string; name: string; kind: string; color: string };
type SLink = { source: string; target: string; value: number };

export function SankeyChart({
  data,
  pal,
  colorFor,
  height = 380,
}: {
  data: SankeyData;
  pal: Palette;
  colorFor: (id: string) => string;
  height?: number;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const { host, tip, show, hide } = useTip();
  const [focus, setFocus] = useState<string | null>(null);

  const graph = useMemo(() => {
    if (width < 200) return null;
    const links = data.links.filter((l) => l.value > 0);
    const used = new Set(links.flatMap((l) => [l.source, l.target]));
    const nodes = data.nodes
      .filter((n) => used.has(n.id))
      .map((n) => ({ ...n, color: colorFor(n.id) }));
    if (!links.length) return null;
    const layout = d3Sankey<SNode, SLink>()
      .nodeId((d) => d.id)
      .nodeWidth(8)
      .nodePadding(9)
      .nodeAlign(sankeyJustify)
      .extent([
        [156, 6],
        [width - 168, height - 6],
      ]);
    return layout({
      nodes: nodes.map((n) => ({ ...n })),
      links: links.map((l) => ({ ...l })),
    });
  }, [data, width, height, colorFor]);

  const income = graph?.nodes.find((n) => n.id === 'all')?.value ?? 0;
  const path = sankeyLinkHorizontal<SNode, SLink>();
  const nodeOf = (n: SankeyNode<SNode, SLink> | string | number) =>
    n as SankeyNode<SNode, SLink>;
  const touches = (l: SankeyLink<SNode, SLink>) =>
    !focus ||
    nodeOf(l.source).id === focus ||
    nodeOf(l.target).id === focus ||
    `${nodeOf(l.source).id}→${nodeOf(l.target).id}` === focus;

  return (
    <div ref={host} className="relative">
      <div ref={ref} style={{ height }} className="w-full">
        {graph ? (
          <svg
            width={width}
            height={height}
            role="img"
            aria-label="Income to category flows"
          >
            <g fill="none">
              {graph.links.map((l) => {
                const s = nodeOf(l.source);
                const t = nodeOf(l.target);
                const key = `${s.id}→${t.id}`;
                const color = s.kind === 'source' ? pal.ink3 : t.color;
                const on = touches(l);
                return (
                  <path
                    key={key}
                    d={path(l) ?? ''}
                    stroke={color}
                    strokeWidth={Math.max(1, l.width ?? 1)}
                    strokeOpacity={focus ? (on ? 0.5 : 0.08) : 0.26}
                    style={{ transition: 'stroke-opacity 120ms' }}
                    onPointerMove={(e) => {
                      setFocus(key);
                      show(
                        e,
                        <>
                          <div className={cx('mb-1 font-medium', tw.ink2)}>
                            {s.name} → {t.name}
                          </div>
                          <TipRow
                            color={color}
                            label="Flow"
                            value={money(l.value, false)}
                          />
                          {income ? (
                            <TipRow
                              label="Of income"
                              value={pct(l.value / income, 1)}
                            />
                          ) : null}
                        </>,
                      );
                    }}
                    onPointerLeave={() => {
                      setFocus(null);
                      hide();
                    }}
                  />
                );
              })}
            </g>
            {graph.nodes.map((n) => {
              const x0 = n.x0 ?? 0;
              const x1 = n.x1 ?? 0;
              const y0 = n.y0 ?? 0;
              const y1 = n.y1 ?? 0;
              const h = y1 - y0;
              const left = n.kind === 'source';
              const showLabel = h >= 7 || n.kind !== 'leaf';
              return (
                <g
                  key={n.id}
                  onPointerMove={(e) => {
                    setFocus(n.id);
                    show(
                      e,
                      <>
                        <div className={cx('mb-1 font-medium', tw.ink2)}>
                          {n.name}
                        </div>
                        <TipRow
                          color={n.color}
                          shape="rect"
                          label="Total"
                          value={money(n.value ?? 0, false)}
                        />
                        {income && n.id !== 'all' ? (
                          <TipRow
                            label="Of income"
                            value={pct((n.value ?? 0) / income, 1)}
                          />
                        ) : null}
                      </>,
                    );
                  }}
                  onPointerLeave={() => {
                    setFocus(null);
                    hide();
                  }}
                >
                  <rect
                    x={x0}
                    y={y0}
                    width={x1 - x0}
                    height={Math.max(1, h)}
                    rx={1.5}
                    fill={n.color}
                  />
                  {showLabel ? (
                    <text
                      x={left ? x0 - 6 : x1 + 6}
                      y={(y0 + y1) / 2}
                      dy="0.35em"
                      textAnchor={left ? 'end' : 'start'}
                      fontSize={11}
                      fill={pal.ink}
                      stroke={pal.surface}
                      strokeWidth={3}
                      paintOrder="stroke"
                      strokeLinejoin="round"
                    >
                      {n.name}
                      <tspan fill={pal.ink3} dx={6} className="tabular-nums">
                        {kmoney(n.value ?? 0)}
                      </tspan>
                    </text>
                  ) : null}
                </g>
              );
            })}
          </svg>
        ) : (
          <div
            className={cx(
              'flex h-full items-center justify-center text-[12px]',
              tw.ink3,
            )}
          >
            No income or spend in this slice.
          </div>
        )}
      </div>
      <TipLayer tip={tip} width={width} />
    </div>
  );
}
