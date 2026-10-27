import { Info } from 'lucide-react';
import type { NetWorthPoint } from '~/fixtures/derive';
import {
  Answer,
  Aside,
  AsideSection,
  Card,
  Disclosure,
  type NumberRow,
  NumbersList,
} from '../bits';
import { Trend } from '../charts/Trend';
import {
  money,
  moneyShort,
  moneySigned,
  monthLong,
  monthShort,
} from '../model';
import { useTally } from '../store';
import { WORTH_PARTS } from '../theme';

function yearRows(nw: NetWorthPoint[]): NumberRow[] {
  const rows = nw
    .filter((p, i) => p.month.endsWith('-12') || i === nw.length - 1)
    .map((p) => ({
      label: monthLong(p.month, true),
      value: money(p.total),
      hint: p.estimated ? 'est.' : undefined,
    }));
  return rows.reverse();
}

export function Worth() {
  const { nw, month, setMonth, pal, go } = useTally();
  const found = nw.findIndex((p) => p.month === month);
  const idx = found >= 0 ? found : nw.length - 1;
  const p = nw[idx];
  const prev = nw[idx - 12];
  const latest = idx === nw.length - 1;
  const parts = WORTH_PARTS.map((part, i) => ({
    ...part,
    value: p[part.key],
    was: prev ? prev[part.key] : null,
    color: pal.series[i],
  }));
  const maxAbs = Math.max(1, ...parts.map((x) => Math.abs(x.value)));

  return (
    <div className="qc-in">
      <Answer
        question="What am I worth?"
        onBack={() => go({ question: null })}
        line={
          latest
            ? `You're worth ${money(p.total)}`
            : `In ${monthLong(p.month, true)} you were worth ${money(p.total)}`
        }
        sub={
          prev
            ? `${moneySigned(p.total - prev.total)} on the year before. Drag the chart to go back in time.`
            : 'This is where the ledger starts. Drag the chart to move through time.'
        }
      />
      <div className="px-2">
        <Trend
          data={nw.map((x) => ({ key: x.month, value: x.total }))}
          index={idx}
          onIndex={(i) => setMonth(nw[i].month)}
          height={360}
          color={pal.accent}
          pal={pal}
          label="Net worth by month. Use the arrow keys to move through months."
          pointLabel={(x) => `${monthShort(x.key)} ${x.key.slice(0, 4)}`}
          xLabel={(x) => (x.key.endsWith('-01') ? x.key.slice(0, 4) : null)}
        />
      </div>
      {p.estimated ? (
        <p className="mx-4 mt-2 flex items-start gap-2 text-xs text-stone-500">
          <Info className="mt-px size-3.5 shrink-0" aria-hidden />
          Investments or the house use the last statement before this month.
        </p>
      ) : null}

      <Card className="mx-4 mt-5 p-4">
        <h2 className="text-sm font-semibold text-stone-900 dark:text-stone-100">
          What it's made of in {monthShort(p.month)} {p.month.slice(0, 4)}
        </h2>
        <ul className="mt-3 space-y-3.5">
          {parts.map((x) => (
            <li key={x.key}>
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="flex items-center gap-2 text-stone-700 dark:text-stone-300">
                  <span
                    aria-hidden
                    className="size-2.5 rounded-sm"
                    style={{ background: x.color }}
                  />
                  {x.name}
                </span>
                <span className="font-semibold text-stone-900 tabular-nums dark:text-stone-50">
                  {money(x.value)}
                </span>
              </div>
              <div className="mt-1.5 flex items-center gap-2">
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-stone-200/70 dark:bg-stone-800">
                  <div
                    className="h-full rounded-full transition-[width] duration-200"
                    style={{
                      width: `${(Math.abs(x.value) / maxAbs) * 100}%`,
                      background: x.color,
                    }}
                  />
                </div>
                <span className="w-16 text-right text-xs text-stone-500 tabular-nums">
                  {x.was === null
                    ? ''
                    : `${x.value - x.was > 0 ? '+' : ''}${moneyShort(x.value - x.was)}`}
                </span>
              </div>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-stone-500">
          Right column: change on the year before. The mortgage is owed, so it
          counts against you.
        </p>
      </Card>

      <Disclosure title="See the numbers" className="mx-4 mt-3 lg:hidden">
        <NumbersList rows={yearRows(nw)} />
      </Disclosure>

      <Aside>
        <div className="space-y-4">
          <AsideSection title={`${monthShort(p.month)} ${p.month.slice(0, 4)}`}>
            <NumbersList
              rows={[
                ...parts.map((x) => ({
                  label: x.name,
                  value: money(x.value),
                  swatch: x.color,
                })),
                { label: 'Net worth', value: money(p.total), strong: true },
              ]}
            />
          </AsideSection>
          <AsideSection title="Year ends">
            <NumbersList rows={yearRows(nw)} />
          </AsideSection>
        </div>
      </Aside>
    </div>
  );
}
