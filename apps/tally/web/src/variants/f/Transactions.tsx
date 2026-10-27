import {
  AlertTriangle,
  ArrowLeftRight,
  Check,
  ChevronDown,
  CornerDownLeft,
  Pencil,
  Sparkles,
} from 'lucide-react';
import { type Dispatch, useEffect, useMemo, useRef, useState } from 'react';
import { monthKey, months, searchTransactions } from '~/fixtures/derive';
import type { Ledger, Rule, Transaction } from '~/fixtures/types';
import { isTyping, Kbd, useWidth } from '~/variants/a/bits';
import { mLong, Sparkline } from '~/variants/a/charts';
import {
  type Action,
  categoryOptions,
  type LedgerRow,
  patternFor,
  similarTo,
  topResolver,
  toRows,
  transferIndex,
} from '~/variants/a/model';
import type { Period } from '~/variants/a/period';
import { cx, money, type Palette, pct, tw } from '~/variants/a/theme';
import { Split } from './Split';
import { byMonth, latestFirst, rowsMatching, ruleFor } from './state';
import {
  Block,
  groupColor,
  InspectorHead,
  Keys,
  KV,
  rowRule,
  serif,
  TxnList,
} from './ui';

const LIMIT = 300;

type Pending = {
  id: string;
  categoryId: string;
  pattern: string;
  done?: { rule: Rule; moved: number };
};

