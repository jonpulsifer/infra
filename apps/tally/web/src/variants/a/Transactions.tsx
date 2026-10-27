import {
  AlertTriangle,
  ArrowLeftRight,
  ChevronDown,
  CornerDownLeft,
  Pencil,
  Sparkles,
  X,
} from 'lucide-react';
import {
  type Dispatch,
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { searchTransactions } from '~/fixtures/derive';
import type { Ledger, Rule, Transaction } from '~/fixtures/types';
import { isTyping, Kbd, Swatch } from './bits';
import {
  type Action,
  categoryOptions,
  type LedgerRow,
  patternFor,
  similarTo,
  topResolver,
  toRows,
  transferIndex,
} from './model';
import type { Period } from './period';
import { cx, money, type Palette, tw } from './theme';

const LIMIT = 400;

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
  preset: { categoryId?: string };
  dispatch: Dispatch<Action>;
  showRules: () => void;
}) {
  const [accountId, setAccountId] = useState('');
  const [categoryId, setCategoryId] = useState(preset.categoryId ?? '');
  const [review, setReview] = useState(false);
  const [sel, setSel] = useState(-1);
  const [pending, setPending] = useState<Pending | null>(null);
  const [keep, setKeep] = useState<Set<string>>(new Set());
  const [flash, setFlash] = useState<Set<string>>(new Set());
  const selectRefs = useRef(new Map<string, HTMLSelectElement>());
  const rowRefs = useRef(new Map<number, HTMLTableRowElement>());

  useEffect(() => {
    if (preset.categoryId) setCategoryId(preset.categoryId);
  }, [preset]);

  const top = useMemo(
    () => topResolver(ledger.categories),
    [ledger.categories],
  );
  const catName = useMemo(
    () => new Map(ledger.categories.map((c) => [c.id, c.name])),
    [ledger.categories],
  );
  const acct = useMemo(
    () => new Map(ledger.accounts.map((a) => [a.id, a])),
    [ledger.accounts],
  );
  const options = useMemo(
    () => categoryOptions(ledger.categories),
    [ledger.categories],
  );
  const groups = useMemo(() => {
    const g = new Map<string, typeof options>();
    for (const o of options) g.set(o.group, [...(g.get(o.group) ?? []), o]);
    return Array.from(g.entries());
  }, [options]);
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
  }, [
    ledger,
    query,
    accountId,
    categoryId,
    review,
    period.from,
    period.to,
    keep,
    top,
  ]);

  const rows = useMemo(() => toRows(list, idx, LIMIT), [list, idx]);
  const totals = useMemo(() => {
    let inflow = 0;
    let outflow = 0;
    let pairs = 0;
    for (const t of list) {
      if (t.transferId) {
        if (t.amount < 0) pairs++;
        continue;
      }
      if (t.amount > 0) inflow += t.amount;
      else outflow += t.amount;
    }
    return { inflow, outflow, pairs };
  }, [list]);

  const pendingTxn = pending
    ? ledger.transactions.find((t) => t.id === pending.id)
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
    setPending({ id: t.id, categoryId: cat, pattern: patternFor(t) });
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e) || e.metaKey || e.ctrlKey) return;
      if (e.key === 'j' || e.key === 'k') {
        e.preventDefault();
        setSel((s) => {
          const n = Math.max(
            0,
            Math.min(rows.length - 1, s + (e.key === 'j' ? 1 : -1)),
          );
          rowRefs.current.get(n)?.scrollIntoView({ block: 'nearest' });
          return n;
        });
      } else if ((e.key === 'c' || e.key === 'Enter') && !pending && sel >= 0) {
        const r = rows[sel];
        if (r?.kind === 'txn') {
          e.preventDefault();
          selectRefs.current.get(r.t.id)?.focus();
        }
      } else if (e.key === 'Enter' && pending && !pending.done) {
        e.preventDefault();
        makeRule();
      } else if (e.key === 'Escape') {
        if (pending) setPending(null);
        else setSel(-1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const acctLabel = (id: string) => {
    const a = acct.get(id);
    return a ? `${a.institution} ${a.name}` : id;
  };

  const clearFilters = () => {
    setAccountId('');
    setCategoryId('');
    setReview(false);
    setKeep(new Set());
  };

  return (
    <div className="flex h-full flex-col">
      <div
        className={cx(
          'flex h-10 shrink-0 items-center gap-2 border-b px-3',
          tw.rule,
          tw.surface,
        )}
      >
        <select
          aria-label="Account"
          value={accountId}
          onChange={(e) => setAccountId(e.target.value)}
          className={tw.input}
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
          className={tw.input}
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
            onClick={clearFilters}
            className={cx('text-[11px] hover:underline', tw.accent)}
          >
            Clear
          </button>
        ) : null}
        <div
          className={cx(
            'ml-auto flex items-center gap-4 text-[11px]',
            tw.ink3,
            tw.num,
          )}
        >
          <span>
            <span className={tw.ink}>
              {list.length.toLocaleString('en-CA')}
            </span>{' '}
            rows
            {rows.length >= LIMIT ? ` · latest ${LIMIT} shown` : ''}
          </span>
          <span>
            in <span className={tw.good}>{money(totals.inflow, false)}</span>
          </span>
          <span>
            out <span className={tw.ink}>{money(totals.outflow, false)}</span>
          </span>
          <span>{totals.pairs} transfers paired</span>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto pb-16">
        <table className="w-full min-w-[920px] table-fixed border-separate border-spacing-0 text-[12px]">
          <thead className={cx('sticky top-0 z-10', tw.surface)}>
            <tr className={cx(tw.label, tw.ink3)}>
              {[
                ['Date', 'w-[92px] pl-3'],
                ['Account', 'w-[150px]'],
                ['Merchant · descriptor', ''],
                ['Category', 'w-[200px]'],
                ['Source', 'w-[104px]'],
                ['Amount', 'w-[120px] pr-3 text-right'],
              ].map(([h, c]) => (
                <th
                  key={h}
                  className={cx(
                    'h-7 border-b text-left font-medium',
                    tw.rule,
                    c,
                  )}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6} className={cx('py-16 text-center', tw.ink3)}>
                  Nothing matches. Try a wider period or clear the filters.
                </td>
              </tr>
            ) : null}
            {rows.map((r, i) => {
              const id = r.kind === 'txn' ? r.t.id : r.out.id;
              const isSel = i === sel;
              const row = (
                <Row
                  key={id}
                  r={r}
                  i={i}
                  selected={isSel}
                  flashing={flash.has(id)}
                  pal={pal}
                  acctLabel={acctLabel}
                  catName={catName}
                  top={top}
                  groups={groups}
                  onSelect={() => setSel(i)}
                  onChange={recategorise}
                  selectRef={(el) => {
                    if (el) selectRefs.current.set(id, el);
                    else selectRefs.current.delete(id);
                  }}
                  rowRef={(el) => {
                    if (el) rowRefs.current.set(i, el);
                    else rowRefs.current.delete(i);
                  }}
                />
              );
              if (!pending || pending.id !== id || !pendingTxn) return row;
              return (
                <Fragment key={id}>
                  {row}
                  <tr>
                    <td
                      colSpan={6}
                      className={cx('border-b px-3 py-0', tw.rule)}
                    >
                      <Affirm
                        pending={pending}
                        txn={pendingTxn}
                        similar={similar.length}
                        catName={
                          catName.get(pending.categoryId) ?? pending.categoryId
                        }
                        color={pal.cat[top(pending.categoryId).id]}
                        setPattern={(p) =>
                          setPending({ ...pending, pattern: p })
                        }
                        makeRule={makeRule}
                        dismiss={() => setPending(null)}
                        showRules={showRules}
                      />
                    </td>
                  </tr>
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Row({
  r,
  i,
  selected,
  flashing,
  pal,
  acctLabel,
  catName,
  top,
  groups,
  onSelect,
  onChange,
  selectRef,
  rowRef,
}: {
  r: LedgerRow;
  i: number;
  selected: boolean;
  flashing: boolean;
  pal: Palette;
  acctLabel: (id: string) => string;
  catName: Map<string, string>;
  top: ReturnType<typeof topResolver>;
  groups: [string, { id: string; label: string }[]][];
  onSelect: () => void;
  onChange: (t: Transaction, cat: string) => void;
  selectRef: (el: HTMLSelectElement | null) => void;
  rowRef: (el: HTMLTableRowElement | null) => void;
}) {
  const cell = cx('h-7 border-b', 'border-[#efeee9] dark:border-[#20201e]');
  const bg = flashing
    ? 'bg-[#fff4d6] dark:bg-[#3a2f12]'
    : selected
      ? tw.selected
      : cx(i % 2 ? 'bg-[#fafaf8] dark:bg-[#161615]' : '', tw.hover);

  if (r.kind === 'transfer') {
    const t = r.out;
    return (
      <tr
        ref={rowRef}
        onClick={onSelect}
        className={cx('transition-colors duration-500', bg)}
      >
        <td className={cx(cell, 'pl-3', tw.num, tw.ink3)}>{t.date}</td>
        <td
          className={cx(cell, 'truncate pr-2', tw.ink2)}
          title={`${acctLabel(t.accountId)} → ${r.in ? acctLabel(r.in.accountId) : '?'}`}
        >
          <span className="truncate">
            {acctLabel(t.accountId).split(' ')[0]}
            <span className={tw.ink3}> → </span>
            {r.in
              ? acctLabel(r.in.accountId).split(' ').slice(0, 2).join(' ')
              : 'unpaired'}
          </span>
        </td>
        <td className={cx(cell, 'truncate pr-3')}>
          <ArrowLeftRight
            size={11}
            className={cx('mr-1.5 inline -translate-y-px', tw.ink3)}
          />
          <span className={tw.ink2}>{catName.get(t.categoryId)}</span>
          <span className={cx('ml-2 font-mono text-[11px]', tw.ink3)}>
            {t.descriptor}
          </span>
        </td>
        <td className={cx(cell, tw.ink3)}>
          <span className="flex items-center gap-2">
            <Swatch color={pal.axis} />
            Transfer
          </span>
        </td>
        <td className={cx(cell, 'text-[11px] leading-none', tw.ink3)}>
          {r.in ? `paired · ${dayGap(t.date, r.in.date)}d` : 'one leg'}
        </td>
        <td className={cx(cell, 'pr-3 text-right', tw.num, tw.ink2)}>
          {money(Math.abs(t.amount))}
        </td>
      </tr>
    );
  }
  const t = r.t;
  const topId = top(t.categoryId).id;
  return (
    <tr
      ref={rowRef}
      onClick={onSelect}
      className={cx('group transition-colors duration-500', bg)}
    >
      <td className={cx(cell, 'pl-3', tw.num, tw.ink3)}>{t.date}</td>
      <td className={cx(cell, 'truncate pr-2', tw.ink2)}>
        {acctLabel(t.accountId)}
      </td>
      <td className={cx(cell, 'truncate pr-3')}>
        <span className={tw.ink}>{t.merchant}</span>
        <span className={cx('ml-2 font-mono text-[11px]', tw.ink3)}>
          {t.descriptor}
        </span>
      </td>
      <td className={cx(cell, 'pr-2')}>
        <label className="relative flex items-center gap-2">
          <Swatch
            color={
              pal.cat[topId] ?? (topId === 'income' ? pal.income : pal.spend)
            }
          />
          <select
            ref={selectRef}
            aria-label={`Category for ${t.merchant} on ${t.date}`}
            value={t.categoryId}
            onChange={(e) => {
              onChange(t, e.target.value);
              e.currentTarget.blur();
            }}
            onFocus={onSelect}
            className={cx(
              'h-[22px] w-full cursor-pointer appearance-none truncate rounded-[3px] border border-transparent bg-transparent pr-5 pl-1 -ml-1 text-[12px] outline-none',
              'group-hover:border-[#dcdbd4] group-hover:bg-[#fcfcfb] focus:border-[#2a78d6] focus:bg-[#fcfcfb]',
              'dark:group-hover:border-[#33332f] dark:group-hover:bg-[#141413] dark:focus:border-[#3987e5] dark:focus:bg-[#141413]',
              selected && 'border-[#dcdbd4] dark:border-[#33332f]',
              t.categoryId === 'uncategorized' ? tw.ink3 : tw.ink,
            )}
          >
            {t.categoryId === 'uncategorized' ? (
              <option value="uncategorized">Uncategorized</option>
            ) : null}
            {groups.map(([g, opts]) => (
              <optgroup key={g} label={g}>
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
              'pointer-events-none absolute right-1 opacity-0 transition-opacity group-hover:opacity-100',
              selected && 'opacity-100',
              tw.ink3,
            )}
          />
        </label>
      </td>
      <td className={cx(cell, 'text-[11px] leading-none')}>
        <SourceTag t={t} />
      </td>
      <td
        className={cx(
          cell,
          'pr-3 text-right',
          tw.num,
          t.amount > 0 ? tw.good : tw.ink,
        )}
      >
        {t.amount > 0 ? '+' : ''}
        {money(t.amount)}
      </td>
    </tr>
  );
}

function SourceTag({ t }: { t: Transaction }) {
  if (t.source === 'manual')
    return (
      <span className={cx('inline-flex items-center gap-1', tw.accent)}>
        <Pencil size={10} /> manual
      </span>
    );
  if (t.source === 'model') {
    const c = t.confidence ?? 0;
    const low = c < 0.6;
    return (
      <span
        className={cx(
          'inline-flex items-center gap-1',
          low ? tw.warn : tw.ink3,
        )}
      >
        {low ? <AlertTriangle size={10} /> : <Sparkles size={10} />}
        model <span className={tw.num}>{Math.round(c * 100)}%</span>
      </span>
    );
  }
  return <span className={tw.ink3}>rule</span>;
}

function dayGap(a: string, b: string) {
  return Math.round(Math.abs(Date.parse(b) - Date.parse(a)) / 86_400_000);
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
  similar: number;
  catName: string;
  color: string;
  setPattern: (p: string) => void;
  makeRule: () => void;
  dismiss: () => void;
  showRules: () => void;
}) {
  if (pending.done) {
    return (
      <div className="flex h-9 items-center gap-3 text-[12px] animate-[desk-in_160ms_ease-out]">
        <span
          className={cx(
            'h-4 w-[3px] rounded-full',
            'bg-[#008300] dark:bg-[#0ca30c]',
          )}
        />
        <span className={tw.ink}>
          Rule saved: descriptor contains{' '}
          <code
            className={cx('rounded-[2px] px-1 font-mono text-[11px]', tw.wash)}
          >
            {pending.done.rule.match}
          </code>{' '}
          → {catName}.{' '}
          <span className={tw.ink2}>
            {pending.done.moved
              ? `${pending.done.moved} ${pending.done.moved === 1 ? 'row' : 'rows'} moved.`
              : 'Future imports will follow it.'}
          </span>
        </span>
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
          aria-label="Dismiss"
          className={cx('ml-auto rounded-[3px] p-1', tw.ink3, tw.hover)}
        >
          <X size={12} />
        </button>
      </div>
    );
  }
  return (
    <div className="flex h-9 items-center gap-3 text-[12px] animate-[desk-in_160ms_ease-out]">
      <span
        className="h-4 w-[3px] rounded-full"
        style={{ background: color }}
      />
      <span className={cx('shrink-0', tw.ink2)}>
        {txn.merchant} → <span className={tw.ink}>{catName}</span>.
      </span>
      <span className={cx('flex items-center gap-1.5', tw.ink3)}>
        descriptor contains
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
          className={cx(tw.input, 'h-[22px] w-[180px] font-mono text-[11px]')}
        />
      </span>
      <div className="ml-auto flex items-center gap-2">
        <button
          type="button"
          onClick={makeRule}
          className={tw.btnPrimary}
          disabled={pending.pattern.trim().length < 3}
        >
          {similar
            ? `Apply to ${similar} similar: make a rule`
            : 'No others match: make a rule for future imports'}
          <CornerDownLeft size={11} />
        </button>
        <button type="button" onClick={dismiss} className={tw.btn}>
          Just this one <Kbd>esc</Kbd>
        </button>
      </div>
    </div>
  );
}
