import {
  area,
  curveMonotoneX,
  line,
  type SeriesPoint,
  stack,
  stackOffsetDiverging,
} from 'd3-shape';
import { ArrowUp } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import type { NetWorthPoint } from '~/fixtures/derive';
import type { Ledger } from '~/fixtures/types';
import { TipLayer, TipRow, useTip, useWidth } from './bits';
import { mLong, mShort, Sparkline } from './charts';
import { cx, kmoney, money, type Palette, shortDate, tw } from './theme';

export const COMPS = [
  { key: 'house', label: 'House' },
  { key: 'investments', label: 'Investments' },
  { key: 'cash', label: 'Cash & credit' },
  { key: 'mortgage', label: 'Mortgage' },
] as const;

type CompKey = (typeof COMPS)[number]['key'];

/** Why a month's net worth is an estimate, as a clause. */
export function carryNote(ledger: Ledger, month: string) {
  const end = `${month}-31`;
  const bits: string[] = [];
  const stale = ledger.accounts
    .filter((a) => a.kind === 'investment')
    .map(
      (a) =>
        ledger.holdings
          .filter((h) => h.accountId === a.id && h.date <= end)
          .slice(-1)[0],
    )
    .filter((h) => h && h.date.slice(0, 7) !== month)
    .map((h) => h.date)
    .sort();
  if (stale.length)
    bits.push(
      `holdings carry the ${shortDate(stale[stale.length - 1])} statement forward`,
    );
  const val = ledger.valuations.filter((v) => v.date <= end).slice(-1)[0];
  if (val && val.date.slice(0, 7) !== month)
    bits.push(`the house is the ${mLong(val.date.slice(0, 7))} ${val.source}`);
  return bits.join('; ');
}

export type HeroStat = { label: string; value: string; sub: ReactNode };

