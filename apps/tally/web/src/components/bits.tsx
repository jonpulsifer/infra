import { type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { cx, tw } from '~/lib/theme';

export function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(([e]) =>
      setWidth(Math.floor(e.contentRect.width)),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd
      className={cx(
        'inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[3px] border px-1 font-mono text-[10px] leading-none',
        tw.rule,
        tw.ink3,
      )}
    >
      {children}
    </kbd>
  );
}

export function Swatch({
  color,
  off,
  shape = 'rect',
}: {
  color: string;
  off?: boolean;
  shape?: 'rect' | 'line' | 'dot';
}) {
  if (shape === 'line')
    return (
      <span
        className="inline-block h-[2px] w-3 shrink-0 rounded-full"
        style={{ background: color }}
      />
    );
  return (
    <span
      className={cx(
        'inline-block shrink-0',
        shape === 'dot' ? 'h-2 w-2 rounded-full' : 'h-2.5 w-2.5 rounded-[2px]',
      )}
      style={
        off
          ? { boxShadow: `inset 0 0 0 1.5px ${color}` }
          : { background: color }
      }
    />
  );
}

export function Segmented<K extends string>({
  options,
  value,
  onChange,
}: {
  options: { key: K; label: ReactNode }[];
  value: K;
  onChange: (k: K) => void;
}) {
  return (
    <div
      className={cx(
        'flex h-7 items-stretch rounded-[3px] border p-px',
        tw.rule,
      )}
    >
      {options.map((o) => (
        <button
          type="button"
          key={o.key}
          onClick={() => onChange(o.key)}
          aria-pressed={o.key === value}
          className={cx(
            'rounded-[2px] px-2 text-[11px] font-medium transition-colors',
            o.key === value
              ? 'bg-[#0b0b0b] text-[#fcfcfb] dark:bg-[#f0efec] dark:text-[#141413]'
              : cx(tw.ink2, tw.hover),
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function TipBox({ children }: { children: ReactNode }) {
  return (
    <div
      className={cx(
        'min-w-[148px] rounded-[4px] border px-2.5 py-2 text-[11px] shadow-[0_6px_20px_rgba(0,0,0,0.12)] dark:shadow-[0_6px_20px_rgba(0,0,0,0.5)]',
        tw.surface,
        tw.rule,
        tw.ink,
      )}
    >
      {children}
    </div>
  );
}

export function TipRow({
  color,
  label,
  value,
  shape = 'line',
}: {
  color?: string;
  label: ReactNode;
  value: ReactNode;
  shape?: 'line' | 'dot' | 'rect';
}) {
  return (
    <div className="flex items-center gap-2 py-[1px]">
      {color ? <Swatch color={color} shape={shape} /> : null}
      <span className={cx(tw.num, 'font-semibold')}>{value}</span>
      <span className={cx('ml-auto pl-3', tw.ink3)}>{label}</span>
    </div>
  );
}
