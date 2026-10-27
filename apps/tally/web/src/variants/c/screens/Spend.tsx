import { ChevronDown } from 'lucide-react';
import { useMemo, useState } from 'react';
import { monthlySpendByCategory, sankey } from '~/fixtures/derive';
import {
  Answer,
  Aside,
  AsideSection,
  Disclosure,
  type NumberRow,
  NumbersList,
  Segmented,
} from '../bits';
import { type Col, Columns } from '../charts/Columns';
import { type FlowLink, type FlowNode, FlowSankey } from '../charts/FlowSankey';
import {
  groupOf,
  money,
  monthEnd,
  monthLong,
  monthShort,
  pct,
  shiftMonth,
  spendAnswer,
} from '../model';
import { useTally } from '../store';
import { GROUP_ORDER, groupColor } from '../theme';

type Mode = 'flow' | 'months';

const ORDER = [...GROUP_ORDER, 'uncategorized'];

export function Spend() {
  const { eff, month, setMonth, pal, go, spendMonths } = useTally();
  const [mode, setMode] = useState<Mode>('flow');
  const [open, setOpen] = useState<string | null>(null);
  const answer = spendAnswer(eff, month, spendMonths);

  const data = useMemo(
    () => sankey(eff, { from: `${month}-01`, to: monthEnd(month) }),
    [eff, month],
  );

  const view = useMemo(() => {
    const val = new Map<string, number>();
    for (const l of data.links)
      val.set(l.target, (val.get(l.target) ?? 0) + l.value);
    for (const l of data.links)
      if (l.source.startsWith('src:'))
        val.set(l.source, (val.get(l.source) ?? 0) + l.value);
    const colorOf = (id: string) => {
      if (id.startsWith('src:') || id === 'all') return pal.neutralNode;
      const raw = id.split(':')[1];
      if (id.startsWith('grp:')) return groupColor(raw, pal);
      if (raw === 'saved') return groupColor('saved', pal);
      return groupColor(groupOf(eff, raw), pal);
    };
    const rank = (id: string) => {
      if (id.startsWith('src:')) return 0;
      if (id === 'all') return 1;
      if (id.startsWith('grp:')) return 2 + ORDER.indexOf(id.slice(4)) / 10;
      if (id === 'leaf:saved') return 3;
      return 4;
    };
    const nodes: FlowNode[] = data.nodes
      .map((n) => ({ id: n.id, name: n.name, color: colorOf(n.id) }))
      .sort(
        (a, b) =>
          rank(a.id) - rank(b.id) ||
          (val.get(b.id) ?? 0) - (val.get(a.id) ?? 0),
      );
    const links: FlowLink[] = data.links
      .filter((l) => l.value > 0)
      .filter((l) => !l.source.startsWith('grp:') || l.source === open)
      .map((l) => ({
        ...l,
        color: l.source.startsWith('src:')
          ? pal.neutralLink
          : colorOf(l.target),
      }));
    const income = data.links
      .filter((l) => l.target === 'all')
      .reduce((s, l) => s + l.value, 0);
    const groups = data.links
      .filter((l) => l.source === 'all')
      .map((l) => ({
        id: l.target,
        name: nodes.find((n) => n.id === l.target)?.name ?? l.target,
        value: l.value,
        color: colorOf(l.target),
        leaves: data.links
          .filter((x) => x.source === l.target)
          .sort((a, b) => b.value - a.value)
          .map((x) => ({
            id: x.target,
            name: data.nodes.find((n) => n.id === x.target)?.name ?? x.target,
            value: x.value,
          })),
      }))
      .sort((a, b) => rank(a.id) - rank(b.id));
    const out = groups.reduce((s, g) => s + g.value, 0);
    const short = out - income;
    if (short > 0 && income > 0) {
      nodes.unshift({
        id: 'src:short',
        name: 'Not covered',
        color: pal.negative,
      });
      links.push({
        source: 'src:short',
        target: 'all',
        value: short,
        color: pal.negative,
      });
      const all = nodes.find((n) => n.id === 'all');
      if (all) all.name = 'Spending';
    }
    return { nodes, links, income, groups, out };
  }, [data, open, pal, eff]);

  const cols = useMemo<Col[]>(() => {
    const from = shiftMonth(month, -11);
    const m = monthlySpendByCategory(eff, { from, to: month });
    const byMonth = new Map(
      m.rows.map((r) => [r.month, r as Record<string, number | string>]),
    );
    return Array.from({ length: 12 }, (_, i) => {
      const ym = shiftMonth(from, i);
      const r = byMonth.get(ym) ?? {};
      return {
        key: ym,
        label: monthShort(ym),
        sub: ym.endsWith('-01') || i === 0 ? ym.slice(0, 4) : undefined,
        segs: ORDER.filter((k) => typeof r[k] === 'number').map((k) => ({
          id: k,
          name: m.names[k] ?? k,
          value: r[k] as number,
          color: groupColor(k, pal),
        })),
      };
    });
  }, [eff, month, pal]);

  const spentGroups = view.groups.filter((g) => g.id !== 'leaf:saved');
  const top = [...spentGroups].sort((a, b) => b.value - a.value)[0];
  const saved = view.groups.find((g) => g.id === 'leaf:saved');
  const numbers: NumberRow[] = [
    { label: 'Came in', value: money(view.income), strong: true },
    ...view.groups.map((g) => ({
      label: g.name,
      value: money(g.value),
      swatch: g.color,
    })),
  ];

  return (
    <div className="qc-in">
      <Answer
        question={`Where did ${monthLong(month)} go?`}
        onBack={() => go({ question: null })}
        line={answer.line}
        sub={
          top
            ? `${top.name} took the most: ${money(top.value)}, ${pct(top.value / Math.max(1, answer.spent))} of spending.`
            : 'Nothing was spent this month.'
        }
      />
      <div className="px-4">
        <Segmented
          label="View"
          value={mode}
          onChange={setMode}
          options={[
            { key: 'flow', label: 'Where it went' },
            { key: 'months', label: 'Month by month' },
          ]}
        />
      </div>

      {mode === 'flow' ? (
        <div className="mt-4 px-4">
          <FlowSankey
            nodes={view.nodes}
            links={view.links}
            pal={pal}
            label={`Money in ${monthLong(month, true)}: income at the top, flowing down into spending groups${open ? ' and categories' : ''}.`}
            onNode={(id) => {
              if (id.startsWith('grp:')) setOpen((o) => (o === id ? null : id));
            }}
          />
          <ul className="mt-5 divide-y divide-stone-200/80 rounded-2xl bg-white ring-1 ring-stone-200/80 dark:divide-stone-800 dark:bg-stone-900 dark:ring-stone-800">
            {view.groups.map((g) => {
              const can = g.leaves.length > 0;
              const isOpen = open === g.id;
              return (
                <li key={g.id}>
                  <button
                    type="button"
                    disabled={!can}
                    aria-expanded={can ? isOpen : undefined}
                    onClick={() => setOpen(isOpen ? null : g.id)}
                    className="flex min-h-13 w-full items-center gap-3 px-4 py-3 text-left disabled:cursor-default"
                  >
                    <span
                      aria-hidden
                      className="size-3 shrink-0 rounded-sm"
                      style={{ background: g.color }}
                    />
                    <span className="flex-1 text-[0.95rem] font-medium">
                      {g.name}
                    </span>
                    <span className="text-xs text-stone-500 tabular-nums">
                      {pct(g.value / Math.max(1, view.out))}
                    </span>
                    <span className="w-24 text-right text-[0.95rem] font-semibold tabular-nums">
                      {money(g.value)}
                    </span>
                    <ChevronDown
                      aria-hidden
                      className={`size-4 text-stone-400 transition ${isOpen ? 'rotate-180' : ''} ${can ? '' : 'invisible'}`}
                    />
                  </button>
                  {isOpen ? (
                    <ul className="qc-fade pb-2">
                      {g.leaves.map((l) => (
                        <li
                          key={l.id}
                          className="flex items-center justify-between py-1.5 pr-11 pl-10 text-sm text-stone-600 dark:text-stone-400"
                        >
                          <span>{l.name}</span>
                          <span className="tabular-nums">{money(l.value)}</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {!saved && view.income > 0 ? (
            <p className="mt-3 text-sm text-red-700 dark:text-red-300">
              Spending passed income by {money(answer.spent - view.income)} this
              month.
            </p>
          ) : null}
          <p className="mt-3 text-xs text-stone-500">
            Tap a group, in the chart or the list, to split it into categories.
            Transfers between your own accounts are left out.
          </p>
        </div>
      ) : (
        <div className="mt-4 px-4">
          <div className="mb-3 flex flex-wrap gap-x-3 gap-y-1.5 text-xs text-stone-600 dark:text-stone-400">
            {ORDER.map((k) => (
              <span key={k} className="inline-flex items-center gap-1.5">
                <span
                  aria-hidden
                  className="size-2.5 rounded-sm"
                  style={{ background: groupColor(k, pal) }}
                />
                {eff.categories.find((c) => c.id === k)?.name}
              </span>
            ))}
          </div>
          <div>
            <Columns
              cols={cols}
              selected={month}
              onSelect={setMonth}
              height={300}
              pal={pal}
              label="Spending by group for the twelve months up to the selected month"
            />
          </div>
          <p className="mt-3 text-xs text-stone-500">
            Tap a column to answer for that month.
          </p>
        </div>
      )}

      <Disclosure title="See the numbers" className="mx-4 mt-4 lg:hidden">
        <NumbersList rows={numbers} />
      </Disclosure>

      <Aside>
        <AsideSection title={monthLong(month, true)}>
          <NumbersList
            rows={[
              ...numbers,
              { label: 'Usual month', value: money(answer.usual) },
            ]}
          />
        </AsideSection>
      </Aside>
    </div>
  );
}