export function HeroBand({
  kicker,
  figure,
  estimated,
  lines,
  stats,
  chart,
  footnote,
}: {
  kicker: ReactNode;
  figure: string;
  estimated: boolean;
  lines: [ReactNode, ReactNode];
  stats: HeroStat[];
  chart: ReactNode;
  footnote: ReactNode;
}) {
  return (
    <section className={cx('px-5 pt-7 pb-4', tw.surface)}>
      <div className={cx(tw.label, tw.ink3)}>{kicker}</div>
      <div className="mt-3 flex flex-wrap items-end gap-x-12 gap-y-5">
        <div
          className={cx(
            tw.serif,
            'text-[64px] leading-[0.86] font-normal tracking-[-0.035em] tabular-nums sm:text-[88px] xl:text-[108px]',
            tw.ink,
          )}
        >
          {figure}
          {estimated ? (
            <sup
              className={cx(
                'ml-1 align-super text-[0.3em] tracking-normal',
                tw.ink3,
              )}
            >
              †
            </sup>
          ) : null}
        </div>
        <div className="min-w-[300px] flex-1 pb-1.5">
          <p
            className={cx(
              'max-w-[640px] text-[16px] leading-[1.5] text-pretty',
              tw.ink2,
            )}
          >
            <span className={cx('block', tw.ink)}>{lines[0]}</span>
            <span className="block">{lines[1]}</span>
          </p>
          <dl
            className={cx(
              'mt-3 grid max-w-[640px] grid-cols-4 border-t pt-2',
              tw.rule,
            )}
          >
            {stats.map((s, i) => (
              <div
                key={s.label}
                className={cx('min-w-0', i > 0 && 'border-l pl-3', tw.rule)}
              >
                <dt className={cx(tw.label, tw.ink3)}>{s.label}</dt>
                <dd className={cx('text-[15px] leading-6', tw.num, tw.ink)}>
                  {s.value}
                </dd>
                <dd className={cx('truncate text-[11px]', tw.ink3)}>{s.sub}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
      <div className="mt-6">{chart}</div>
      <p className={cx('mt-2 text-[11.5px] leading-4', tw.ink3)}>{footnote}</p>
    </section>
  );
}

/** Diverging stacked composition with the total as a line; names sit at the right edge, so no legend. */
export function CompositionChart({
  points,
  period,
  pal,
  height = 280,
}: {
  points: NetWorthPoint[];
  period: { fromM: string; toM: string; whole: boolean };
  pal: Palette;
  height?: number;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const { host, tip, show, hide } = useTip();
  const [hover, setHover] = useState<number | null>(null);
  const compact = width < 640;
  const m = { t: 10, r: compact ? 12 : 176, b: 22, l: 52 };
  const n = points.length;
  const series = stack<NetWorthPoint, CompKey>()
    .keys(COMPS.map((c) => c.key))
    .value((d, k) => d[k])
    .offset(stackOffsetDiverging)(points);
  const lo = Math.min(0, ...series.flatMap((s) => s.map((p) => p[0])));
  const hi = Math.max(0, ...series.flatMap((s) => s.map((p) => p[1])));
  const ticks = niceTicks(lo, hi, 4);
  const t0 = ticks[0];
  const t1 = ticks[ticks.length - 1];
  const innerW = Math.max(10, width - m.l - m.r);
  const step = n > 1 ? innerW / (n - 1) : innerW;
  const x = (i: number) => m.l + i * step;
  const y = (v: number) =>
    height - m.b - ((v - t0) / (t1 - t0 || 1)) * (height - m.t - m.b);

  const areaGen = area<SeriesPoint<NetWorthPoint>>()
    .x((_, i) => x(i))
    .y0((d) => y(d[0]))
    .y1((d) => y(d[1]))
    .curve(curveMonotoneX);
  const outer = (s: (typeof series)[number]) =>
    line<SeriesPoint<NetWorthPoint>>()
      .x((_, i) => x(i))
      .y((d) => (d[1] <= 0 ? y(d[0]) : y(d[1])))
      .curve(curveMonotoneX)(s);
  const total = line<NetWorthPoint>()
    .x((_, i) => x(i))
    .y((d) => y(d.total))
    .curve(curveMonotoneX);

  const last = n - 1;
  const labels = series
    .map((s) => {
      const p = s[last];
      const c = COMPS.find((k) => k.key === s.key)!;
      const mid = p ? (y(p[0]) + y(p[1])) / 2 : 0;
      return {
        key: s.key,
        label: c.label,
        value: points[last]?.[s.key] ?? 0,
        anchor: mid,
        at: mid,
      };
    })
    .filter((l) => Math.abs(l.value) > 0)
    .sort((a, b) => a.anchor - b.anchor);
  for (let i = 1; i < labels.length; i++)
    labels[i].at = Math.max(labels[i].at, labels[i - 1].at + 32);
  const over = labels.length
    ? labels[labels.length - 1].at - (height - m.b - 6)
    : 0;
  if (over > 0) for (const l of labels) l.at -= over;

  const months = points.map((p) => p.month);
  const fromI = months.indexOf(period.fromM);
  const toI = months.indexOf(period.toM);
  const every = Math.max(1, Math.ceil(n / Math.max(3, innerW / 70)));
  const hp = hover == null ? null : points[hover];

  const tipFor = (p: NetWorthPoint) => (
    <>
      <div className={cx('mb-1 font-medium', tw.ink2)}>{mLong(p.month)}</div>
      <TipRow color={pal.ink} label="Net worth" value={money(p.total, false)} />
      <div className={cx('mt-1 border-t pt-1', tw.rule)}>
        {COMPS.map((c) => (
          <TipRow
            key={c.key}
            color={pal.comp[c.key]}
            shape="rect"
            label={c.label}
            value={money(p[c.key], false)}
          />
        ))}
      </div>
      <div className={cx('mt-1 text-[10px]', tw.ink3)}>
        {p.estimated
          ? '† Carries an older statement forward'
          : 'Every component from this month'}
      </div>
    </>
  );

  return (
    <div ref={host} className="relative">
      <div ref={ref} className="w-full" style={{ height }}>
        {width > 0 && n > 1 ? (
          <svg
            width={width}
            height={height}
            role="img"
            aria-label="Net worth by month, stacked as house, investments, cash and mortgage, with the total as a line"
            className="block overflow-visible"
          >
            {!period.whole && fromI >= 0 && toI >= 0 ? (
              <rect
                x={x(fromI)}
                y={m.t}
                width={Math.max(2, x(toI) - x(fromI))}
                height={height - m.t - m.b}
                fill={pal.accent}
                fillOpacity={0.035}
              />
            ) : null}
            {ticks.map((t) => (
              <g key={t}>
                <line
                  x1={m.l}
                  x2={m.l + innerW}
                  y1={y(t)}
                  y2={y(t)}
                  stroke={t === 0 ? pal.axis : pal.grid}
                  shapeRendering="crispEdges"
                />
                <text
                  x={m.l - 8}
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
            {series.map((s) => (
              <g key={s.key}>
                <path
                  d={areaGen(s) ?? ''}
                  fill={pal.comp[s.key]}
                  fillOpacity={0.17}
                />
                <path
                  d={outer(s) ?? ''}
                  fill="none"
                  stroke={pal.comp[s.key]}
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
                    strokeWidth={p.estimated ? 1.25 : 1.5}
                  />
                ))
              : null}
            {months.map((mo, i) =>
              (last - i) % every === 0 ? (
                <text
                  key={mo}
                  x={x(i)}
                  y={height - 6}
                  fontSize={10}
                  textAnchor={i === 0 ? 'start' : i === last ? 'end' : 'middle'}
                  fill={pal.ink3}
                >
                  {mo.endsWith('-01') || i === 0 || n > 24
                    ? `${mShort(mo)} ’${mo.slice(2, 4)}`
                    : mShort(mo)}
                </text>
              ) : null,
            )}
            {!compact
              ? labels.map((l) => (
                  <g key={l.key}>
                    {Math.abs(l.at - l.anchor) > 2 ? (
                      <path
                        d={`M${x(last) + 5},${l.anchor}C${x(last) + 14},${l.anchor} ${x(last) + 9},${l.at} ${x(last) + 20},${l.at}`}
                        fill="none"
                        stroke={pal.axis}
                      />
                    ) : null}
                    <rect
                      x={x(last) + 22}
                      y={l.at - 12}
                      width={3}
                      height={24}
                      rx={1.5}
                      fill={pal.comp[l.key]}
                    />
                    <text
                      x={x(last) + 32}
                      y={l.at - 2}
                      fontSize={11}
                      fill={pal.ink2}
                    >
                      {l.label}
                    </text>
                    <text
                      x={x(last) + 32}
                      y={l.at + 12}
                      fontSize={12}
                      fontWeight={600}
                      fill={pal.ink}
                      className="font-mono tabular-nums"
                    >
                      {money(l.value, false)}
                    </text>
                  </g>
                ))
              : null}
            {hp && hover != null ? (
              <>
                <line
                  x1={x(hover)}
                  x2={x(hover)}
                  y1={m.t}
                  y2={height - m.b}
                  stroke={pal.ink3}
                  shapeRendering="crispEdges"
                />
                <circle
                  cx={x(hover)}
                  cy={y(hp.total)}
                  r={4.5}
                  fill={pal.ink}
                  stroke={pal.surface}
                  strokeWidth={2}
                />
              </>
            ) : null}
            <rect
              x={m.l - step / 2}
              y={m.t}
              width={innerW + step}
              height={height - m.t - m.b}
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
                show(e, tipFor(points[i]));
              }}
              onPointerLeave={() => {
                setHover(null);
                hide();
              }}
            />
          </svg>
        ) : null}
      </div>
      {compact ? (
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
          {COMPS.map((c) => (
            <span key={c.key} className={cx('inline-flex gap-1.5', tw.ink2)}>
              <span
                className="mt-[3px] h-2.5 w-[3px] rounded-full"
                style={{ background: pal.comp[c.key] }}
              />
              {c.label}
              <span className={cx(tw.num, tw.ink)}>
                {kmoney(points[last]?.[c.key] ?? 0)}
              </span>
            </span>
          ))}
        </div>
      ) : null}
      <TipLayer tip={tip} width={width} />
    </div>
  );
}

function niceTicks(min: number, max: number, count: number) {
  const span = max - min || Math.abs(max) || 1;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step =
    [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => span / s <= count) ??
    10 * mag;
  const out: number[] = [];
  for (
    let v = Math.floor(min / step) * step;
    v <= Math.ceil(max / step) * step + step / 2;
    v += step
  )
    out.push(Math.round(v));
  return out;
}

/** The hero folded to one 40px line once you scroll past it. */
export function Ticker({
  shown,
  figure,
  estimated,
  delta,
  stats,
  spark,
  pal,
  onTop,
}: {
  shown: boolean;
  figure: string;
  estimated: boolean;
  delta: ReactNode;
  stats: HeroStat[];
  spark: number[];
  pal: Palette;
  onTop: () => void;
}) {
  return (
    <div className="sticky top-0 z-30 h-0">
      <div
        aria-hidden={!shown}
        className={cx(
          'absolute inset-x-0 top-0 flex h-10 items-center border-b backdrop-blur-md transition-[transform,opacity] duration-200 ease-out',
          'bg-[#fcfcfb]/92 dark:bg-[#141413]/92',
          tw.rule,
          shown
            ? 'translate-y-0 opacity-100'
            : 'pointer-events-none -translate-y-full opacity-0',
        )}
      >
        <div className="flex h-full items-center gap-2.5 pr-3 pl-5">
          <span className={cx(tw.label, tw.ink3)}>Net worth</span>
          <span
            className={cx(
              tw.serif,
              'text-[20px] leading-none tabular-nums',
              tw.ink,
            )}
          >
            {figure}
            {estimated ? (
              <sup className={cx('ml-0.5 text-[10px]', tw.ink3)}>†</sup>
            ) : null}
          </span>
          <span className="text-[11px]">{delta}</span>
          <Sparkline values={spark} width={72} height={20} color={pal.ink2} />
        </div>
        {stats.map((s) => (
          <div
            key={s.label}
            className={cx(
              'hidden h-full items-center gap-2 border-l px-3 text-[12px] md:flex',
              tw.rule,
            )}
          >
            <span className={cx(tw.label, tw.ink3)}>{s.label}</span>
            <span className={cx(tw.num, tw.ink)}>{s.value}</span>
            <span className={cx('hidden text-[11px] xl:inline', tw.ink3)}>
              {s.sub}
            </span>
          </div>
        ))}
        <button
          type="button"
          tabIndex={shown ? 0 : -1}
          onClick={onTop}
          className={cx(
            'ml-auto mr-2 inline-flex h-6 items-center gap-1 rounded-[3px] px-2 text-[11px]',
            tw.ink3,
            tw.hover,
          )}
        >
          <ArrowUp size={11} /> Hero
        </button>
      </div>
    </div>
  );
}
