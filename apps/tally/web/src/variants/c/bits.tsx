import { ChevronDown, ChevronLeft, ChevronRight, X } from 'lucide-react';
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import type { Ledger } from '~/fixtures/types';
import { groupOf, initials, monthShort } from './model';
import { groupColor, type Palette } from './theme';

const SWITCHER_SHOWN =
  import.meta.env.MODE !== 'production' ||
  new URLSearchParams(window.location.search).get('bar') !== 'off';

/** Space the prototype's own floating switcher takes at the bottom. */
export const CHROME_PAD = SWITCHER_SHOWN ? 56 : 0;
export const TAB_H = 64;
export const SCRUB_H = 64;

export const CSS = `
@keyframes qc-in { from { opacity: 0; transform: translateY(10px) } to { opacity: 1; transform: none } }
@keyframes qc-fade { from { opacity: 0 } to { opacity: 1 } }
@keyframes qc-sheet { from { transform: translateY(100%) } to { transform: none } }
@keyframes qc-flash { 0%, 40% { background-color: rgb(245 158 11 / 0.22) } 100% { background-color: transparent } }
.qc-in { animation: qc-in 280ms cubic-bezier(.2,.8,.2,1) both }
.qc-fade { animation: qc-fade 200ms ease-out both }
.qc-sheet { animation: qc-sheet 320ms cubic-bezier(.2,.8,.2,1) both }
.qc-flash { animation: qc-flash 1.6s ease-out both }
.qc-noscroll { scrollbar-width: none } .qc-noscroll::-webkit-scrollbar { display: none }
@media (prefers-reduced-motion: reduce) { .qc-in, .qc-fade, .qc-sheet, .qc-flash { animation: none } }
`;

/** Mirrors the page layout so fixed chrome lines up with the main column. */
export function ColumnFrame({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`pointer-events-none mx-auto flex max-w-5xl justify-center gap-8 lg:px-8 ${className}`}
    >
      <div className="pointer-events-auto w-full max-w-md">{children}</div>
      <div className="hidden w-80 shrink-0 lg:block" />
    </div>
  );
}

export function useMeasure<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

export function Monogram({
  name,
  size = 44,
  tone = 'plain',
}: {
  name: string;
  size?: number;
  tone?: 'plain' | 'warm';
}) {
  const cls =
    tone === 'warm'
      ? 'bg-amber-100 text-amber-900 dark:bg-amber-400/15 dark:text-amber-200'
      : 'bg-stone-200/80 text-stone-700 dark:bg-stone-800 dark:text-stone-200';
  return (
    <span
      aria-hidden
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-semibold tracking-tight ${cls}`}
      style={{ width: size, height: size, fontSize: size * 0.34 }}
    >
      {initials(name)}
    </span>
  );
}

export function CategoryChip({
  ledger,
  categoryId,
  pal,
  name,
  manual,
}: {
  ledger: Ledger;
  categoryId: string;
  pal: Palette;
  name: string;
  manual?: boolean;
}) {
  const color = groupColor(groupOf(ledger, categoryId), pal);
  const unc = categoryId === 'uncategorized';
  return (
    <span
      className={`inline-flex max-w-full items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${
        unc
          ? 'bg-red-50 text-red-800 ring-1 ring-red-200 dark:bg-red-500/10 dark:text-red-200 dark:ring-red-500/30'
          : 'bg-stone-100 text-stone-700 dark:bg-stone-800 dark:text-stone-300'
      }`}
    >
      <span
        aria-hidden
        className="size-2 shrink-0 rounded-full"
        style={{ background: color }}
      />
      <span className="truncate">{name}</span>
      {manual ? (
        <span className="text-amber-700 dark:text-amber-300" title="Set by you">
          ·&nbsp;you
        </span>
      ) : null}
    </span>
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
      className="inline-flex rounded-full bg-stone-200/70 p-1 dark:bg-stone-800"
    >
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          role="radio"
          aria-checked={o.key === value}
          onClick={() => onChange(o.key)}
          className={`min-h-9 rounded-full px-3.5 text-sm font-medium transition ${
            o.key === value
              ? 'bg-white text-stone-900 shadow-sm dark:bg-stone-600 dark:text-white'
              : 'text-stone-600 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Answer({
  question,
  line,
  sub,
  onBack,
  aside,
}: {
  question: string;
  line: ReactNode;
  sub?: ReactNode;
  onBack?: () => void;
  aside?: ReactNode;
}) {
  return (
    <header className="px-4 pt-3 pb-4">
      <div className="flex h-11 items-center justify-between">
        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            className="-ml-2 inline-flex h-11 items-center gap-1 rounded-full pr-3 pl-1.5 text-sm font-medium text-stone-600 hover:bg-stone-200/60 dark:text-stone-400 dark:hover:bg-stone-800"
          >
            <ChevronLeft className="size-5" aria-hidden />
            Questions
          </button>
        ) : (
          <span />
        )}
        {aside}
      </div>
      <p className="mt-2 text-sm font-medium text-amber-700 dark:text-amber-300">
        {question}
      </p>
      <h1 className="mt-1 text-[1.65rem] leading-[1.15] font-semibold tracking-tight text-balance text-stone-900 dark:text-stone-50">
        {line}
      </h1>
      {sub ? (
        <p className="mt-2 text-[0.95rem] leading-snug text-stone-600 dark:text-stone-400">
          {sub}
        </p>
      ) : null}
    </header>
  );
}

