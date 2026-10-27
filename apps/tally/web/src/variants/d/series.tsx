// Desk's account-history chart, with each series named at its line end
// instead of in a legend.

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
import { mLong, mShort } from '~/variants/a/charts';
import { TipBox, TipRow, useWidth } from './bits';
import { cx, kmoney, money, type Palette, tw } from './theme';

type Series = {
  key: string;
  label: string;
  color: string;
  area?: boolean;
};

type Dot = 'filled' | 'hollow' | 'square' | null;

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
  series: Series[];
  pal: Palette;
  height?: number;
  step?: boolean;
  dateKey?: string;
  zeroBase?: boolean;
  dotFor?: (row: Record<string, any>) => Dot;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const labelled = width >= 360;
  const last = rows.length - 1;
  const fmtX = (d: string) =>
    d.length > 7 ? `${mShort(d.slice(0, 7))} ’${d.slice(2, 4)}` : mLong(d);

  const lastVals = series.map((s) => Number(rows[last]?.[s.key] ?? 0));
  const order = lastVals
    .map((v, i) => ({ v, i }))
    .sort((a, b) => b.v - a.v)
    .map((x) => x.i);

  const endLabel = (s: Series, i: number) => (props: any) => {
    const { x, y, index } = props;
    if (!labelled || index !== last || x == null || y == null)
      return <g key={`${s.key}-${index}`} />;
    const rank = order.indexOf(i);
    const nudge = series.length > 1 ? (rank === 0 ? -7 : 7) : 0;
    return (
      <text
        key={`${s.key}-${index}`}
        x={x + 8}
        y={y + nudge}
        dy="0.32em"
        fontSize={10}
        fill={pal.ink2}
      >
        {s.label}
        <tspan dx={4} fill={pal.ink3} className="tabular-nums">
          {kmoney(lastVals[i])}
        </tspan>
      </text>
    );
  };

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

  const tooltip = ({ active, payload }: any) => {
    if (!active || !payload?.length) return null;
    const r = payload[0].payload;
    const d = String(r[dateKey]);
    return (
      <TipBox>
        <div className={cx('mb-1 font-medium', tw.ink2)}>
          {d.length > 7 ? d : mLong(d)}
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

  const margin = { top: 10, right: labelled ? 118 : 8, bottom: 0, left: 0 };
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
        height={18}
      />
      <YAxis
        width={44}
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
  const active = (color: string) => ({
    r: 4,
    fill: color,
    stroke: pal.surface,
    strokeWidth: 2,
  });

  return (
    <div ref={ref} style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        {series.some((s) => s.area) ? (
          <AreaChart data={rows} margin={margin}>
            {axes}
            {series.map((s, i) => (
              <Area
                key={s.key}
                type={step ? 'stepAfter' : 'monotone'}
                dataKey={s.key}
                stroke={s.color}
                strokeWidth={2}
                fill={s.color}
                fillOpacity={s.area ? 0.08 : 0}
                isAnimationActive={false}
                dot={dotFor ? renderDot(s.color) : false}
                activeDot={active(s.color)}
                label={endLabel(s, i)}
              />
            ))}
          </AreaChart>
        ) : (
          <LineChart data={rows} margin={margin}>
            {axes}
            {series.map((s, i) => (
              <Line
                key={s.key}
                type={step ? 'stepAfter' : 'monotone'}
                dataKey={s.key}
                stroke={s.color}
                strokeWidth={2}
                isAnimationActive={false}
                dot={dotFor ? renderDot(s.color) : false}
                activeDot={active(s.color)}
                label={endLabel(s, i)}
              />
            ))}
          </LineChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}
