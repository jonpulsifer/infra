import { type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { groupColor } from './theme';

// Layout hooks and scales ----------------------------------------------------

export function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.getBoundingClientRect().width);
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

export function linear([d0, d1]: [number, number], [r0, r1]: [number, number]) {
  const k = d1 === d0 ? 0 : (r1 - r0) / (d1 - d0);
  return (v: number) => r0 + (v - d0) * k;
}

export function niceTicks(min: number, max: number, count = 5) {
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

export function tickLabel(v: number) {
  if (v === 0) return '$0';
  const a = Math.abs(v);
  const s = v < 0 ? '−' : '';
  if (a >= 1_000_000) return `${s}$${+(a / 1_000_000).toFixed(1)}M`;
  if (a >= 1000) return `${s}$${+(a / 1000).toFixed(1)}K`;
  return `${s}$${a}`;
}

/** A bar path rounded at its data end, square at the baseline. */
export function barPath(
  x: number,
  base: number,
  end: number,
  w: number,
  r = 4,
) {
  const h = Math.abs(end - base);
  const rr = Math.min(r, w / 2, h);
  if (end <= base) {
    return `M${x},${base}V${end + rr}Q${x},${end} ${x + rr},${end}H${x + w - rr}Q${x + w},${end} ${x + w},${end + rr}V${base}Z`;
  }
  return `M${x},${base}V${end - rr}Q${x},${end} ${x + rr},${end}H${x + w - rr}Q${x + w},${end} ${x + w},${end - rr}V${base}Z`;
}

// Chart chrome ----------------------------------------------------------------

export type TipRow = {
  label: string;
  value: string;
  color?: string;
  mark?: 'line' | 'dot';
};

export function Tooltip({
  x,
  y,
  width,
  title,
  rows,
  note,
}: {
  x: number;
  y: number;
  width: number;
  title: string;
  rows: TipRow[];
  note?: string;
}) {
  const flip = x > width - 220;
  return (
    <div
      className="pointer-events-none absolute z-20 min-w-[170px] rounded-xl border border-(--hair) bg-(--raise) px-3.5 py-3 text-[13px] shadow-[0_12px_32px_-12px_rgba(0,0,0,0.25)]"
      style={{
        left: flip ? undefined : x + 16,
        right: flip ? width - x + 16 : undefined,
        top: Math.max(0, y - 12),
      }}
    >
      <div className="mb-2 text-[12px] text-(--muted)">{title}</div>
      <div className="space-y-1.5">
        {rows.map((r) => (
          <div key={r.label} className="flex items-center gap-2.5">
            {r.color ? (
              r.mark === 'dot' ? (
                <span
                  className="size-2 shrink-0 rounded-full"
                  style={{ background: r.color }}
                />
              ) : (
                <span
                  className="h-[3px] w-3 shrink-0 rounded-full"
                  style={{ background: r.color }}
                />
              )
            ) : (
              <span className="w-3 shrink-0" />
            )}
            <span className="num font-semibold text-(--ink)">{r.value}</span>
            <span className="ml-auto pl-3 text-(--ink2)">{r.label}</span>
          </div>
        ))}
      </div>
      {note ? (
        <div className="mt-2 border-t border-(--hair) pt-2 text-[12px] text-(--muted)">
          {note}
        </div>
      ) : null}
    </div>
  );
}

export function LegendItem({
  color,
  label,
  mark = 'rect',
}: {
  color: string;
  label: string;
  mark?: 'rect' | 'line' | 'ring';
}) {
  return (
    <span className="inline-flex items-center gap-2 text-[13px] text-(--ink2)">
      {mark === 'rect' ? (
        <span
          className="size-2.5 rounded-[3px]"
          style={{ background: color }}
        />
      ) : mark === 'ring' ? (
        <span
          className="size-2.5 rounded-full border-2"
          style={{ borderColor: color }}
        />
      ) : (
        <span
          className="h-[2px] w-4 rounded-full"
          style={{ background: color }}
        />
      )}
      {label}
    </span>
  );
}

/** The plain-figures twin of a chart, so no value is gated behind hover. */
export function Figures({
  label = 'Read the figures',
  rows,
}: {
  label?: string;
  rows: { k: string; v: string }[];
}) {
  return (
    <details className="group mt-5 text-[13px]">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 text-(--muted) transition-colors hover:text-(--ink) [&::-webkit-details-marker]:hidden">
        <span className="inline-block transition-transform group-open:rotate-90">
          ›
        </span>
        {label}
      </summary>
      <dl className="mt-4 grid grid-cols-2 gap-x-8 gap-y-1.5 sm:grid-cols-3 lg:grid-cols-4">
        {rows.map((r) => (
          <div
            key={r.k}
            className="flex items-baseline justify-between gap-3 border-b border-(--hair) py-1"
          >
            <dt className="text-(--muted)">{r.k}</dt>
            <dd className="num text-(--ink)">{r.v}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

// Type and small pieces -------------------------------------------------------

export function Kicker({ children }: { children: ReactNode }) {
  return (
    <div className="text-[11px] font-semibold tracking-[0.16em] text-(--muted) uppercase">
      {children}
    </div>
  );
}

export function SectionHead({
  numeral,
  kicker,
  title,
  dek,
}: {
  numeral?: string;
  kicker: string;
  title: ReactNode;
  dek?: ReactNode;
}) {
  return (
    <header className="mb-10 max-w-3xl">
      <Kicker>
        {numeral ? (
          <span className="serif mr-2 normal-case">{numeral}</span>
        ) : null}
        {kicker}
      </Kicker>
      <h2 className="serif mt-3 text-[34px] leading-[1.1] tracking-[-0.01em] text-balance text-(--ink) sm:text-[42px]">
        {title}
      </h2>
      {dek ? (
        <p className="mt-4 max-w-2xl text-[17px] leading-relaxed text-pretty text-(--ink2)">
          {dek}
        </p>
      ) : null}
    </header>
  );
}

export function Segmented<K extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: { key: K; label: string }[];
  value: K;
  onChange: (k: K) => void;
  label: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex rounded-full bg-(--sunk) p-1 ring-1 ring-(--hair)"
    >
      {options.map((o) => {
        const on = o.key === value;
        return (
          <button
            key={o.key}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.key)}
            className={`rounded-full px-3.5 py-1.5 text-[13px] font-medium whitespace-nowrap transition-all ${
              on
                ? 'bg-(--raise) text-(--ink) shadow-[0_1px_2px_rgba(0,0,0,0.12)] ring-1 ring-(--hair)'
                : 'text-(--muted) hover:text-(--ink)'
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function CategoryPill({
  name,
  groupId,
}: {
  name: string;
  groupId: string;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-(--sunk) px-2.5 py-0.5 text-[12px] whitespace-nowrap text-(--ink2) ring-1 ring-(--hair)">
      <span
        className="size-1.5 rounded-full"
        style={{ background: groupColor(groupId) }}
      />
      {name}
    </span>
  );
}

export function Monogram({
  text,
  groupId,
  size = 40,
}: {
  text: string;
  groupId: string;
  size?: number;
}) {
  const c = groupColor(groupId);
  return (
    <span
      aria-hidden
      className="serif inline-flex shrink-0 items-center justify-center rounded-full text-(--ink)"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.38,
        background: `color-mix(in srgb, ${c} 14%, var(--page))`,
        boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${c} 32%, transparent)`,
      }}
    >
      {text}
    </span>
  );
}

export function Delta({
  value,
  upIsGood = false,
}: {
  value: number;
  upIsGood?: boolean;
}) {
  const r = Math.round(value);
  if (r === 0)
    return <span className="num text-[12px] text-(--muted)">±$0</span>;
  const good = r > 0 === upIsGood;
  return (
    <span
      className="num inline-flex items-center gap-0.5 text-[12px] font-medium"
      style={{ color: good ? 'var(--good)' : 'var(--bad)' }}
    >
      <span aria-hidden>{r > 0 ? '▲' : '▼'}</span>
      <span className="sr-only">{r > 0 ? 'up' : 'down'}</span>
      {new Intl.NumberFormat('en-CA', {
        style: 'currency',
        currency: 'CAD',
        maximumFractionDigits: 0,
      }).format(Math.abs(r))}
    </span>
  );
}

export function Empty({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="rounded-3xl border border-dashed border-(--hair) px-8 py-16 text-center">
      <div className="serif text-[24px] text-(--ink)">{title}</div>
      {children ? (
        <div className="mx-auto mt-3 max-w-md text-[15px] text-(--ink2)">
          {children}
        </div>
      ) : null}
    </div>
  );
}
