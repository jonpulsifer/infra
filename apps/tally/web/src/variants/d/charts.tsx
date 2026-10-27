import {
  sankey as d3Sankey,
  type SankeyLink,
  type SankeyNode,
  sankeyJustify,
  sankeyLinkHorizontal,
} from 'd3-sankey';
import { curveMonotoneX, line } from 'd3-shape';
import { useMemo, useState } from 'react';
import type { SankeyData } from '~/fixtures/derive';
import { mLong, mShort } from '~/variants/a/charts';
import { niceTicks } from '~/variants/b/bits';
import { Finding, TipLayer, TipRow, useTip, useWidth } from './bits';
import { type FlowEnd, type FlowFocus, flowSentence } from './prose';
import { CAT_ORDER, cx, kmoney, money, type Palette, pct, tw } from './theme';

export { mLong, mShort, Sparkline } from '~/variants/a/charts';

const AXIS_W = 44;
const X_BAND = 18;

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
  if (window.length > 24)
    return window.map((m) => (m.endsWith('-01') ? m.slice(0, 4) : ''));
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

/** Spread label centres at least `gap` apart inside [lo, hi], keeping order. */
function spread(ys: number[], gap: number, lo: number, hi: number) {
  const idx = ys.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y);
  for (let k = 1; k < idx.length; k++)
    idx[k].y = Math.max(idx[k].y, idx[k - 1].y + gap);
  const over = idx.length ? idx[idx.length - 1].y - hi : 0;
  if (over > 0) for (const p of idx) p.y -= over;
  for (let k = idx.length - 2; k >= 0; k--)
    idx[k].y = Math.min(idx[k].y, idx[k + 1].y - gap);
  if (idx.length && idx[0].y < lo) {
    const d = lo - idx[0].y;
    for (const p of idx) p.y += d;
  }
  const out = [...ys];
  for (const p of idx) out[p.i] = p.y;
  return out;
}

// Net worth: one line, hollow where a month carries an old statement ---------

export type NWRow = {
  month: string;
  total: number;
  estimated: boolean;
} & Record<string, number | string | boolean>;

