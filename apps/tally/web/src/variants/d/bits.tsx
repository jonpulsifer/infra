import type { ReactNode } from 'react';
import { cx, tw } from './theme';

export {
  Empty,
  isTyping,
  Kbd,
  Segmented,
  Swatch,
  TipBox,
  TipLayer,
  TipRow,
  useTip,
  useWidth,
} from '~/variants/a/bits';

/** A Desk panel with a written finding under its title and an optional foot line. */
export function Panel({
  title,
  meta,
  right,
  finding,
  foot,
  children,
  className,
}: {
  title: ReactNode;
  meta?: ReactNode;
  right?: ReactNode;
  finding?: ReactNode;
  foot?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cx(tw.surface, 'flex min-w-0 flex-col', className)}>
      <header className="flex h-8 shrink-0 items-center gap-3 px-3">
        <h2 className={cx(tw.label, tw.ink2)}>{title}</h2>
        {meta ? (
          <div className={cx('min-w-0 truncate text-[11px]', tw.ink3, tw.num)}>
            {meta}
          </div>
        ) : null}
        <div className="ml-auto flex shrink-0 items-center gap-2">{right}</div>
      </header>
      {finding ? <Finding className="px-3">{finding}</Finding> : null}
      <div className="min-h-0 flex-1 px-3 pb-3">{children}</div>
      {foot ? (
        <div
          className={cx(
            'mx-3 mb-2 border-t pt-1.5 text-[11px] leading-4',
            tw.rule,
            tw.ink3,
          )}
        >
          {foot}
        </div>
      ) : null}
    </section>
  );
}

/** The one-line written finding under a panel title. */
export function Finding({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <p
      aria-live="polite"
      className={cx(
        '-mt-1 min-h-4 pb-2 text-[12px] leading-4 text-pretty',
        tw.ink2,
        className,
      )}
    >
      {children}
    </p>
  );
}

export type ToneKind = 'good' | 'bad' | 'warn' | 'ink';

/** A figure inside a sentence: tabular, weighted, coloured by what it means. */
export function Fig({
  children,
  tone = 'ink',
}: {
  children: ReactNode;
  tone?: ToneKind;
}) {
  return (
    <span
      className={cx(
        'font-medium tabular-nums',
        tone === 'good'
          ? tw.good
          : tone === 'bad'
            ? tw.bad
            : tone === 'warn'
              ? tw.warn
              : tw.ink,
      )}
    >
      {children}
    </span>
  );
}

/** A ticker cell: small-caps label, a serif figure, a sans sub-line. */
export function Stat({
  label,
  value,
  mark,
  sub,
}: {
  label: string;
  value: string;
  mark?: ReactNode;
  sub: ReactNode;
}) {
  return (
    <div className={cx(tw.surface, 'min-w-0 px-3 pt-2 pb-2.5')}>
      <div className={cx('dw-caps', tw.ink3)}>{label}</div>
      <div
        className={cx(
          'dw-serif mt-1 truncate text-[25px] leading-[28px] tracking-[-0.01em]',
          tw.ink,
        )}
      >
        {value}
        {mark ? (
          <sup
            className={cx('relative -top-[9px] ml-0.5 text-[15px]', tw.ink3)}
          >
            {mark}
          </sup>
        ) : null}
      </div>
      <div className={cx('mt-0.5 truncate text-[11px]', tw.ink3)}>{sub}</div>
    </div>
  );
}
