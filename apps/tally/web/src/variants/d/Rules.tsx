import { useMemo } from 'react';
import type { Ledger } from '~/fixtures/types';
import { Fig, Swatch } from './bits';
import { topResolver } from './model';
import { cx, type Palette, tw } from './theme';

export function Rules({
  ledger,
  pal,
  query,
  fresh,
}: {
  ledger: Ledger;
  pal: Palette;
  query: string;
  fresh: string[];
}) {
  const top = useMemo(
    () => topResolver(ledger.categories),
    [ledger.categories],
  );
  const name = useMemo(
    () => new Map(ledger.categories.map((c) => [c.id, c.name])),
    [ledger.categories],
  );
  const q = query.trim().toLowerCase();
  const rules = ledger.rules.filter(
    (r) =>
      !q ||
      r.match.toLowerCase().includes(q) ||
      r.merchant.toLowerCase().includes(q) ||
      (name.get(r.categoryId) ?? '').toLowerCase().includes(q),
  );
  const maxHits = Math.max(1, ...ledger.rules.map((r) => r.hits));
  const live = useMemo(() => {
    const out = new Map<string, number>();
    for (const r of ledger.rules) {
      const p = r.match.toLowerCase();
      out.set(
        r.id,
        ledger.transactions.filter((t) =>
          t.descriptor.toLowerCase().includes(p),
        ).length,
      );
    }
    return out;
  }, [ledger]);
  const busiest = [...ledger.rules].sort(
    (a, b) => (live.get(b.id) ?? 0) - (live.get(a.id) ?? 0),
  )[0];
  const freshRows = fresh.reduce((s, id) => s + (live.get(id) ?? 0), 0);

  return (
    <div className="h-full overflow-auto pb-16">
      <div
        className={cx(
          'flex h-10 items-center gap-3 border-b px-3 text-[12px]',
          tw.rule,
        )}
      >
        <span className={cx(tw.label, tw.ink2)}>Rules</span>
        <span className={cx('truncate', tw.ink2)}>
          {ledger.rules.length} rules, first match wins, top to bottom.
          {busiest ? (
            <>
              {' '}
              The busiest,{' '}
              <code className={cx('font-mono text-[11px]', tw.ink)}>
                {busiest.match}
              </code>
              , files <Fig>{live.get(busiest.id) ?? busiest.hits}</Fig> rows
              under {name.get(busiest.categoryId)}
            </>
          ) : null}
          {fresh.length ? (
            <>
              ; <Fig tone="good">{fresh.length}</Fig> made this session now file{' '}
              <Fig tone="good">{freshRows}</Fig> rows
            </>
          ) : null}
          .
        </span>
      </div>
      <table className="w-full min-w-[760px] table-fixed border-separate border-spacing-0 text-[12px]">
        <thead className={cx('sticky top-0 z-10', tw.surface)}>
          <tr className={cx(tw.label, tw.ink3)}>
            {[
              ['Descriptor contains', 'w-[30%] pl-3'],
              ['Merchant', ''],
              ['Category', 'w-[24%]'],
              ['Matches', 'w-[22%]'],
              ['Origin', 'w-[104px] pr-3'],
            ].map(([h, c]) => (
              <th
                key={h}
                className={cx('h-7 border-b text-left font-medium', tw.rule, c)}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rules.length === 0 ? (
            <tr>
              <td colSpan={5} className={cx('py-16 text-center', tw.ink3)}>
                No rule matches “{query.trim()}”.
              </td>
            </tr>
          ) : null}
          {rules.map((r) => {
            const isNew = fresh.includes(r.id);
            const n = live.get(r.id) ?? r.hits;
            return (
              <tr
                key={r.id}
                className={cx(
                  isNew ? 'bg-[#eef7ee] dark:bg-[#132313]' : tw.hover,
                  'animate-[desk-in_200ms_ease-out]',
                )}
              >
                <td
                  className={cx(
                    'h-8 border-b pl-3',
                    'border-[#efeee9] dark:border-[#20201e]',
                  )}
                >
                  <code
                    className={cx(
                      'rounded-[2px] px-1 py-px font-mono text-[11px]',
                      tw.wash,
                      tw.ink,
                    )}
                  >
                    {r.match}
                  </code>
                </td>
                <td
                  className={cx(
                    'truncate border-b',
                    'border-[#efeee9] dark:border-[#20201e]',
                    tw.ink,
                  )}
                >
                  {r.merchant}
                </td>
                <td
                  className={cx(
                    'border-b',
                    'border-[#efeee9] dark:border-[#20201e]',
                  )}
                >
                  <span className="flex items-center gap-2">
                    <Swatch
                      color={pal.cat[top(r.categoryId).id] ?? pal.spend}
                    />
                    <span className={tw.ink}>{name.get(r.categoryId)}</span>
                  </span>
                </td>
                <td
                  className={cx(
                    'border-b pr-4',
                    'border-[#efeee9] dark:border-[#20201e]',
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span className={cx('w-9 text-right', tw.num, tw.ink)}>
                      {n}
                    </span>
                    <div className="h-2 flex-1">
                      <div
                        className="h-2 rounded-r-[2px]"
                        style={{
                          width: `${Math.min(1, n / maxHits) * 100}%`,
                          background: pal.ink3,
                        }}
                      />
                    </div>
                  </div>
                </td>
                <td
                  className={cx(
                    'border-b pr-3 text-[11px]',
                    'border-[#efeee9] dark:border-[#20201e]',
                  )}
                >
                  {isNew ? (
                    <span className={cx('font-medium', tw.good)}>
                      new · correction
                    </span>
                  ) : (
                    <span className={tw.ink3}>{r.createdFrom}</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