export function Transactions({
  ledger,
  pal,
  period,
  query,
  preset,
  dispatch,
  showRules,
}: {
  ledger: Ledger;
  pal: Palette;
  period: Period;
  query: string;
  preset: { categoryId?: string; n: number };
  dispatch: Dispatch<Action>;
  showRules: () => void;
}) {
  const [accountId, setAccountId] = useState('');
  const [categoryId, setCategoryId] = useState(preset.categoryId ?? '');
  const [review, setReview] = useState(false);
  const [selId, setSelId] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [keep, setKeep] = useState<Set<string>>(new Set());
  const [flash, setFlash] = useState<Set<string>>(new Set());
  const [sheet, setSheet] = useState(false);
  const selectRefs = useRef(new Map<string, HTMLSelectElement>());

  useEffect(() => {
    setCategoryId(preset.categoryId ?? '');
  }, [preset.n]);

  const top = useMemo(
    () => topResolver(ledger.categories),
    [ledger.categories],
  );
  const catName = useMemo(() => {
    const m = new Map(ledger.categories.map((c) => [c.id, c.name]));
    return (id: string) => m.get(id) ?? id;
  }, [ledger.categories]);
  const acct = useMemo(
    () => new Map(ledger.accounts.map((a) => [a.id, a])),
    [ledger.accounts],
  );
  const acctLabel = (id: string) => {
    const a = acct.get(id);
    return a ? `${a.institution} ${a.name}` : id;
  };
  const groups = useMemo(() => {
    const g = new Map<string, { id: string; label: string }[]>();
    for (const o of categoryOptions(ledger.categories))
      g.set(o.group, [...(g.get(o.group) ?? []), o]);
    return Array.from(g.entries());
  }, [ledger.categories]);
  const idx = useMemo(() => transferIndex(ledger), [ledger]);

  const list = useMemo(() => {
    const base = searchTransactions(ledger, {
      text: query,
      accountId: accountId || undefined,
      from: period.from,
      to: period.to,
    });
    return base.filter((t) => {
      if (keep.has(t.id)) return true;
      if (
        categoryId &&
        t.categoryId !== categoryId &&
        top(t.categoryId).id !== categoryId
      )
        return false;
      if (
        review &&
        !(
          t.categoryId === 'uncategorized' ||
          (t.source === 'model' && (t.confidence ?? 1) < 0.8)
        )
      )
        return false;
      return true;
    });
  }, [ledger, query, accountId, categoryId, review, period, keep, top]);

  const rows = useMemo(() => toRows(list, idx, LIMIT), [list, idx]);
  const rowId = (r: LedgerRow) => (r.kind === 'txn' ? r.t.id : r.out.id);
  const selIndex = rows.findIndex((r) => rowId(r) === selId);
  const sel = selIndex >= 0 ? rows[selIndex] : null;

  const sums = useMemo(() => {
    let inflow = 0;
    let outflow = 0;
    let pairs = 0;
    const byGroup = new Map<string, number>();
    for (const t of list) {
      if (t.transferId) {
        if (t.amount < 0) pairs++;
        continue;
      }
      if (t.amount > 0) inflow += t.amount;
      else {
        outflow += t.amount;
        const g = top(t.categoryId).id;
        byGroup.set(g, (byGroup.get(g) ?? 0) - t.amount);
      }
    }
    return { inflow, outflow, pairs, byGroup };
  }, [list, top]);

  const pendingTxn = pending
    ? (ledger.transactions.find((t) => t.id === pending.id) ?? null)
    : null;
  const similar = useMemo(
    () =>
      pending && !pending.done && pending.pattern.trim().length >= 3
        ? similarTo(
            ledger,
            pending.pattern.trim(),
            pending.categoryId,
            pending.id,
          )
        : [],
    [ledger, pending],
  );

  const pulse = (ids: string[]) => {
    setFlash(new Set(ids));
    window.setTimeout(() => setFlash(new Set()), 1400);
  };

  const recategorise = (t: Transaction, cat: string) => {
    if (cat === t.categoryId) return;
    dispatch({ type: 'recategorise', ids: [t.id], categoryId: cat });
    setKeep((k) => new Set(k).add(t.id));
    setSelId(t.id);
    setPending({ id: t.id, categoryId: cat, pattern: patternFor(t) });
    setSheet(true);
    pulse([t.id]);
  };

  const makeRule = () => {
    if (!pending || pending.done || !pendingTxn) return;
    const pattern = pending.pattern.trim();
    if (pattern.length < 3) return;
    const rule: Rule = {
      id: `r${ledger.rules.length}-${pendingTxn.id}`,
      match: pattern,
      categoryId: pending.categoryId,
      merchant: pendingTxn.merchant,
      createdFrom: 'correction',
      hits: similar.length + 1,
    };
    const ids = similar.map((s) => s.id);
    dispatch({ type: 'addRule', rule, ids: [...ids, pendingTxn.id] });
    setKeep((k) => {
      const n = new Set(k);
      for (const id of ids) n.add(id);
      return n;
    });
    setPending({ ...pending, done: { rule, moved: ids.length } });
    pulse(ids);
  };

  const select = (i: number) => {
    const r = rows[i];
    if (!r) return;
    const id = rowId(r);
    setSelId(id);
    if (pending && pending.id !== id) setPending(null);
    document
      .getElementById(`rf-row-${id}`)
      ?.scrollIntoView({ block: 'nearest' });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isTyping(e) || e.metaKey || e.ctrlKey) return;
      if (e.key === 'j' || e.key === 'k') {
        e.preventDefault();
        const n =
          selIndex < 0
            ? 0
            : Math.max(
                0,
                Math.min(rows.length - 1, selIndex + (e.key === 'j' ? 1 : -1)),
              );
        select(n);
      } else if (e.key === 'Enter' && pending && !pending.done) {
        e.preventDefault();
        makeRule();
      } else if ((e.key === 'c' || e.key === 'Enter') && sel?.kind === 'txn') {
        if ((e.target as HTMLElement | null)?.tagName === 'BUTTON') return;
        e.preventDefault();
        selectRefs.current.get(sel.t.id)?.focus();
      } else if (e.key === 'Escape') {
        if (pending) setPending(null);
        else if (selId) setSelId(null);
        else setSheet(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const reader = (
    <div className="mx-auto max-w-[760px] px-5 pt-10 sm:px-10">
      <div className={cx(tw.label, tw.ink3)}>The ledger · {period.label}</div>
      <h1 className={cx(serif, 'mt-2 text-[34px] leading-tight', tw.ink)}>
        Transactions
      </h1>
      <p className={cx('mt-2 text-[15px] leading-relaxed', tw.ink2)}>
        <span className={cx('font-mono', tw.ink)}>
          {list.length.toLocaleString('en-CA')}
        </span>{' '}
        rows from {mLong(period.fromM)} to {mLong(period.toM)}
        {query.trim() ? <> matching “{query.trim()}”</> : null}:{' '}
        <span className={cx('font-mono', tw.good)}>
          +{money(sums.inflow, false)}
        </span>{' '}
        in,{' '}
        <span className={cx('font-mono', tw.ink)}>
          {money(sums.outflow, false)}
        </span>{' '}
        out, and {sums.pairs} transfers shown once each.
      </p>

      <div
        className={cx(
          'sticky top-0 z-10 -mx-1 mt-6 flex flex-wrap items-center gap-2 border-b px-1 py-2',
          tw.surface,
          tw.rule,
        )}
      >
        <select
          aria-label="Account"
          value={accountId}
          onChange={(e) => setAccountId(e.target.value)}
          className={cx(tw.input, 'max-w-[180px]')}
        >
          <option value="">All accounts</option>
          {ledger.accounts
            .filter((a) => a.kind !== 'asset' && a.kind !== 'mortgage')
            .map((a) => (
              <option key={a.id} value={a.id}>
                {a.institution} {a.name}
              </option>
            ))}
        </select>
        <select
          aria-label="Category"
          value={categoryId}
          onChange={(e) => {
            setCategoryId(e.target.value);
            setKeep(new Set());
          }}
          className={cx(tw.input, 'max-w-[180px]')}
        >
          <option value="">All categories</option>
          {ledger.categories
            .filter((c) => !c.parentId)
            .map((c) => (
              <optgroup key={c.id} label={c.name}>
                <option value={c.id}>All {c.name.toLowerCase()}</option>
                {ledger.categories
                  .filter((k) => k.parentId === c.id)
                  .map((k) => (
                    <option key={k.id} value={k.id}>
                      {k.name}
                    </option>
                  ))}
              </optgroup>
            ))}
        </select>
        <button
          type="button"
          aria-pressed={review}
          onClick={() => {
            setReview((r) => !r);
            setKeep(new Set());
          }}
          className={cx(
            tw.btn,
            'h-7',
            review &&
              'border-[#0b0b0b] bg-[#0b0b0b] text-[#fcfcfb] hover:bg-[#2b2b29] dark:border-[#f0efec] dark:bg-[#f0efec] dark:text-[#141413] dark:hover:bg-[#d8d7d2]',
          )}
        >
          <AlertTriangle size={11} /> Needs review
        </button>
        {accountId || categoryId || review ? (
          <button
            type="button"
            onClick={() => {
              setAccountId('');
              setCategoryId('');
              setReview(false);
              setKeep(new Set());
            }}
            className={cx('text-[11px] hover:underline', tw.accent)}
          >
            Clear
          </button>
        ) : null}
        <span className={cx('ml-auto text-[11px]', tw.ink3)}>
          <Kbd>j</Kbd> <Kbd>k</Kbd> move · <Kbd>c</Kbd> category
        </span>
      </div>

      <table className="w-full table-fixed border-separate border-spacing-0 text-[12px]">
        <thead>
          <tr className={cx(tw.label, tw.ink3)}>
            <th
              className={cx(
                'h-7 w-[86px] border-b text-left font-medium',
                tw.rule,
              )}
            >
              Date
            </th>
            <th className={cx('h-7 border-b text-left font-medium', tw.rule)}>
              Merchant · descriptor
            </th>
            <th
              className={cx(
                'h-7 w-[168px] border-b text-left font-medium',
                tw.rule,
              )}
            >
              Category
            </th>
            <th className={cx('h-7 w-[22px] border-b', tw.rule)} />
            <th
              className={cx(
                'h-7 w-[96px] border-b text-right font-medium',
                tw.rule,
              )}
            >
              Amount
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={5} className={cx('py-16 text-center', tw.ink3)}>
                Nothing matches. Try a wider period or clear the filters.
              </td>
            </tr>
          ) : null}
          {rows.map((r, i) => (
            <Row
              key={rowId(r)}
              r={r}
              selected={i === selIndex}
              pending={pending?.id === rowId(r) && !pending.done}
              flashing={flash.has(rowId(r))}
              pal={pal}
              top={top}
              catName={catName}
              acctLabel={acctLabel}
              groups={groups}
              onSelect={() => select(i)}
              onChange={recategorise}
              selectRef={(el) => {
                const id = rowId(r);
                if (el) selectRefs.current.set(id, el);
                else selectRefs.current.delete(id);
              }}
            />
          ))}
        </tbody>
      </table>
      {rows.length >= LIMIT ? (
        <p className={cx('py-3 text-[11px]', tw.ink3)}>
          The latest {LIMIT} are shown. Narrow the period or search to see older
          rows.
        </p>
      ) : null}
    </div>
  );

  const inspector = sel ? (
    <RowInspector
      key={rowId(sel)}
      r={sel}
      ledger={ledger}
      pal={pal}
      top={top}
      catName={catName}
      acctLabel={acctLabel}
      groups={groups}
      pending={pending && pending.id === rowId(sel) ? pending : null}
      similar={similar}
      setPattern={(p) => pending && setPending({ ...pending, pattern: p })}
      makeRule={makeRule}
      dismiss={() => setPending(null)}
      recategorise={recategorise}
      showRules={showRules}
    />
  ) : (
    <ListInspector
      count={list.length}
      sums={sums}
      pal={pal}
      catName={catName}
      period={period}
    />
  );

  return (
    <Split
      open={sheet}
      setOpen={setSheet}
      peek={
        sel
          ? sel.kind === 'txn'
            ? `${sel.t.merchant} · ${money(sel.t.amount)}`
            : `Transfer · ${money(Math.abs(sel.out.amount))}`
          : `${list.length} rows`
      }
      reader={reader}
      inspector={inspector}
    />
  );
}

