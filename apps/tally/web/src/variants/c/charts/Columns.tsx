import { useState } from 'react';
import { useMeasure } from '../bits';
import { money, moneyShort, niceTicks } from '../model';
import type { Palette } from '../theme';

export type Seg = { id: string; name: string; value: number; color: string };
export type Col = {
  key: string;
  label: string;
  sub?: string;
  segs: Seg[];
  detail?: { label: string; value: string }[];
};

const M = { t: 10, r: 4, b: 34, l: 0 };
const GAP = 2;
const R = 4;

function barPath(
  x: number,
  top: number,
  w: number,
  h: number,
  roundTop: boolean,
  roundBottom: boolean,
) {
  const r = Math.min(R, h / 2, w / 2);
  const rt = roundTop ? r : 0;
  const rb = roundBottom ? r : 0;
  const b = top + h;
  return [
    `M${x},${top + rt}`,
    rt ? `Q${x},${top} ${x + rt},${top}` : `L${x},${top}`,
    `L${x + w - rt},${top}`,
    rt ? `Q${x + w},${top} ${x + w},${top + rt}` : `L${x + w},${top}`,
    `L${x + w},${b - rb}`,
    rb ? `Q${x + w},${b} ${x + w - rb},${b}` : `L${x + w},${b}`,
    `L${x + rb},${b}`,
    rb ? `Q${x},${b} ${x},${b - rb}` : `L${x},${b}`,
    'Z',
  ].join(' ');
}

