import { useMemo } from 'react';
import {
  Answer,
  Aside,
  AsideSection,
  Card,
  Disclosure,
  NumbersList,
} from '../bits';
import { type Col, Columns } from '../charts/Columns';
import {
  isPartialMonth,
  money,
  monthLong,
  monthShort,
  pct,
  shiftMonth,
} from '../model';
import { useTally } from '../store';

export function Saving() {
  const { eff, flows, month, setMonth, pal, go } = useTally();
  const byMonth = useMemo(
    () => new Map(flows.map((r) => [r.month, r])),
    [flows],
  );
  const row = byMonth.get(month) ?? { month, income: 0, spend: 0, net: 0 };
  const from = shiftMonth(month, -11);
  const span = Array.from({ length: 12 }, (_, i) => shiftMonth(from, i));
  const wIn = span.reduce((s, m) => s + (byMonth.get(m)?.income ?? 0), 0);
  const wNet = span.reduce((s, m) => s + (byMonth.get(m)?.net ?? 0), 0);
  const partial = isPartialMonth(eff, month);
  const name = `${monthLong(month, month.slice(0, 4) !== eff.asOf.slice(0, 4))}${partial ? ' so far' : ''}`;

  const cols: Col[] = span.map((m, i) => {
    const r = byMonth.get(m);
    const net = r?.net ?? 0;
    return {
      key: m,
      label: monthShort(m),
      sub: m.endsWith('-01') || i === 0 ? m.slice(0, 4) : undefined,
      segs: [
        {
          id: 'net',
          name: net >= 0 ? 'Kept' : 'Overspent',
          value: net,
          color: net >= 0 ? pal.positive : pal.negative,
        },
      ],
      detail: [
        { label: 'Came in', value: money(r?.income ?? 0) },
        { label: 'Went out', value: money(r?.spend ?? 0) },
      ],
    };
  });

  const yes = row.net > 0;
  const rate = row.income ? row.net / row.income : 0;
  const rows = [
    { label: 'Came in', value: money(row.income) },
    { label: 'Went out', value: money(row.spend) },
    {
      label: yes ? 'Kept' : 'Overspent',
      value: money(Math.abs(row.net)),
      strong: true,
    },
    { label: 'Kept, last 12 months', value: money(wNet) },
    { label: 'Rate, last 12 months', value: wIn ? pct(wNet / wIn) : '–' },
  ];

  return (
    <div className="qc-in">
      <Answer
        question="Am I saving?"
        onBack={() => go({ question: null })}
        line={
          yes
            ? `Yes. You kept ${money(row.net)} of ${money(row.income)} in ${name}`
            : `Not in ${name}. ${money(-row.net)} more went out than came in`
        }
        sub={
          <>
            {yes ? `That's ${pct(rate)} of what came in. ` : ''}
            Over the twelve months to {monthShort(month)} you kept{' '}
            {wIn ? pct(wNet / wIn) : 'none'} of your income.
            {partial
              ? ` The month isn't over: the ledger runs to ${eff.asOf.slice(8)} ${monthShort(month)}.`
              : ''}
          </>
        }
      />
      <div className="px-4">
        <div className="mb-3 flex gap-4 text-xs text-stone-600 dark:text-stone-400">
          <span className="inline-flex items-center gap-1.5">
            <span
              aria-hidden
              className="size-2.5 rounded-sm"
              style={{ background: pal.positive }}
            />
            Kept
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span
              aria-hidden
              className="size-2.5 rounded-sm"
              style={{ background: pal.negative }}
            />
            Overspent
          </span>
        </div>
        <Columns
          cols={cols}
          selected={month}
          onSelect={setMonth}
          height={300}
          pal={pal}
          label="Money kept or overspent each month for the twelve months up to the selected month"
          showTotal={false}
        />
      </div>
      <Card className="mx-4 mt-5 grid grid-cols-3 divide-x divide-stone-200 dark:divide-stone-800">
        {[
          ['In', row.income],
          ['Out', row.spend],
          [yes ? 'Kept' : 'Short', Math.abs(row.net)],
        ].map(([k, v]) => (
          <div key={k as string} className="p-3.5">
            <div className="text-xs text-stone-500">{k}</div>
            <div className="mt-1 text-lg font-semibold tracking-tight">
              {money(v as number)}
            </div>
          </div>
        ))}
      </Card>
      <p className="mx-4 mt-3 text-xs text-stone-500">
        Moving money to savings, the TFSA or the RRSP counts as kept, not spent.
      </p>
      <Disclosure title="See the numbers" className="mx-4 mt-3 lg:hidden">
        <NumbersList rows={rows} />
      </Disclosure>
      <Aside>
        <AsideSection title={monthLong(month, true)}>
          <NumbersList rows={rows} />
        </AsideSection>
      </Aside>
    </div>
  );
}
