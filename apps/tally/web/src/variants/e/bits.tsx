import {
  type FocusEvent as ReactFocusEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { cx, tw } from './theme';

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

export function Panel({
  title,
  meta,
  right,
  children,
  className,
}: {
  title: ReactNode;
  meta?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cx(tw.surface, 'flex min-w-0 flex-col', className)}>
      <header className="flex h-8 shrink-0 items-center gap-3 px-3">
        <h2 className={cx(tw.label, tw.ink2)}>{title}</h2>
        {meta ? (
          <div className={cx('text-[11px]', tw.ink3, tw.num)}>{meta}</div>
        ) : null}
        <div className="ml-auto flex items-center gap-2">{right}</div>
      </header>
      <div className="min-h-0 flex-1 px-3 pb-3">{children}</div>
    </section>
  );
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

export type Tip = { x: number; y: number; body: ReactNode } | null;

export function useTip() {
  const [tip, setTip] = useState<Tip>(null);
  const host = useRef<HTMLDivElement>(null);
  const show = useCallback(
    (e: ReactPointerEvent | ReactFocusEvent, body: ReactNode) => {
      const r = host.current?.getBoundingClientRect();
      if (!r) return;
      if ('clientX' in e) {
        setTip({ x: e.clientX - r.left, y: e.clientY - r.top, body });
      } else {
        const t = (e.target as Element).getBoundingClientRect();
        setTip({
          x: t.left + t.width / 2 - r.left,
          y: t.top - r.top,
          body,
        });
      }
    },
    [],
  );
  const hide = useCallback(() => setTip(null), []);
  return { host, tip, show, hide };
}

export function TipLayer({ tip, width }: { tip: Tip; width: number }) {
  if (!tip) return null;
  const flip = tip.x > width - 200;
  return (
    <div
      className="pointer-events-none absolute z-20"
      style={{
        left: tip.x,
        top: tip.y,
        transform: `translate(${flip ? 'calc(-100% - 12px)' : '12px'}, -50%)`,
      }}
    >
      <TipBox>{tip.body}</TipBox>
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

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div
      className={cx(
        'flex h-full min-h-24 items-center justify-center text-[12px]',
        tw.ink3,
      )}
    >
      {children}
    </div>
  );
}

export function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  return (
    !!t &&
    (t.tagName === 'INPUT' ||
      t.tagName === 'SELECT' ||
      t.tagName === 'TEXTAREA' ||
      t.isContentEditable)
  );
}

/** Editorial type scale on a desk screen: a serif title and one sentence of context. */
export function ScreenTitle({
  title,
  aside,
  intro,
  right,
}: {
  title: ReactNode;
  aside?: ReactNode;
  intro: ReactNode;
  right?: ReactNode;
}) {
  return (
    <header
      className={cx(
        'flex shrink-0 flex-wrap items-end gap-x-6 gap-y-2 border-b px-4 pt-6 pb-3.5',
        tw.rule,
        tw.surface,
      )}
    >
      <div className="min-w-0">
        <h1
          className={cx(
            tw.serif,
            'text-[30px] leading-[1.08] tracking-[-0.012em] text-balance',
            tw.ink,
          )}
        >
          {title}
          {aside ? (
            <span className={cx('italic', tw.ink3)}>
              {', '}
              {aside}
            </span>
          ) : null}
        </h1>
        <p
          className={cx(
            'mt-1.5 max-w-[820px] text-[14px] leading-[1.5] text-pretty',
            tw.ink2,
          )}
        >
          {intro}
        </p>
      </div>
      {right ? (
        <div className="ml-auto flex shrink-0 items-center gap-2 pb-0.5">
          {right}
        </div>
      ) : null}
    </header>
  );
}

const SHORT = new Intl.NumberFormat('en-CA', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

/** A signed change in spend: up is bad unless told otherwise. Glyph and sign, never colour alone. */
export function Delta({
  value,
  upIsGood = false,
  title,
}: {
  value: number;
  upIsGood?: boolean;
  title?: string;
}) {
  const r = Math.round(value);
  if (Math.abs(r) < 1)
    return (
      <span title={title} className={cx(tw.num, 'text-[11px]', tw.ink3)}>
        ±0
      </span>
    );
  const good = r > 0 === upIsGood;
  return (
    <span
      title={title}
      className={cx(
        tw.num,
        'inline-flex items-center justify-end gap-[3px] text-[11px]',
        good ? tw.good : tw.bad,
      )}
    >
      <span aria-hidden className="text-[8px]">
        {r > 0 ? '▲' : '▼'}
      </span>
      <span className="sr-only">{r > 0 ? 'up' : 'down'}</span>$
      {SHORT.format(Math.abs(r))}
    </span>
  );
}
