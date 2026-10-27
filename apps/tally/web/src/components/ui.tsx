import { Pin, PinOff } from 'lucide-react';
import type { ReactNode } from 'react';
import type { Transaction } from '~/fixtures/types';
import { mShort } from '~/lib/dates';
import { signedMoney } from '~/lib/money';
import { cx, type Palette, tw } from '~/lib/theme';
import { Kbd } from './bits';

export const SERIF =
  "'Iowan Old Style', 'Palatino Linotype', Palatino, 'Book Antiqua', Charter, 'Bitstream Charter', Georgia, 'Noto Serif', 'DejaVu Serif', serif";

export const CSS = `
.rf-serif { font-family: ${SERIF}; font-feature-settings: 'kern' 1, 'liga' 1, 'onum' 1; }
.rf-lining { font-feature-settings: 'lnum' 1, 'tnum' 1; }
.rf-dropcap::first-letter {
  font-family: ${SERIF};
  float: left;
  font-size: 3.6em;
  line-height: 0.84;
  padding: 0.05em 0.08em 0 0;
}
@keyframes rf-in { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: none; } }
.rf-in { animation: rf-in 160ms ease-out both; }
@keyframes rf-sheet { from { transform: translateY(12px); opacity: .6; } to { transform: none; opacity: 1; } }
.rf-sheet { animation: rf-sheet 180ms cubic-bezier(.2,.7,.2,1) both; }
@media (prefers-reduced-motion: reduce) { .rf-in, .rf-sheet { animation: none; } }
`;

export const serif = 'rf-serif';
export const rowRule = 'border-[#efeee9] dark:border-[#20201e]';

export function Kicker({ children }: { children: ReactNode }) {
  return <div className={cx(tw.label, tw.ink3)}>{children}</div>;
}

export function SectionHead({
  numeral,
  kicker,
  title,
  dek,
  focused,
}: {
  numeral: string;
  kicker: string;
  title: ReactNode;
  dek?: ReactNode;
  focused?: boolean;
}) {
  return (
    <header className="relative mb-7">
      <span
        aria-hidden
        className={cx(
          'absolute top-0 -left-5 h-full w-[2px] rounded-full transition-opacity duration-200 sm:-left-7',
          'bg-[#2a78d6] dark:bg-[#3987e5]',
          focused ? 'opacity-100' : 'opacity-0',
        )}
      />
      <div className="flex items-baseline gap-2">
        <span
          className={cx(
            serif,
            'text-[15px] transition-colors',
            focused ? tw.accent : tw.ink3,
          )}
        >
          {numeral}
        </span>
        <Kicker>{kicker}</Kicker>
      </div>
      <h2
        className={cx(
          serif,
          'mt-2 text-[30px] leading-[1.12] tracking-[-0.01em] text-balance sm:text-[34px]',
          tw.ink,
        )}
      >
        {title}
      </h2>
      {dek ? (
        <p
          className={cx(
            'mt-3 max-w-[600px] text-[15px] leading-relaxed text-pretty',
            tw.ink2,
          )}
        >
          {dek}
        </p>
      ) : null}
    </header>
  );
}

// Inspector pieces --------------------------------------------------------

export function InspectorHead({
  kicker,
  title,
  figure,
  sub,
  pinned,
  onPin,
}: {
  kicker: ReactNode;
  title: ReactNode;
  figure?: ReactNode;
  sub?: ReactNode;
  pinned?: boolean;
  onPin?: () => void;
}) {
  return (
    <div className={cx('border-b px-4 pt-3 pb-3', tw.rule)}>
      <div className="flex items-center gap-2">
        <span className={cx(tw.label, tw.ink3)}>{kicker}</span>
        {onPin ? (
          <button
            type="button"
            onClick={onPin}
            aria-pressed={pinned}
            className={cx(
              'ml-auto inline-flex h-5 items-center gap-1 rounded-[3px] px-1.5 text-[10px] font-medium',
              pinned
                ? 'bg-[#eaf2fc] text-[#1f62b3] dark:bg-[#18263a] dark:text-[#5a9cec]'
                : cx(tw.ink3, tw.hover),
            )}
          >
            {pinned ? <PinOff size={10} /> : <Pin size={10} />}
            {pinned ? 'Pinned' : 'Pin'}
            <span className="ml-0.5 font-mono opacity-70">
              {pinned ? 'esc' : '↵'}
            </span>
          </button>
        ) : null}
      </div>
      <div className="mt-1 flex items-baseline gap-3">
        <h3
          className={cx(
            'min-w-0 flex-1 truncate text-[15px] font-medium',
            tw.ink,
          )}
        >
          {title}
        </h3>
        {figure ? (
          <span className={cx('font-mono text-[17px] tabular-nums', tw.ink)}>
            {figure}
          </span>
        ) : null}
      </div>
      {sub ? (
        <div className={cx('mt-0.5 text-[11px]', tw.ink3)}>{sub}</div>
      ) : null}
    </div>
  );
}

export function Block({
  title,
  right,
  children,
  flush,
}: {
  title: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  flush?: boolean;
}) {
  return (
    <section className={cx('border-b py-3', tw.rule, flush ? '' : 'px-4')}>
      <div
        className={cx('mb-1.5 flex items-center gap-2', flush ? 'px-4' : '')}
      >
        <h4 className={cx(tw.label, tw.ink2)}>{title}</h4>
        <div className={cx('ml-auto text-[11px]', tw.ink3)}>{right}</div>
      </div>
      {children}
    </section>
  );
}