export type NumberRow = {
  label: string;
  value: string;
  hint?: string;
  swatch?: string;
  strong?: boolean;
};

export function NumbersList({ rows }: { rows: NumberRow[] }) {
  return (
    <dl className="divide-y divide-stone-200/80 dark:divide-stone-800">
      {rows.map((r) => (
        <div
          key={r.label}
          className="flex items-baseline justify-between gap-3 py-2.5"
        >
          <dt className="flex min-w-0 items-center gap-2 text-sm text-stone-600 dark:text-stone-400">
            {r.swatch ? (
              <span
                aria-hidden
                className="size-2.5 shrink-0 rounded-sm"
                style={{ background: r.swatch }}
              />
            ) : null}
            <span className="truncate">{r.label}</span>
            {r.hint ? (
              <span className="text-xs text-stone-500">{r.hint}</span>
            ) : null}
          </dt>
          <dd
            className={`text-sm tabular-nums ${r.strong ? 'font-semibold text-stone-900 dark:text-stone-50' : 'text-stone-800 dark:text-stone-200'}`}
          >
            {r.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function Disclosure({
  title,
  children,
  className = '',
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className={`rounded-2xl bg-white ring-1 ring-stone-200/80 dark:bg-stone-900 dark:ring-stone-800 ${className}`}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex min-h-12 w-full items-center justify-between px-4 text-sm font-medium text-stone-700 dark:text-stone-300"
      >
        {title}
        <ChevronDown
          aria-hidden
          className={`size-4 transition ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open ? <div className="qc-fade px-4 pb-3">{children}</div> : null}
    </div>
  );
}

export function Card({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-2xl bg-stone-50 ring-1 ring-stone-200/80 dark:bg-stone-900 dark:ring-stone-800 ${className}`}
    >
      {children}
    </div>
  );
}

export function Scrubber({
  months,
  value,
  onChange,
  bottom,
}: {
  months: string[];
  value: string;
  onChange: (m: string) => void;
  bottom: number;
}) {
  const box = useRef<HTMLDivElement>(null);
  const first = useRef(true);
  useEffect(() => {
    const c = box.current;
    const el = c?.querySelector<HTMLElement>(`[data-m="${value}"]`);
    if (!c || !el) return;
    c.scrollTo({
      left: el.offsetLeft - c.clientWidth / 2 + el.clientWidth / 2,
      behavior: first.current ? 'auto' : 'smooth',
    });
    first.current = false;
  }, [value]);
  const i = months.indexOf(value);
  const step = (d: number) => {
    const n = months[Math.min(months.length - 1, Math.max(0, i + d))];
    if (n) onChange(n);
  };
  return (
    <div className="fixed inset-x-0 z-30" style={{ bottom }}>
      <ColumnFrame>
        <div
          className="flex items-center gap-1 border-t border-stone-200/80 bg-stone-100/90 px-1 backdrop-blur-md dark:border-stone-800 dark:bg-stone-950/85"
          style={{ height: SCRUB_H }}
        >
          <button
            type="button"
            aria-label="Previous month"
            disabled={i <= 0}
            onClick={() => step(-1)}
            className="grid size-11 shrink-0 place-items-center rounded-full text-stone-600 hover:bg-stone-200 disabled:opacity-30 dark:text-stone-400 dark:hover:bg-stone-800"
          >
            <ChevronLeft className="size-5" aria-hidden />
          </button>
          <div
            ref={box}
            role="listbox"
            aria-label="Period"
            className="qc-noscroll relative flex min-w-0 flex-1 snap-x snap-mandatory gap-1.5 overflow-x-auto scroll-px-10 py-2"
          >
            {months.map((m) => {
              const on = m === value;
              const showYear = on || m.endsWith('-01');
              return (
                <button
                  key={m}
                  type="button"
                  role="option"
                  aria-selected={on}
                  data-m={m}
                  onClick={() => onChange(m)}
                  className={`flex h-11 min-w-14 shrink-0 snap-center flex-col items-center justify-center rounded-xl px-2 leading-none transition ${
                    on
                      ? 'bg-amber-500 text-stone-950 shadow-sm'
                      : 'text-stone-600 hover:bg-stone-200 dark:text-stone-400 dark:hover:bg-stone-800'
                  }`}
                >
                  <span className="text-sm font-semibold">{monthShort(m)}</span>
                  <span
                    className={`mt-0.5 text-[10px] ${showYear ? '' : 'opacity-0'}`}
                  >
                    {m.slice(0, 4)}
                  </span>
                </button>
              );
            })}
          </div>
          <button
            type="button"
            aria-label="Next month"
            disabled={i >= months.length - 1}
            onClick={() => step(1)}
            className="grid size-11 shrink-0 place-items-center rounded-full text-stone-600 hover:bg-stone-200 disabled:opacity-30 dark:text-stone-400 dark:hover:bg-stone-800"
          >
            <ChevronRight className="size-5" aria-hidden />
          </button>
        </div>
      </ColumnFrame>
    </div>
  );
}

export function Sheet({
  open,
  onClose,
  title,
  children,
  footer,
  tall,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  tall?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="qc-fade absolute inset-0 cursor-default bg-stone-950/40 backdrop-blur-[2px]"
      />
      <div className="absolute inset-x-0 bottom-0">
        <ColumnFrame>
          <div
            role="dialog"
            aria-modal="true"
            className={`qc-sheet flex flex-col rounded-t-3xl bg-stone-50 shadow-2xl ring-1 ring-stone-200 dark:bg-stone-900 dark:ring-stone-800 ${tall ? 'h-[88vh]' : 'max-h-[88vh]'}`}
          >
            <div className="flex justify-center pt-2.5">
              <span className="h-1.5 w-10 rounded-full bg-stone-300 dark:bg-stone-700" />
            </div>
            <div className="flex items-center justify-between gap-3 px-5 pt-2 pb-3">
              <h2 className="min-w-0 text-lg font-semibold tracking-tight text-stone-900 dark:text-stone-50">
                {title}
              </h2>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="-mr-2 grid size-11 place-items-center rounded-full text-stone-500 hover:bg-stone-200 dark:hover:bg-stone-800"
              >
                <X className="size-5" aria-hidden />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-4">
              {children}
            </div>
            {footer ? (
              <div
                className="border-t border-stone-200 px-5 pt-3 dark:border-stone-800"
                style={{ paddingBottom: 16 + CHROME_PAD }}
              >
                {footer}
              </div>
            ) : (
              <div style={{ height: CHROME_PAD }} />
            )}
          </div>
        </ColumnFrame>
      </div>
    </div>
  );
}

export function PrimaryButton({
  children,
  onClick,
  disabled,
  className = '',
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex min-h-12 items-center justify-center gap-2 whitespace-nowrap rounded-2xl bg-amber-500 px-5 text-[0.95rem] font-semibold text-stone-950 shadow-sm transition hover:bg-amber-400 active:scale-[0.98] disabled:opacity-40 dark:bg-amber-400 dark:hover:bg-amber-300 ${className}`}
    >
      {children}
    </button>
  );
}

export function QuietButton({
  children,
  onClick,
  className = '',
}: {
  children: ReactNode;
  onClick?: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex min-h-12 shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-2xl px-4 text-[0.95rem] font-medium text-stone-700 ring-1 ring-stone-300 transition hover:bg-stone-200/60 active:scale-[0.98] dark:text-stone-300 dark:ring-stone-700 dark:hover:bg-stone-800 ${className}`}
    >
      {children}
    </button>
  );
}

export function Toggle({
  on,
  onChange,
  label,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className={`relative h-7 w-12 shrink-0 rounded-full transition ${on ? 'bg-amber-500' : 'bg-stone-300 dark:bg-stone-700'}`}
    >
      <span
        className={`absolute top-0.5 left-0.5 size-6 rounded-full bg-white shadow transition ${on ? 'translate-x-5' : ''}`}
      />
    </button>
  );
}

export const AsideCtx = createContext<HTMLElement | null>(null);

/** Renders into the context panel that appears beside the column at lg. */
export function Aside({ children }: { children: ReactNode }) {
  const el = useContext(AsideCtx);
  return el ? createPortal(children, el) : null;
}

export function AsideSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="qc-fade rounded-2xl bg-white p-4 ring-1 ring-stone-200/80 dark:bg-stone-900 dark:ring-stone-800">
      <h2 className="mb-1 text-xs font-semibold tracking-wide text-stone-500 uppercase">
        {title}
      </h2>
      {children}
    </section>
  );
}
