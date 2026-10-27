import { area, curveMonotoneX, line } from 'd3-shape';
import { type KeyboardEvent, type PointerEvent, useRef } from 'react';
import { useMeasure } from '../bits';
import { money, moneyShort, niceTicks } from '../model';
import type { Palette } from '../theme';

export type TrendPoint = { key: string; value: number };

const M = { t: 34, r: 12, b: 26, l: 0 };

/** Tall area with a crosshair that follows a finger or a pointer. */
export function Trend({
  data,
  index,
  onIndex,
  height,
  color,
  pal,
  label,
  pointLabel,
  xLabel,
}: {
  data: TrendPoint[];
  index: number;
  onIndex: (i: number) => void;
  height: number;
  color: string;
  pal: Palette;
  label: string;
  pointLabel: (p: TrendPoint) => string;
  xLabel: (p: TrendPoint, i: number) => string | null;
}) {
  const [box, w] = useMeasure<HTMLDivElement>();
  const dragging = useRef(false);
  const iw = Math.max(1, w - M.l - M.r);
  const ih = height - M.t - M.b;
  const vals = data.map((d) => d.value);
  const ticks = niceTicks(Math.min(0, ...vals), Math.max(0, ...vals), 4);
  const lo = ticks[0];
  const hi = ticks[ticks.length - 1];
  const x = (i: number) =>
    M.l + (data.length <= 1 ? iw / 2 : (i / (data.length - 1)) * iw);
  const y = (v: number) => M.t + ih - ((v - lo) / (hi - lo || 1)) * ih;
  const base = y(Math.min(hi, Math.max(lo, 0)));
  const areaPath =
    area<TrendPoint>()
      .x((_, i) => x(i))
      .y0(base)
      .y1((d) => y(d.value))
      .curve(curveMonotoneX)(data) ?? '';
  const linePath =
    line<TrendPoint>()
      .x((_, i) => x(i))
      .y((d) => y(d.value))
      .curve(curveMonotoneX)(data) ?? '';

  const pick = (clientX: number) => {
    const r = box.current?.getBoundingClientRect();
    if (!r || data.length < 2) return;
    const t = (clientX - r.left - M.l) / iw;
    onIndex(
      Math.max(0, Math.min(data.length - 1, Math.round(t * (data.length - 1)))),
    );
  };
  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    dragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    pick(e.clientX);
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (dragging.current || e.pointerType === 'mouse') pick(e.clientX);
  };
  const onUp = () => {
    dragging.current = false;
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const d =
      e.key === 'ArrowLeft'
        ? -1
        : e.key === 'ArrowRight'
          ? 1
          : e.key === 'PageDown'
            ? -12
            : e.key === 'PageUp'
              ? 12
              : 0;
    if (e.key === 'Home') onIndex(0);
    else if (e.key === 'End') onIndex(data.length - 1);
    else if (d) onIndex(Math.max(0, Math.min(data.length - 1, index + d)));
    else return;
    e.preventDefault();
  };

  const p = data[index];
  const cx = x(index);
  const tag = p ? `${pointLabel(p)} · ${money(p.value)}` : '';
  const tagW = tag.length * 7.3 + 22;
  const tagX = Math.max(0, Math.min(w - tagW, cx - tagW / 2));

  return (
    <div
      ref={box}
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={data.length - 1}
      aria-valuenow={index}
      aria-valuetext={tag}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onKeyDown={onKey}
      className="relative w-full cursor-ew-resize rounded-xl outline-none select-none focus-visible:ring-2 focus-visible:ring-amber-500"
      style={{ touchAction: 'pan-y' }}
    >
      {w > 0 ? (
        <svg width={w} height={height} aria-hidden className="block">
          {ticks.map((t) => (
            <g key={t}>
              <line
                x1={0}
                x2={w}
                y1={y(t)}
                y2={y(t)}
                stroke={t === 0 ? pal.axis : pal.grid}
                strokeWidth={1}
              />
              <text
                x={2}
                y={y(t) - 5}
                fontSize={11}
                fill={pal.muted}
                style={{ fontVariantNumeric: 'tabular-nums' }}
              >
                {moneyShort(t)}
              </text>
            </g>
          ))}
          {data.map((d, i) => {
            const l = xLabel(d, i);
            return l ? (
              <text
                key={d.key}
                x={x(i)}
                y={height - 8}
                fontSize={11}
                fill={pal.muted}
                textAnchor={i === 0 ? 'start' : 'middle'}
              >
                {l}
              </text>
            ) : null;
          })}
          <path d={areaPath} fill={color} fillOpacity={0.12} />
          <path
            d={linePath}
            fill="none"
            stroke={color}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          {p ? (
            <g style={{ transition: 'transform 90ms ease-out' }}>
              <line
                x1={cx}
                x2={cx}
                y1={M.t - 6}
                y2={M.t + ih}
                stroke={pal.ink2}
                strokeWidth={1}
              />
              <circle
                cx={cx}
                cy={y(p.value)}
                r={5}
                fill={color}
                stroke={pal.surface}
                strokeWidth={2}
              />
              <rect
                x={tagX}
                y={2}
                width={tagW}
                height={24}
                rx={12}
                fill={pal.ink}
              />
              <text
                x={tagX + tagW / 2}
                y={18}
                textAnchor="middle"
                fontSize={12}
                fontWeight={600}
                fill={pal.surface}
              >
                {tag}
              </text>
            </g>
          ) : null}
        </svg>
      ) : (
        <div style={{ height }} />
      )}
    </div>
  );
}