/** Stacked columns that grow up (and down, for negatives) from one baseline. */
export function Columns({
  cols,
  selected,
  onSelect,
  height,
  pal,
  label,
  showTotal = true,
}: {
  cols: Col[];
  selected: string;
  onSelect: (key: string) => void;
  height: number;
  pal: Palette;
  label: string;
  showTotal?: boolean;
}) {
  const [box, w] = useMeasure<HTMLDivElement>();
  const [hover, setHover] = useState<string | null>(null);
  const sums = cols.map((c) => ({
    up: c.segs.reduce((s, x) => s + Math.max(0, x.value), 0),
    down: c.segs.reduce((s, x) => s + Math.min(0, x.value), 0),
  }));
  const ticks = niceTicks(
    Math.min(0, ...sums.map((s) => s.down)),
    Math.max(0, ...sums.map((s) => s.up)),
    4,
  );
  const lo = ticks[0];
  const hi = ticks[ticks.length - 1];
  const iw = Math.max(1, w - M.l - M.r);
  const ih = height - M.t - M.b;
  const band = iw / Math.max(1, cols.length);
  const bw = Math.min(24, band * 0.62);
  const y = (v: number) => M.t + ih - ((v - lo) / (hi - lo || 1)) * ih;
  const shown = hover ?? null;
  const tipCol = cols.find((c) => c.key === shown);
  const tipI = tipCol ? cols.indexOf(tipCol) : -1;
  const tipLeft = tipI >= 0 ? M.l + band * tipI + band / 2 : 0;

  return (
    <div
      ref={box}
      role="group"
      aria-label={label}
      className="relative w-full select-none"
      onPointerLeave={(e) => e.pointerType === 'mouse' && setHover(null)}
    >
      {w > 0 ? (
        <svg width={w} height={height} className="block overflow-visible">
          {ticks.map((t) => (
            <g key={t}>
              <line
                x1={0}
                x2={w}
                y1={y(t)}
                y2={y(t)}
                stroke={t === 0 ? pal.axis : pal.grid}
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
          {cols.map((c, i) => {
            const cx = M.l + band * i + band / 2;
            const x0 = cx - bw / 2;
            const on = c.key === selected;
            const dim = selected && !on ? 0.42 : 1;
            let up = 0;
            let down = 0;
            const ups = c.segs.filter((s) => s.value > 0);
            const downs = c.segs.filter((s) => s.value < 0);
            return (
              <g key={c.key}>
                <g
                  opacity={hover === c.key || on ? 1 : dim}
                  style={{ transition: 'opacity 150ms' }}
                >
                  {ups.map((s, k) => {
                    const yb = y(up) - (k > 0 ? GAP : 0);
                    up += s.value;
                    const yt = y(up);
                    const h = yb - yt;
                    if (h <= 0.5) return null;
                    return (
                      <path
                        key={s.id}
                        d={barPath(x0, yt, bw, h, k === ups.length - 1, false)}
                        fill={s.color}
                      />
                    );
                  })}
                  {downs.map((s, k) => {
                    const yt = y(down) + (k > 0 ? GAP : 0);
                    down += s.value;
                    const yb = y(down);
                    const h = yb - yt;
                    if (h <= 0.5) return null;
                    return (
                      <path
                        key={s.id}
                        d={barPath(
                          x0,
                          yt,
                          bw,
                          h,
                          false,
                          k === downs.length - 1,
                        )}
                        fill={s.color}
                      />
                    );
                  })}
                </g>
                <text
                  x={cx}
                  y={height - 18}
                  fontSize={11}
                  textAnchor="middle"
                  fontWeight={on ? 700 : 400}
                  fill={on ? pal.ink : pal.muted}
                >
                  {c.label}
                </text>
                {c.sub ? (
                  <text
                    x={cx}
                    y={height - 4}
                    fontSize={10}
                    textAnchor="middle"
                    fill={pal.muted}
                  >
                    {c.sub}
                  </text>
                ) : null}
                <rect
                  role="button"
                  tabIndex={0}
                  aria-label={`${c.label} ${c.sub ?? ''}: ${money(c.segs.reduce((s, x) => s + x.value, 0))}`}
                  x={M.l + band * i}
                  y={0}
                  width={band}
                  height={height}
                  fill="transparent"
                  className="cursor-pointer outline-none"
                  onPointerEnter={(e) =>
                    e.pointerType === 'mouse' && setHover(c.key)
                  }
                  onFocus={() => setHover(c.key)}
                  onBlur={() => setHover(null)}
                  onClick={() => {
                    onSelect(c.key);
                    setHover(c.key);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onSelect(c.key);
                    }
                  }}
                />
              </g>
            );
          })}
        </svg>
      ) : (
        <div style={{ height }} />
      )}
      {tipCol ? (
        <div
          className="qc-fade pointer-events-none absolute top-0 z-10 w-52 rounded-xl bg-white p-3 text-xs shadow-lg ring-1 ring-stone-200 dark:bg-stone-800 dark:ring-stone-700"
          style={{
            left: Math.max(
              0,
              Math.min(
                w - 208,
                tipI < cols.length / 2
                  ? tipLeft + band / 2 + 4
                  : tipLeft - band / 2 - 212,
              ),
            ),
          }}
        >
          <div className="mb-1.5 font-medium text-stone-500 dark:text-stone-400">
            {tipCol.label} {tipCol.sub}
          </div>
          {tipCol.segs
            .filter((s) => Math.round(s.value) !== 0)
            .map((s) => (
              <div key={s.id} className="flex items-center gap-2 py-0.5">
                <span
                  aria-hidden
                  className="h-0.5 w-2.5 rounded-full"
                  style={{ background: s.color }}
                />
                <span className="font-semibold text-stone-900 tabular-nums dark:text-stone-50">
                  {money(s.value)}
                </span>
                <span className="truncate text-stone-500 dark:text-stone-400">
                  {s.name}
                </span>
              </div>
            ))}
          {showTotal && tipCol.segs.length > 1 ? (
            <div className="mt-1.5 flex justify-between border-t border-stone-200 pt-1.5 dark:border-stone-700">
              <span className="text-stone-500">Total</span>
              <span className="font-semibold text-stone-900 tabular-nums dark:text-stone-50">
                {money(tipCol.segs.reduce((s, x) => s + x.value, 0))}
              </span>
            </div>
          ) : null}
          {tipCol.detail?.map((d) => (
            <div
              key={d.label}
              className="flex justify-between py-0.5 text-stone-500 dark:text-stone-400"
            >
              <span>{d.label}</span>
              <span className="text-stone-800 tabular-nums dark:text-stone-200">
                {d.value}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
