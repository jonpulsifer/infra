import { useEffect, useMemo, useState } from 'react';
import { Split } from '~/components/Split';
import {
  Block,
  InspectorHead,
  KV,
  rowRule,
  serif,
  TxnList,
} from '~/components/ui';
import type { Ledger } from '~/fixtures/types';
import { isTyping } from '~/lib/keys';
import { topResolver } from '~/lib/ledger';
import { latestFirst, rowsMatching } from '~/lib/reader';
import { cx, groupColor, type Palette, tw } from '~/lib/theme';

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
  const name = useMemo(() => {
    const m = new Map(ledger.categories.map((c) => [c.id, c.name]));
    return (id: string) => m.get(id) ?? id;
  }, [ledger.categories]);
  const q = query.trim().toLowerCase();
  const rules = ledger.rules.filter(
    (r) =>
      !q ||
      r.match.toLowerCase().includes(q) ||
      r.merchant.toLowerCase().includes(q) ||
      name(r.categoryId).toLowerCase().includes(q),
  );
  const [selId, setSelId] = useState(() => fresh[0] ?? ledger.rules[0]?.id);
  const [sheet, setSheet] = useState(false);
  const hits = useMemo(() => {
    const out = new Map<string, number>();
    for (const r of ledger.rules) out.set(r.id, rowsMatching(ledger, r).length);
    return out;
  }, [ledger]);
  const max = Math.max(1, ...hits.values());
  const sel = ledger.rules.find((r) => r.id === selId) ?? null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isTyping(e) || e.metaKey || e.ctrlKey) return;
      if (e.key !== 'j' && e.key !== 'k') return;
      e.preventDefault();
      const i = rules.findIndex((r) => r.id === selId);
      const n = Math.max(
        0,
        Math.min(rules.length - 1, i + (e.key === 'j' ? 1 : -1)),
      );
      if (!rules[n]) return;
      setSelId(rules[n].id);
      document
        .getElementById(`rf-rule-${rules[n].id}`)
        ?.scrollIntoView({ block: 'nearest' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const reader = (
    <div className="mx-auto max-w-[760px] px-5 pt-10 sm:px-10">
      <div className={cx(tw.label, tw.ink3)}>How rows get filed</div>
      <h1 className={cx(serif, 'mt-2 text-[34px] leading-tight', tw.ink)}>
        Rules
      </h1>
      <p className={cx('mt-2 text-[15px] leading-relaxed', tw.ink2)}>
        {ledger.rules.length} rules, read top to bottom; the first whose pattern
        the descriptor contains wins.
        {fresh.length
          ? ` ${fresh.length} ${fresh.length === 1 ? 'was' : 'were'} made this session.`
          : ''}
      </p>
      <ul className={cx('mt-6 border-t', tw.rule)}>
        {rules.length === 0 ? (
          <li className={cx('py-12 text-center text-[12px]', tw.ink3)}>
            No rule matches “{query.trim()}”.
          </li>
        ) : null}
        {rules.map((r) => {
          const on = r.id === selId;
          const isNew = fresh.includes(r.id);
          const n = hits.get(r.id) ?? 0;
          return (
            <li key={r.id}>
              <button
                type="button"
                id={`rf-rule-${r.id}`}
                onClick={() => {
                  setSelId(r.id);
                  setSheet(true);
                }}
                className={cx(
                  'relative grid w-full grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_110px] items-center gap-x-3 border-b py-2 pr-1 pl-3 text-left text-[12px]',
                  rowRule,
                  on
                    ? tw.selected
                    : isNew
                      ? 'bg-[#eef7ee] dark:bg-[#132313]'
                      : tw.hover,
                )}
              >
                {on ? (
                  <span className="absolute inset-y-0 left-0 w-[2px] bg-[#2a78d6] dark:bg-[#3987e5]" />
                ) : null}
                <span className="min-w-0 truncate">
                  <code
                    className={cx(
                      'rounded-[2px] px-1 py-px font-mono text-[11px]',
                      tw.wash,
                      tw.ink,
                    )}
                  >
                    {r.match}
                  </code>
                  {isNew ? (
                    <span
                      className={cx('ml-2 text-[10px] font-medium', tw.good)}
                    >
                      new
                    </span>
                  ) : null}
                </span>
                <span className="flex min-w-0 items-center gap-1.5">
                  <span
                    className="h-2 w-2 shrink-0 rounded-[2px]"
                    style={{
                      background: groupColor(pal, top(r.categoryId).id),
                    }}
                  />
                  <span className={cx('truncate', tw.ink)}>
                    {name(r.categoryId)}
                  </span>
                  <span className={cx('truncate', tw.ink3)}>{r.merchant}</span>
                </span>
                <span className="flex items-center gap-2">
                  <span className={cx('w-8 text-right font-mono', tw.ink)}>
                    {n}
                  </span>
                  <span className="h-[6px] flex-1">
                    <span
                      className="block h-full rounded-r-[2px]"
                      style={{
                        width: `${(n / max) * 100}%`,
                        background: pal.ink3,
                      }}
                    />
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );

  const matched = sel ? latestFirst(rowsMatching(ledger, sel)) : [];
  const off = sel ? matched.filter((t) => t.categoryId !== sel.categoryId) : [];

  return (
    <Split
      open={sheet}
      setOpen={setSheet}
      peek={sel ? sel.match : 'No rule selected'}
      reader={reader}
      inspector={
        sel ? (
          <div key={sel.id} className="rf-in">
            <InspectorHead
              kicker={
                sel.createdFrom === 'seed' ? 'Seed rule' : 'From a correction'
              }
              title={<span className="font-mono text-[14px]">{sel.match}</span>}
              figure={matched.length}
              sub={`Files ${sel.merchant} under ${name(sel.categoryId)}`}
            />
            <Block title="The rule">
              <KV
                rows={[
                  [
                    'Contains',
                    <span key="v" className="font-mono">
                      {sel.match}
                    </span>,
                  ],
                  ['Category', name(sel.categoryId)],
                  ['Merchant', sel.merchant],
                  ['Matches', `${matched.length} rows`],
                  [
                    'Disagree',
                    off.length
                      ? `${off.length} filed elsewhere by hand or by an earlier rule`
                      : 'none',
                    off.length ? tw.warn : '',
                  ],
                ]}
              />
            </Block>
            <Block title="Rows it matches" right="latest first">
              <TxnList rows={matched} limit={30} catName={name} showCategory />
            </Block>
          </div>
        ) : (
          <div className={cx('p-6 text-[12px]', tw.ink3)}>
            No rule selected.
          </div>
        )
      }
    />
  );
}