export function KV({ rows }: { rows: [ReactNode, ReactNode, string?][] }) {
  return (
    <dl className="grid grid-cols-[104px_1fr] gap-y-1 text-[12px]">
      {rows.map(([k, v, cls], i) => (
        <div key={i} className="contents">
          <dt className={cx('text-[11px] leading-[18px]', tw.ink3)}>{k}</dt>
          <dd className={cx('min-w-0 truncate leading-[18px]', tw.ink, cls)}>
            {v}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * A month-by-month table with an inline bar: the inspector's chart. Values are
 * signed (the inspector's convention); bars and the average read the size.
 */
export function MonthLadder({
  rows,
  inPeriod,
  color,
  pal,
  label = '',
}: {
  rows: { month: string; value: number }[];
  inPeriod: Set<string>;
  color: string;
  pal: Palette;
  label?: string;
}) {
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.value)));
  const shown = rows.filter((r) => inPeriod.has(r.month));
  const avg = shown.length
    ? shown.reduce((s, r) => s + r.value, 0) / shown.length
    : 0;
  return (
    <table className="w-full table-fixed text-[11px]">
      <thead>
        <tr className={cx(tw.label, tw.ink3)}>
          <th className="w-[58px] pb-1 text-left font-medium">Month</th>
          <th className="pb-1 text-left font-medium">{label}</th>
          <th className="w-[76px] pb-1 text-right font-medium">CAD</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const on = inPeriod.has(r.month);
          return (
            <tr
              key={r.month}
              className={cx('border-t', rowRule, on ? '' : 'opacity-45')}
            >
              <td className={cx('h-[22px] font-mono', tw.ink2)}>
                {mShort(r.month)}
                {r.month.endsWith('-01') ? ` ’${r.month.slice(2, 4)}` : ''}
              </td>
              <td className="pr-3">
                <div className="relative h-[7px]">
                  <div
                    className="absolute inset-y-0 left-0 rounded-r-[2px]"
                    style={{
                      width: `${(Math.abs(r.value) / max) * 100}%`,
                      background: color,
                    }}
                  />
                  {avg ? (
                    <div
                      className="absolute -top-[3px] -bottom-[3px] w-px"
                      style={{
                        left: `${(Math.abs(avg) / max) * 100}%`,
                        background: pal.ink3,
                      }}
                    />
                  ) : null}
                </div>
              </td>
              <td
                className={cx(
                  'text-right font-mono tabular-nums',
                  r.value > 0 ? tw.good : r.value ? tw.ink : tw.ink3,
                )}
              >
                {r.value ? signedMoney(r.value, false) : '—'}
              </td>
            </tr>
          );
        })}
      </tbody>
      <tfoot>
        <tr className={cx('border-t', tw.rule)}>
          <td colSpan={2} className={cx('pt-1.5', tw.ink3)}>
            Tick marks the in-period monthly average
          </td>
          <td className={cx('pt-1.5 text-right font-mono', tw.ink2)}>
            {signedMoney(avg, false)}
          </td>
        </tr>
      </tfoot>
    </table>
  );
}

export function TxnList({
  rows,
  limit = 40,
  acctName,
  catName,
  showCategory,
  onOpen,
}: {
  rows: Transaction[];
  limit?: number;
  acctName?: (id: string) => string;
  catName?: (id: string) => string;
  showCategory?: boolean;
  onOpen?: () => void;
}) {
  const shown = rows.slice(0, limit);
  return (
    <>
      <table className="w-full table-fixed text-[11px]">
        <tbody>
          {shown.map((t) => (
            <tr key={t.id} className={cx('border-t', rowRule)}>
              <td className={cx('h-[22px] w-[74px] font-mono', tw.ink3)}>
                {t.date}
              </td>
              <td className={cx('truncate pr-2', tw.ink)}>
                {t.merchant}
                <span className={cx('ml-1.5', tw.ink3)}>
                  {showCategory && catName
                    ? catName(t.categoryId)
                    : acctName
                      ? acctName(t.accountId)
                      : ''}
                </span>
              </td>
              <td
                className={cx(
                  'w-[84px] text-right font-mono tabular-nums',
                  t.amount > 0 ? tw.good : tw.ink,
                )}
              >
                {signedMoney(t.amount)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > limit || onOpen ? (
        <div
          className={cx('mt-1.5 flex items-center gap-2 text-[11px]', tw.ink3)}
        >
          {rows.length > limit ? (
            <span>
              {limit} of {rows.length} shown
            </span>
          ) : (
            <span>{rows.length} rows</span>
          )}
          {onOpen ? (
            <button
              type="button"
              onClick={onOpen}
              className={cx('ml-auto hover:underline', tw.accent)}
            >
              Open in Transactions →
            </button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

export function Keys({ items }: { items: [string, string][] }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1 text-[11px]">
      {items.map(([k, v]) => (
        <div key={k} className="contents">
          <dt>
            <Kbd>{k}</Kbd>
          </dt>
          <dd className={tw.ink3}>{v}</dd>
        </div>
      ))}
    </dl>
  );
}