export function NetWorthLine({
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
  const [ref, width] = useWidth<HTMLDivElement>();
  const { host, tip, show, hide } = useTip();
  const [hover, setHover] = useState<number | null>(null);
  const n = rows.length;
  const gutter = width >= 360 ? 62 : 10;
  const plotW = Math.max(10, width - AXIS_W - gutter);
  const plotH = height - X_BAND;
  const step = n > 1 ? plotW / (n - 1) : plotW;
  const x = (i: number) => AXIS_W + (n > 1 ? i * step : plotW / 2);
  const vals = rows.map((r) => r.total);
  const ticks = niceTicks(Math.min(...vals), Math.max(...vals), 4);
  const t0 = ticks[0];
  const t1 = ticks[ticks.length - 1];
  const y = (v: number) => 6 + (1 - (v - t0) / (t1 - t0 || 1)) * (plotH - 10);
  const path =
    line<NWRow>()
      .x((_, i) => x(i))
      .y((d) => y(d.total))
      .curve(curveMonotoneX)(rows) ?? '';
  const area = n ? `${path}L${x(n - 1)},${plotH}L${x(0)},${plotH}Z` : '';
  const months = rows.map((r) => r.month);
  const labels = xLabels(months, plotW);
  const r = step >= 12 ? 3.5 : step >= 6 ? 2.5 : 0;
  const a = months.indexOf(period.fromM);
  const b = months.indexOf(period.toM);
  const last = rows[n - 1];

  const tipFor = (row: NWRow) => (
    <>
      <div className={cx('mb-1 font-medium', tw.ink2)}>{mLong(row.month)}</div>
      <TipRow
        color={pal.ink}
        label="Net worth"
        value={`${money(row.total, false)}${row.estimated ? ' †' : ''}`}
      />
      <div className={cx('mt-1 border-t pt-1', tw.rule)}>
        {comps.map((c) => (
          <div
            key={c.key}
            className={
              included.includes(c.key) ? '' : 'opacity-40 line-through'
            }
          >
            <TipRow label={c.label} value={money(Number(row[c.key]), false)} />
          </div>
        ))}
      </div>
      <div className={cx('mt-1 text-[10px]', tw.ink3)}>
        {row.estimated
          ? '† Carries an older statement forward'
          : 'Every component from a statement this month'}
      </div>
    </>
  );

  return (
    <div ref={host} className="relative">
      <div ref={ref} className="w-full">
        {width > 0 && n ? (
          <svg
            width={width}
            height={height}
            role="img"
            aria-label={`Net worth by month, ending at ${money(last.total, false)}`}
            onPointerLeave={() => {
              setHover(null);
              hide();
            }}
          >
            {!period.whole && a >= 0 && b >= 0 ? (
              <rect
                x={a === b ? x(a) - step / 2 : x(a)}
                y={0}
                width={a === b ? step : x(b) - x(a)}
                height={plotH}
                fill={pal.accent}
                opacity={0.07}
              />
            ) : null}
            {ticks.map((t) => (
              <g key={t}>
                <line
                  x1={AXIS_W}
                  x2={AXIS_W + plotW}
                  y1={y(t)}
                  y2={y(t)}
                  stroke={pal.grid}
                  shapeRendering="crispEdges"
                />
                <text
                  x={AXIS_W - 8}
                  y={y(t)}
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
            <line
              x1={AXIS_W}
              x2={AXIS_W + plotW}
              y1={plotH}
              y2={plotH}
              stroke={pal.axis}
              shapeRendering="crispEdges"
            />
            <path d={area} fill={pal.ink} opacity={0.05} />
            <path
              d={path}
              fill="none"
              stroke={pal.ink}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
            {rows.map((row, i) => {
              const isLast = i === n - 1;
              const rr = isLast || hover === i ? 4 : r;
              if (!rr) return null;
              return (
                <circle
                  key={row.month}
                  cx={x(i)}
                  cy={y(row.total)}
                  r={rr}
                  fill={row.estimated ? pal.surface : pal.ink}
                  stroke={row.estimated ? pal.ink : pal.surface}
                  strokeWidth={row.estimated ? 1.5 : 2}
                />
              );
            })}
            {gutter > 20 ? (
              <text
                x={x(n - 1) + 9}
                y={y(last.total)}
                fontSize={11}
                fill={pal.ink}
                className="tabular-nums"
              >
                <tspan dy="-0.1em" fontWeight={600}>
                  {kmoney(last.total)}
                  {last.estimated ? '†' : ''}
                </tspan>
                <tspan
                  x={x(n - 1) + 9}
                  dy="1.15em"
                  fontSize={10}
                  fill={pal.ink3}
                >
                  {mShort(last.month)}
                </tspan>
              </text>
            ) : null}
            {hover != null ? (
              <line
                x1={x(hover)}
                x2={x(hover)}
                y1={0}
                y2={plotH}
                stroke={pal.ink3}
                shapeRendering="crispEdges"
              />
            ) : null}
            {labels.map((l, i) =>
              l ? (
                <text
                  key={months[i]}
                  x={x(i)}
                  y={height - 4}
                  fontSize={10}
                  textAnchor={i === 0 ? 'start' : 'middle'}
                  fill={pal.ink3}
                >
                  {l}
                </text>
              ) : null,
            )}
            <rect
              x={AXIS_W - step / 2}
              y={0}
              width={plotW + step}
              height={plotH}
              fill="transparent"
              onPointerMove={(e) => {
                const box = e.currentTarget.getBoundingClientRect();
                const i = Math.max(
                  0,
                  Math.min(
                    n - 1,
                    Math.round((e.clientX - box.left - step / 2) / step),
                  ),
                );
                setHover(i);
                show(e, tipFor(rows[i]));
              }}
            />
          </svg>
        ) : (
          <div style={{ height }} />
        )}
      </div>
      <TipLayer tip={tip} width={width} />
    </div>
  );
}

// Spend by category: stacked columns, names at the last column's end ----------

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
  const gutter = width >= 420 ? 108 : 0;
  const plotW = Math.max(0, width - AXIS_W - gutter);
  const band = plotW / Math.max(1, window.length);
  const bw = Math.max(2, Math.min(24, band * 0.68));
  const sy = (v: number) => (v / top) * (plotH - 6);
  const labels = xLabels(window, plotW);

  const segsFor = (m: string, total: number) => {
    const clipped = total > top;
    let acc = plotH;
    return keys
      .map((k) => ({ k, v: val(m, k) }))
      .filter((s) => s.v > 0)
      .map((s) => {
        const h = clipped ? (s.v / total) * (plotH - 6) : sy(s.v);
        const y0 = acc - h;
        acc = y0;
        return { ...s, y0, h };
      });
  };

  const lastI = window.length - 1;
  const lastM = window[lastI];
  const lastSegs = lastM ? segsFor(lastM, totals[lastI]) : [];
  const endX = AXIS_W + lastI * band + (band + bw) / 2;
  const labelYs = spread(
    lastSegs.map((s) => s.y0 + s.h / 2),
    12,
    6,
    plotH - 4,
  );

  const monthTip = (m: string, k: string | null) => {
    const total = keys.reduce((s, kk) => s + val(m, kk), 0);
    return (
      <>
        <div className={cx('mb-1 font-medium', tw.ink2)}>{mLong(m)}</div>
        {[...keys].reverse().map((kk) => (
          <div
            key={kk}
            className={cx(
              '-mx-1 rounded-[2px] px-1',
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
                  x2={AXIS_W + plotW}
                  y1={plotH - sy(t)}
                  y2={plotH - sy(t)}
                  stroke={t === 0 ? pal.axis : pal.grid}
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
              const total = totals[i];
              const clipped = total > top;
              const segs = segsFor(m, total);
              return (
                <g
                  key={m}
                  opacity={inPeriod.has(m) ? 1 : 0.38}
                  style={{ transition: 'opacity 150ms' }}
                >
                  {segs.map((s, j) => {
                    const lastSeg = j === segs.length - 1;
                    const gap = lastSeg ? 0 : 2;
                    const hh = Math.max(0, s.h - gap);
                    const lift = hover?.m === m && hover?.k === s.k;
                    const style = lift
                      ? { filter: 'brightness(1.15)' }
                      : undefined;
                    return lastSeg ? (
                      <path
                        key={s.k}
                        d={topRounded(x, s.y0, bw, hh, 3)}
                        fill={pal.cat[s.k]}
                        style={style}
                      />
                    ) : (
                      <rect
                        key={s.k}
                        x={x}
                        y={s.y0 + gap}
                        width={bw}
                        height={hh}
                        fill={pal.cat[s.k]}
                        style={style}
                      />
                    );
                  })}
                  {clipped ? (
                    <>
                      <path
                        d={`M${x - 2},18l${bw + 4},-5M${x - 2},23l${bw + 4},-5`}
                        stroke={pal.surface}
                        strokeWidth={2.5}
                      />
                      <text
                        x={x + bw / 2}
                        y={8}
                        fontSize={9}
                        textAnchor="middle"
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
                      const hit =
                        segs.find((s) => ry >= s.y0 && ry <= s.y0 + s.h)?.k ??
                        null;
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
            {gutter
              ? lastSegs.map((s, j) => {
                  const ly = labelYs[j];
                  const cy = s.y0 + s.h / 2;
                  const lx = endX + 14;
                  return (
                    <g key={s.k} pointerEvents="none">
                      <path
                        d={`M${endX + 2},${cy}L${endX + 7},${cy}L${lx - 3},${ly}`}
                        fill="none"
                        stroke={pal.cat[s.k]}
                        strokeWidth={1.5}
                      />
                      <text
                        x={lx}
                        y={ly}
                        dy="0.32em"
                        fontSize={10}
                        fill={pal.ink2}
                      >
                        {names[s.k] ?? s.k}
                        <tspan dx={4} fill={pal.ink3} className="tabular-nums">
                          {kmoney(Math.round(s.v))}
                        </tspan>
                      </text>
                    </g>
                  );
                })
              : null}
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

// Cash flow: income up, spend down, net as a dot; names at the last pair -----

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
  const gutter = width >= 300 ? 34 : 0;
  const plotW = Math.max(0, width - AXIS_W - gutter);
  const band = plotW / Math.max(1, window.length);
  const bw = Math.max(2, Math.min(16, band * 0.5));
  const sy = (v: number) => (Math.min(Math.abs(v), top) / top) * half;
  const labels = xLabels(window, plotW);

  const end = data[data.length - 1];
  const endX = AXIS_W + plotW + 6;
  const endLabels = end
    ? (() => {
        const ys = spread(
          [
            mid - sy(end.income) / 2 - 1,
            mid + sy(end.spend) / 2 + 1,
            mid - Math.sign(end.net) * sy(end.net),
          ],
          11,
          6,
          plotH - 4,
        );
        return [
          { k: 'in', y: ys[0] },
          { k: 'out', y: ys[1] },
          { k: 'net', y: ys[2] },
        ];
      })()
    : [];

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
                  x2={AXIS_W + plotW}
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
              return (
                <g
                  key={d.month}
                  opacity={inPeriod.has(d.month) ? 1 : 0.38}
                  style={{
                    transition: 'opacity 150ms',
                    filter: hover === d.month ? 'brightness(1.1)' : undefined,
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
            {gutter
              ? endLabels.map((l) => (
                  <text
                    key={l.k}
                    x={endX}
                    y={l.y}
                    dy="0.32em"
                    fontSize={10}
                    fill={l.k === 'net' ? pal.ink : pal.ink3}
                    fontWeight={l.k === 'net' ? 600 : 400}
                    pointerEvents="none"
                  >
                    {l.k}
                  </text>
                ))
              : null}
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

// Sankey: hover follows a ribbon and the sentence above says what it means ---

type SNode = { id: string; name: string; kind: string; color: string };
type SLink = { source: string; target: string; value: number };
type GN = SankeyNode<SNode, SLink>;
type GL = SankeyLink<SNode, SLink>;

const nodeOf = (n: GN | string | number) => n as GN;

function endOf(n: GN): FlowEnd {
  const kids = (n.sourceLinks ?? [])
    .map((l) => nodeOf(l.target))
    .filter((t) => t.kind === 'leaf')
    .map((t) => ({ name: t.name, value: t.value ?? 0 }))
    .sort((a, b) => b.value - a.value);
  const up = (n.targetLinks ?? [])
    .map((l) => nodeOf(l.source))
    .find((s) => s.kind === 'group' && s.id !== 'all');
  return {
    id: n.id,
    name: n.name,
    kind: n.kind,
    value: n.value ?? 0,
    children: n.kind === 'group' ? kids : [],
    parent: up ? { name: up.name, value: up.value ?? 0 } : null,
  };
}

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
  const [focus, setFocus] = useState<string | null>(null);

  const graph = useMemo(() => {
    if (width < 200) return null;
    const links = data.links.filter((l) => l.value > 0);
    const used = new Set(links.flatMap((l) => [l.source, l.target]));
    const nodes = data.nodes
      .filter((n) => used.has(n.id))
      .map((n) => ({ ...n, color: colorFor(n.id) }));
    if (!links.length) return null;
    const narrow = width < 760;
    return d3Sankey<SNode, SLink>()
      .nodeId((d) => d.id)
      .nodeWidth(8)
      .nodePadding(9)
      .nodeAlign(sankeyJustify)
      .extent([
        [narrow ? 112 : 156, 6],
        [width - (narrow ? 124 : 168), height - 6],
      ])({
      nodes: nodes.map((n) => ({ ...n })),
      links: links.map((l) => ({ ...l })),
    });
  }, [data, width, height, colorFor]);

  const income = graph?.nodes.find((n) => n.id === 'all')?.value ?? 0;
  const path = sankeyLinkHorizontal<SNode, SLink>();
  const key = (l: GL) => `${nodeOf(l.source).id}→${nodeOf(l.target).id}`;

  const focusLink = graph?.links.find((l) => key(l) === focus) ?? null;
  const focusNode = focusLink
    ? null
    : (graph?.nodes.find((n) => n.id === focus) ?? null);

  const lit = (l: GL) => {
    if (!focus) return null;
    const s = nodeOf(l.source);
    const t = nodeOf(l.target);
    if (focusNode) return s.id === focusNode.id || t.id === focusNode.id;
    if (!focusLink) return false;
    const fs = nodeOf(focusLink.source);
    const ft = nodeOf(focusLink.target);
    if (l === focusLink) return true;
    if (ft.kind === 'group' && ft.id !== 'all' && s.id === ft.id) return true;
    if (fs.kind === 'group' && fs.id !== 'all' && t.id === fs.id) return true;
    return false;
  };

  const flow: FlowFocus | null = focusLink
    ? {
        kind: 'link',
        source: endOf(nodeOf(focusLink.source)),
        target: endOf(nodeOf(focusLink.target)),
        value: focusLink.value,
      }
    : focusNode
      ? { kind: 'node', node: endOf(focusNode) }
      : null;

  const groups = (graph?.nodes ?? [])
    .filter((n) => n.kind === 'group' && n.id !== 'all')
    .map(endOf);
  const saved = graph?.nodes.find((n) => n.id === 'leaf:saved')?.value ?? 0;
  const drawn = graph?.nodes.find((n) => n.id === 'src:drawdown')?.value ?? 0;
  const litNodes = new Set<string>();
  if (graph && focus)
    for (const l of graph.links)
      if (lit(l)) {
        litNodes.add(nodeOf(l.source).id);
        litNodes.add(nodeOf(l.target).id);
      }

  return (
    <div>
      <Finding>
        {graph
          ? flowSentence(flow, { income, groups, saved, drawn })
          : 'No income or spend in this slice.'}
      </Finding>
      <div ref={ref} style={{ height }} className="w-full">
        {graph ? (
          <svg
            width={width}
            height={height}
            role="img"
            aria-label="Income to category flows"
            onPointerLeave={() => setFocus(null)}
          >
            <g fill="none">
              {graph.links.map((l) => {
                const s = nodeOf(l.source);
                const t = nodeOf(l.target);
                const k = key(l);
                const color = s.kind === 'source' ? pal.ink3 : t.color;
                const on = lit(l);
                const loud = t.id === 'leaf:saved' || s.id === 'src:drawdown';
                return (
                  <path
                    key={k}
                    d={path(l) ?? ''}
                    stroke={color}
                    strokeWidth={Math.max(1, l.width ?? 1)}
                    strokeOpacity={
                      on === null ? (loud ? 0.55 : 0.26) : on ? 0.6 : 0.06
                    }
                    style={{ transition: 'stroke-opacity 140ms' }}
                    onPointerEnter={() => setFocus(k)}
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
              const dim = focus && !litNodes.has(n.id);
              const saved = n.id === 'leaf:saved';
              return (
                <g
                  key={n.id}
                  opacity={dim ? 0.35 : 1}
                  style={{ transition: 'opacity 140ms' }}
                  onPointerEnter={() => setFocus(n.id)}
                >
                  <rect
                    x={x0}
                    y={y0}
                    width={x1 - x0}
                    height={Math.max(1, h)}
                    rx={1.5}
                    fill={n.color}
                  />
                  <rect
                    x={x0 - 6}
                    y={y0 - 2}
                    width={x1 - x0 + 12}
                    height={Math.max(8, h + 4)}
                    fill="transparent"
                  />
                  {showLabel ? (
                    <text
                      x={left ? x0 - 6 : x1 + 6}
                      y={(y0 + y1) / 2}
                      dy="0.35em"
                      textAnchor={left ? 'end' : 'start'}
                      fontSize={11}
                      fontWeight={saved ? 600 : 400}
                      fill={pal.ink}
                      stroke={pal.surface}
                      strokeWidth={3}
                      paintOrder="stroke"
                      strokeLinejoin="round"
                    >
                      {n.name}
                      <tspan fill={pal.ink3} dx={6} className="tabular-nums">
                        {kmoney(n.value ?? 0)}
                        {saved && income
                          ? ` · ${pct((n.value ?? 0) / income)}`
                          : ''}
                      </tspan>
                    </text>
                  ) : null}
                </g>
              );
            })}
          </svg>
        ) : null}
      </div>
    </div>
  );
}