function SourceGlyph({ t }: { t: Transaction }) {
  if (t.source === 'manual')
    return (
      <span title="Filed by hand" className={tw.accent}>
        <Pencil size={11} />
      </span>
    );
  if (t.source === 'model') {
    const low = (t.confidence ?? 0) < 0.6;
    return (
      <span
        title={`Model, ${pct(t.confidence ?? 0)} sure`}
        className={low ? tw.warn : tw.ink3}
      >
        {low ? <AlertTriangle size={11} /> : <Sparkles size={11} />}
      </span>
    );
  }
  return null;
}

function Row({
  r,
  selected,
  pending,
  flashing,
  pal,
  top,
  catName,
  acctLabel,
  groups,
  onSelect,
  onChange,
  selectRef,
}: {
  r: LedgerRow;
  selected: boolean;
  pending: boolean;
  flashing: boolean;
  pal: Palette;
  top: ReturnType<typeof topResolver>;
  catName: (id: string) => string;
  acctLabel: (id: string) => string;
  groups: [string, { id: string; label: string }[]][];
  onSelect: () => void;
  onChange: (t: Transaction, cat: string) => void;
  selectRef: (el: HTMLSelectElement | null) => void;
}) {
  const cell = cx('h-7 border-b', rowRule);
  const bg = flashing
    ? 'bg-[#fff4d6] dark:bg-[#3a2f12]'
    : selected
      ? tw.selected
      : tw.hover;
  const id = r.kind === 'txn' ? r.t.id : r.out.id;
  const bar = selected ? (
    <span className="absolute inset-y-0 left-0 w-[2px] bg-[#2a78d6] dark:bg-[#3987e5]" />
  ) : null;

  if (r.kind === 'transfer') {
    const t = r.out;
    return (
      <tr
        id={`rf-row-${id}`}
        onClick={onSelect}
        className={cx('cursor-pointer transition-colors duration-500', bg)}
      >
        <td className={cx(cell, 'relative pl-2 font-mono', tw.ink3)}>
          {bar}
          {t.date}
        </td>
        <td className={cx(cell, 'truncate pr-3')}>
          <ArrowLeftRight
            size={11}
            className={cx('mr-1.5 inline -translate-y-px', tw.ink3)}
          />
          <span className={tw.ink2}>
            {acctLabel(t.accountId).split(' ').slice(-1)[0]} →{' '}
            {r.in
              ? acctLabel(r.in.accountId).split(' ').slice(-1)[0]
              : 'unpaired'}
          </span>
          <span className={cx('ml-2 font-mono text-[11px]', tw.ink3)}>
            {t.descriptor}
          </span>
        </td>
        <td className={cx(cell, tw.ink3)}>{catName(t.categoryId)}</td>
        <td className={cell} />
        <td className={cx(cell, 'pr-1 text-right font-mono', tw.ink2)}>
          {money(Math.abs(t.amount))}
        </td>
      </tr>
    );
  }
  const t = r.t;
  const g = top(t.categoryId).id;
  return (
    <tr
      id={`rf-row-${id}`}
      onClick={onSelect}
      className={cx('group cursor-pointer transition-colors duration-500', bg)}
    >
      <td className={cx(cell, 'relative pl-2 font-mono', tw.ink3)}>
        {bar}
        {t.date}
      </td>
      <td className={cx(cell, 'truncate pr-3')}>
        <span className={tw.ink}>{t.merchant}</span>
        <span className={cx('ml-2 font-mono text-[11px]', tw.ink3)}>
          {t.descriptor}
        </span>
      </td>
      <td className={cx(cell, 'pr-2')}>
        <label className="relative flex items-center gap-1.5">
          <span
            className="h-2 w-2 shrink-0 rounded-[2px]"
            style={{ background: groupColor(pal, g) }}
          />
          <select
            ref={selectRef}
            aria-label={`Category for ${t.merchant} on ${t.date}`}
            value={t.categoryId}
            onClick={(e) => e.stopPropagation()}
            onFocus={onSelect}
            onChange={(e) => {
              onChange(t, e.target.value);
              e.currentTarget.blur();
            }}
            className={cx(
              'h-[22px] w-full cursor-pointer appearance-none truncate rounded-[3px] border border-transparent bg-transparent pr-5 pl-1 -ml-1 text-[12px] outline-none',
              'group-hover:border-[#dcdbd4] focus:border-[#2a78d6] dark:group-hover:border-[#33332f] dark:focus:border-[#3987e5]',
              (selected || pending) && 'border-[#dcdbd4] dark:border-[#33332f]',
              t.categoryId === 'uncategorized' ? tw.ink3 : tw.ink,
            )}
          >
            {t.categoryId === 'uncategorized' ? (
              <option value="uncategorized">Uncategorized</option>
            ) : null}
            {groups.map(([grp, opts]) => (
              <optgroup key={grp} label={grp}>
                {opts.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <ChevronDown
            size={12}
            className={cx(
              'pointer-events-none absolute right-1 opacity-0 group-hover:opacity-100',
              selected && 'opacity-100',
              tw.ink3,
            )}
          />
        </label>
      </td>
      <td className={cx(cell, 'text-center')}>
        <SourceGlyph t={t} />
      </td>
      <td
        className={cx(
          cell,
          'pr-1 text-right font-mono tabular-nums',
          t.amount > 0 ? tw.good : tw.ink,
        )}
      >
        {t.amount > 0 ? '+' : ''}
        {money(t.amount)}
      </td>
    </tr>
  );
}

// Inspector: the selected row, its merchant and the rule question ----------

function RowInspector({
  r,
  ledger,
  pal,
  top,
  catName,
  acctLabel,
  groups,
  pending,
  similar,
  setPattern,
  makeRule,
  dismiss,
  recategorise,
  showRules,
}: {
  r: LedgerRow;
  ledger: Ledger;
  pal: Palette;
  top: ReturnType<typeof topResolver>;
  catName: (id: string) => string;
  acctLabel: (id: string) => string;
  groups: [string, { id: string; label: string }[]][];
  pending: Pending | null;
  similar: Transaction[];
  setPattern: (p: string) => void;
  makeRule: () => void;
  dismiss: () => void;
  recategorise: (t: Transaction, cat: string) => void;
  showRules: () => void;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  if (r.kind === 'transfer') {
    const legs = [r.out, r.in].filter(Boolean) as Transaction[];
    return (
      <div className="rf-in">
        <InspectorHead
          kicker="Transfer"
          title={`${acctLabel(r.out.accountId)} → ${r.in ? acctLabel(r.in.accountId) : 'unpaired'}`}
          figure={money(Math.abs(r.out.amount))}
          sub="Shown once. It leaves spending and income alone."
        />
        {legs.map((t) => (
          <Block key={t.id} title={t.amount < 0 ? 'Out leg' : 'In leg'}>
            <KV
              rows={[
                [
                  'Date',
                  <span key="v" className="font-mono">
                    {t.date}
                  </span>,
                ],
                ['Account', acctLabel(t.accountId)],
                [
                  'Amount',
                  <span key="v" className="font-mono">
                    {t.amount > 0 ? '+' : ''}
                    {money(t.amount)}
                  </span>,
                  t.amount > 0 ? tw.good : '',
                ],
                [
                  'Descriptor',
                  <span key="v" className="font-mono text-[11px]">
                    {t.descriptor}
                  </span>,
                ],
                ['Category', catName(t.categoryId)],
              ]}
            />
          </Block>
        ))}
      </div>
    );
  }
  const t = r.t;
  const g = top(t.categoryId);
  const rule = ruleFor(ledger, t);
  const history = latestFirst(
    ledger.transactions.filter((x) => x.merchant === t.merchant),
  );
  const ms = months(ledger).slice(-24);
  const series = byMonth(history, ms);
  const total = history.reduce((s, x) => s + x.amount, 0);
  return (
    <div className="rf-in">
      <InspectorHead
        kicker={
          <span className="inline-flex items-center gap-1.5">
            <span
              className="h-2 w-2 rounded-[2px]"
              style={{ background: groupColor(pal, g.id) }}
            />
            {acctLabel(t.accountId)}
          </span>
        }
        title={t.merchant}
        figure={
          <span className={t.amount > 0 ? tw.good : ''}>
            {t.amount > 0 ? '+' : ''}
            {money(t.amount)}
          </span>
        }
        sub={`${t.date} · ${t.id} · batch ${t.batchId}`}
      />

      {pending ? (
        <Affirm
          pending={pending}
          txn={t}
          similar={similar}
          catName={catName}
          color={groupColor(pal, top(pending.categoryId).id)}
          setPattern={setPattern}
          makeRule={makeRule}
          dismiss={dismiss}
          showRules={showRules}
        />
      ) : null}

      <Block title="This row">
        <KV
          rows={[
            [
              'Descriptor',
              <span key="v" className="font-mono text-[11px]">
                {t.descriptor}
              </span>,
            ],
            [
              'Category',
              <select
                key="v"
                aria-label="Category"
                value={t.categoryId}
                onChange={(e) => recategorise(t, e.target.value)}
                className={cx(tw.input, 'h-6 w-full max-w-[220px]')}
              >
                {t.categoryId === 'uncategorized' ? (
                  <option value="uncategorized">Uncategorized</option>
                ) : null}
                {groups.map(([grp, opts]) => (
                  <optgroup key={grp} label={grp}>
                    {opts.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.label}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>,
            ],
            [
              'Filed by',
              t.source === 'manual'
                ? 'you, by hand'
                : t.source === 'model'
                  ? `the model, ${pct(t.confidence ?? 0)} sure`
                  : 'a rule',
              t.source === 'model' && (t.confidence ?? 1) < 0.6 ? tw.warn : '',
            ],
            [
              'Rule',
              rule ? (
                <span key="v">
                  <code
                    className={cx(
                      'rounded-[2px] px-1 font-mono text-[11px]',
                      tw.wash,
                    )}
                  >
                    {rule.match}
                  </code>{' '}
                  → {catName(rule.categoryId)}{' '}
                  <span className={tw.ink3}>
                    · {rowsMatching(ledger, rule).length} rows
                  </span>
                </span>
              ) : (
                <span key="v" className={tw.ink3}>
                  none matches
                </span>
              ),
            ],
          ]}
        />
      </Block>

      <Block
        title="Merchant history"
        right={`${history.length} rows · ${money(total, false)}`}
      >
        <div ref={ref}>
          <Sparkline
            values={series.map((s) => s.value)}
            width={width}
            height={36}
            color={groupColor(pal, g.id)}
            fill
          />
        </div>
        <div
          className={cx(
            'mt-1 mb-2 flex justify-between font-mono text-[10px]',
            tw.ink3,
          )}
        >
          <span>{mLong(ms[0])}</span>
          <span>monthly, two years</span>
          <span>{mLong(monthKey(ledger.asOf))}</span>
        </div>
        <TxnList rows={history} limit={14} catName={catName} showCategory />
      </Block>
    </div>
  );
}

function Affirm({
  pending,
  txn,
  similar,
  catName,
  color,
  setPattern,
  makeRule,
  dismiss,
  showRules,
}: {
  pending: Pending;
  txn: Transaction;
  similar: Transaction[];
  catName: (id: string) => string;
  color: string;
  setPattern: (p: string) => void;
  makeRule: () => void;
  dismiss: () => void;
  showRules: () => void;
}) {
  const name = catName(pending.categoryId);
  if (pending.done)
    return (
      <section
        className={cx(
          'rf-in border-b px-4 py-3 text-[12px]',
          tw.rule,
          'bg-[#eef7ee] dark:bg-[#132313]',
        )}
      >
        <div className={cx('flex items-center gap-1.5 font-medium', tw.good)}>
          <Check size={13} /> Rule saved
        </div>
        <p className={cx('mt-1 leading-5', tw.ink2)}>
          Descriptor contains{' '}
          <code
            className={cx(
              'rounded-[2px] px-1 font-mono text-[11px]',
              tw.wash,
              tw.ink,
            )}
          >
            {pending.done.rule.match}
          </code>{' '}
          → <span className={tw.ink}>{name}</span>.{' '}
          {pending.done.moved
            ? `${pending.done.moved} more ${pending.done.moved === 1 ? 'row' : 'rows'} moved with it.`
            : 'Future imports will follow it.'}
        </p>
        <div className="mt-2 flex items-center gap-3">
          <button
            type="button"
            onClick={showRules}
            className={cx('hover:underline', tw.accent)}
          >
            View in Rules
          </button>
          <button
            type="button"
            onClick={dismiss}
            className={cx('ml-auto', tw.btn)}
          >
            Done <Kbd>esc</Kbd>
          </button>
        </div>
      </section>
    );
  return (
    <section
      className={cx(
        'rf-in border-b px-4 py-3 text-[12px]',
        tw.rule,
        'bg-[#f7f6f2] dark:bg-[#191918]',
      )}
    >
      <div className="flex items-center gap-2">
        <span
          className="h-3.5 w-[3px] rounded-full"
          style={{ background: color }}
        />
        <span className={cx(tw.label, tw.ink2)}>Always do this?</span>
      </div>
      <p className={cx('mt-1.5 leading-5', tw.ink2)}>
        {txn.merchant} is now <span className={tw.ink}>{name}</span>. Make a
        rule so the rest follow.
      </p>
      <label className={cx('mt-2 flex items-center gap-2', tw.ink3)}>
        <span className="w-[112px] shrink-0 text-[11px]">
          Descriptor contains
        </span>
        <input
          aria-label="Rule pattern"
          value={pending.pattern}
          onChange={(e) => setPattern(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              makeRule();
            }
            if (e.key === 'Escape') dismiss();
          }}
          className={cx(tw.input, 'h-6 min-w-0 flex-1 font-mono text-[11px]')}
        />
      </label>
      {similar.length ? (
        <div className="mt-2">
          <div className={cx('mb-1 text-[11px]', tw.ink3)}>
            {similar.length} {similar.length === 1 ? 'row' : 'rows'} would move
            to {name}
          </div>
          <TxnList
            rows={latestFirst(similar)}
            limit={5}
            catName={catName}
            showCategory
          />
        </div>
      ) : (
        <p className={cx('mt-2 text-[11px]', tw.ink3)}>
          No other rows match. The rule still files future imports.
        </p>
      )}
      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={makeRule}
          className={tw.btnPrimary}
          disabled={pending.pattern.trim().length < 3}
        >
          {similar.length
            ? `Make a rule, move ${similar.length}`
            : 'Make a rule'}
          <CornerDownLeft size={11} />
        </button>
        <button type="button" onClick={dismiss} className={tw.btn}>
          Just this one <Kbd>esc</Kbd>
        </button>
      </div>
    </section>
  );
}

function ListInspector({
  count,
  sums,
  pal,
  catName,
  period,
}: {
  count: number;
  sums: {
    inflow: number;
    outflow: number;
    pairs: number;
    byGroup: Map<string, number>;
  };
  pal: Palette;
  catName: (id: string) => string;
  period: Period;
}) {
  const groups = [...sums.byGroup.entries()].sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...groups.map((g) => g[1]));
  return (
    <div className="rf-in">
      <InspectorHead
        kicker="No row selected"
        title={`${count.toLocaleString('en-CA')} rows · ${period.label}`}
        sub="Select a row, or press j, for its merchant history and rule."
      />
      <div
        className={cx('grid grid-cols-3 gap-px border-b', tw.ruleBg, tw.rule)}
      >
        {(
          [
            ['In', `+${money(sums.inflow, false)}`, tw.good],
            ['Out', money(sums.outflow, false), tw.ink],
            ['Transfers', String(sums.pairs), tw.ink],
          ] as const
        ).map(([k, v, c]) => (
          <div key={k} className={cx(tw.surface, 'px-4 py-2')}>
            <div className={cx(tw.label, tw.ink3)}>{k}</div>
            <div className={cx('mt-0.5 font-mono text-[14px]', c)}>{v}</div>
          </div>
        ))}
      </div>
      <Block title="Out, by category">
        <table className="w-full table-fixed text-[11px]">
          <tbody>
            {groups.map(([g, v]) => (
              <tr key={g} className={cx('border-t', rowRule)}>
                <td className={cx('h-[22px] w-[112px] truncate', tw.ink)}>
                  <span className="inline-flex items-center gap-1.5">
                    <span
                      className="h-2 w-2 rounded-[2px]"
                      style={{ background: groupColor(pal, g) }}
                    />
                    {catName(g)}
                  </span>
                </td>
                <td className="pr-3">
                  <div
                    className="h-[7px] rounded-r-[2px]"
                    style={{
                      width: `${(v / max) * 100}%`,
                      background: groupColor(pal, g),
                    }}
                  />
                </td>
                <td className={cx('w-[84px] text-right font-mono', tw.ink)}>
                  {money(-v, false)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Block>
      <Block title="Keys">
        <Keys
          items={[
            ['j k', 'select the next or previous row'],
            ['c ↵', 'open the category picker'],
            ['↵', 'make the rule, once one is offered'],
            ['esc', 'just this one, then deselect'],
            ['/', 'search merchant or descriptor'],
          ]}
        />
      </Block>
    </div>
  );
}
