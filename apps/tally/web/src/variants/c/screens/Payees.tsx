import { ChevronRight, List } from 'lucide-react';
import { useMemo, useState } from 'react';
import { topMerchants } from '~/fixtures/derive';
import {
  Answer,
  Aside,
  AsideSection,
  CategoryChip,
  Monogram,
  NumbersList,
  PrimaryButton,
  Segmented,
  Sheet,
} from '../bits';
import {
  accountName,
  categoryName,
  dayLabel,
  money,
  moneyCents,
  monthEnd,
  monthLong,
  pct,
  periodFrom,
} from '../model';
import { useTally } from '../store';

type Span = '1' | '3' | '12';

export function Payees() {
  const { eff, month, pal, go, spendMonths } = useTally();
  const [span, setSpan] = useState<Span>('1');
  const [pick, setPick] = useState<string | null>(null);
  const n = Number(span);
  const from = periodFrom(month, n);
  const to = monthEnd(month);
  const list = useMemo(
    () => topMerchants(eff, { from, to, limit: 12 }),
    [eff, from, to],
  );
  const total = Array.from(spendMonths.entries())
    .filter(([m]) => m >= from.slice(0, 7) && m <= month)
    .reduce((s, [, v]) => s + v, 0);
  const top5 = list.slice(0, 5).reduce((s, x) => s + x.total, 0);
  const when =
    n === 1
      ? `in ${monthLong(month)}`
      : n === 3
        ? 'over three months'
        : 'over the year';
  const max = list[0]?.total ?? 1;
  const rows = useMemo(
    () =>
      pick
        ? eff.transactions
            .filter(
              (t) =>
                t.merchant === pick &&
                t.date >= from &&
                t.date <= to &&
                t.amount < 0 &&
                !t.transferId,
            )
            .reverse()
        : [],
    [eff, pick, from, to],
  );
  const picked = list.find((x) => x.merchant === pick);

  return (
    <div className="qc-in">
      <Answer
        question="Who do I pay most?"
        onBack={() => go({ question: null })}
        line={
          list[0]
            ? `You paid ${list[0].merchant} most: ${money(list[0].total)} ${when}`
            : `You paid nobody ${when}`
        }
        sub={
          total
            ? `Your top five took ${pct(top5 / total)} of the ${money(total)} you spent.`
            : undefined
        }
      />
      <div className="px-4">
        <Segmented
          label="Period length"
          value={span}
          onChange={setSpan}
          options={[
            { key: '1', label: 'Month' },
            { key: '3', label: '3 months' },
            { key: '12', label: 'Year' },
          ]}
        />
      </div>
      {list.length ? (
        <ol className="mt-4 space-y-2 px-4">
          {list.map((m, i) => (
            <li
              key={m.merchant}
              className="qc-in"
              style={{ animationDelay: `${i * 25}ms` }}
            >
              <button
                type="button"
                onClick={() => setPick(m.merchant)}
                className="group flex w-full items-center gap-3 rounded-2xl bg-white px-3 py-3 text-left ring-1 ring-stone-200/80 transition hover:ring-amber-300 active:scale-[0.99] dark:bg-stone-900 dark:ring-stone-800 dark:hover:ring-amber-500/50"
              >
                <span className="w-5 text-center text-sm font-semibold text-stone-400 tabular-nums">
                  {i + 1}
                </span>
                <Monogram name={m.merchant} tone={i < 3 ? 'warm' : 'plain'} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-[0.98rem] font-semibold text-stone-900 dark:text-stone-50">
                      {m.merchant}
                    </span>
                    <span className="text-[0.98rem] font-semibold text-stone-900 tabular-nums dark:text-stone-50">
                      {money(m.total)}
                    </span>
                  </span>
                  <span className="mt-1.5 block h-1.5 overflow-hidden rounded-full bg-stone-100 dark:bg-stone-800">
                    <span
                      className="block h-full rounded-full transition-[width] duration-300"
                      style={{
                        width: `${(m.total / max) * 100}%`,
                        background: pal.accent,
                      }}
                    />
                  </span>
                  <span className="mt-1.5 flex items-center justify-between text-xs text-stone-500">
                    <span>{categoryName(eff, m.categoryId)}</span>
                    <span>
                      {m.count} payment{m.count === 1 ? '' : 's'}
                    </span>
                  </span>
                </span>
                <ChevronRight
                  aria-hidden
                  className="size-4 shrink-0 text-stone-400 transition group-hover:translate-x-0.5"
                />
              </button>
            </li>
          ))}
        </ol>
      ) : (
        <p className="mx-4 mt-6 rounded-2xl bg-white p-6 text-center text-sm text-stone-500 ring-1 ring-stone-200 dark:bg-stone-900 dark:ring-stone-800">
          No spending in this period.
        </p>
      )}

      <Sheet
        open={!!pick}
        onClose={() => setPick(null)}
        title={
          <span className="flex items-center gap-3">
            {pick ? <Monogram name={pick} size={36} tone="warm" /> : null}
            {pick}
          </span>
        }
        footer={
          <PrimaryButton
            className="w-full"
            onClick={() =>
              go({ tab: 'ledger', question: null, ledgerText: pick ?? '' })
            }
          >
            <List className="size-4" aria-hidden />
            Every {pick} row in the ledger
          </PrimaryButton>
        }
      >
        {picked ? (
          <div className="mb-4 grid grid-cols-3 gap-2">
            {[
              ['Paid', money(picked.total)],
              ['Payments', String(picked.count)],
              ['Average', money(picked.total / picked.count)],
            ].map(([k, v]) => (
              <div
                key={k}
                className="rounded-2xl bg-white p-3 ring-1 ring-stone-200 dark:bg-stone-950/60 dark:ring-stone-800"
              >
                <div className="text-xs text-stone-500">{k}</div>
                <div className="mt-0.5 text-lg font-semibold">{v}</div>
              </div>
            ))}
          </div>
        ) : null}
        <ul className="divide-y divide-stone-200 dark:divide-stone-800">
          {rows.map((t) => (
            <li key={t.id} className="flex items-center gap-3 py-3">
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-[13px]">
                  {t.descriptor}
                </div>
                <div className="mt-1 flex items-center gap-2 text-xs text-stone-500">
                  <span>{dayLabel(t.date)}</span>
                  <span>·</span>
                  <span>{accountName(eff, t.accountId)}</span>
                  <CategoryChip
                    ledger={eff}
                    categoryId={t.categoryId}
                    name={categoryName(eff, t.categoryId)}
                    pal={pal}
                    manual={t.source === 'manual'}
                  />
                </div>
              </div>
              <span className="text-sm font-medium tabular-nums">
                {moneyCents(t.amount)}
              </span>
            </li>
          ))}
        </ul>
      </Sheet>

      <Aside>
        <AsideSection title={`Top payees ${when}`}>
          <NumbersList
            rows={list.map((m, i) => ({
              label: `${i + 1}. ${m.merchant}`,
              value: money(m.total),
            }))}
          />
        </AsideSection>
      </Aside>
    </div>
  );
}
