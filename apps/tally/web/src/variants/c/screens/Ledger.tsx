import {
  ArrowLeftRight,
  BookMarked,
  Check,
  ChevronDown,
  EllipsisVertical,
  Search,
  X,
} from 'lucide-react';
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { monthKey, searchTransactions } from '~/fixtures/derive';
import type { Transaction } from '~/fixtures/types';
import {
  Aside,
  AsideSection,
  CategoryChip,
  Monogram,
  PrimaryButton,
  QuietButton,
  Sheet,
  Toggle,
} from '../bits';
import {
  accountName,
  categoryName,
  dayLabel,
  leafCategories,
  money,
  moneyCents,
  monthLong,
  pct,
  ruleMatchFor,
} from '../model';
import { useTally } from '../store';

const PAGE = 80;

export function LedgerScreen() {
  const { eff, nav, spendMonths, flash } = useTally();
  const [text, setText] = useState(nav.ledgerText);
  const [cat, setCat] = useState<string | null>(nav.ledgerCategory);
  const [acct, setAcct] = useState<string | null>(null);
  const [sheet, setSheet] = useState<'account' | 'category' | 'rules' | null>(
    null,
  );
  const [edit, setEdit] = useState<Transaction | null>(null);
  const [limit, setLimit] = useState(PAGE);
  const [hdrH, setHdrH] = useState(124);
  const sentinel = useRef<HTMLDivElement>(null);
  const ro = useRef<ResizeObserver | null>(null);

  const hdrRef = useCallback((el: HTMLDivElement | null) => {
    ro.current?.disconnect();
    if (!el) return;
    ro.current = new ResizeObserver(() => setHdrH(el.offsetHeight));
    ro.current.observe(el);
  }, []);

  useEffect(() => setLimit(PAGE), [text, cat, acct]);

  const results = useMemo(
    () =>
      searchTransactions(eff, {
        text,
        accountId: acct ?? undefined,
        categoryId: cat ?? undefined,
      }),
    [eff, text, cat, acct],
  );
  const legs = useMemo(() => {
    const m = new Map<string, Transaction[]>();
    for (const t of eff.transactions)
      if (t.transferId)
        m.set(t.transferId, [...(m.get(t.transferId) ?? []), t]);
    return m;
  }, [eff]);
  const items = useMemo(() => {
    const ids = new Set(results.map((r) => r.id));
    return results.flatMap((r) => {
      if (!r.transferId) return [{ t: r, other: null }];
      const other = legs.get(r.transferId)?.find((x) => x.id !== r.id) ?? null;
      if (other && ids.has(other.id) && r.amount > 0) return [];
      return [{ t: r, other }];
    });
  }, [results, legs]);

  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting) setLimit((l) => l + PAGE);
    });
    io.observe(el);
    return () => io.disconnect();
  }, [items.length]);

  const visible = items.slice(0, limit);
  const flashSet = new Set(flash);
  const catLabel = cat ? categoryName(eff, cat) : 'Any category';
  const acctLabel = acct ? accountName(eff, acct) : 'Any account';

  return (
    <div>
      <div
        ref={hdrRef}
        className="sticky top-0 z-20 bg-stone-100/95 px-4 pt-4 pb-3 backdrop-blur-md dark:bg-stone-950/90"
      >
        <div className="flex items-baseline justify-between">
          <h1 className="text-2xl font-semibold tracking-tight">Ledger</h1>
          <span className="text-xs text-stone-500 tabular-nums">
            {items.length.toLocaleString('en-CA')} rows
          </span>
        </div>
        <label className="mt-3 flex h-12 items-center gap-2 rounded-2xl bg-white px-3.5 ring-1 ring-stone-200 focus-within:ring-2 focus-within:ring-amber-500 dark:bg-stone-900 dark:ring-stone-800">
          <Search className="size-4.5 text-stone-400" aria-hidden />
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Search merchants and bank text"
            aria-label="Search"
            className="h-full min-w-0 flex-1 bg-transparent text-[1rem] outline-none placeholder:text-stone-400"
          />
          {text ? (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setText('')}
              className="grid size-8 place-items-center rounded-full text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-800"
            >
              <X className="size-4" aria-hidden />
            </button>
          ) : null}
        </label>
        <div className="qc-noscroll -mx-4 mt-2.5 flex gap-2 overflow-x-auto px-4">
          <FilterChip
            label={acctLabel}
            active={!!acct}
            onClick={() => setSheet('account')}
          />
          <FilterChip
            label={catLabel}
            active={!!cat}
            onClick={() => setSheet('category')}
          />
          <button
            type="button"
            onClick={() => setSheet('rules')}
            className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-sm font-medium text-stone-700 ring-1 ring-stone-300 hover:bg-white dark:text-stone-300 dark:ring-stone-700 dark:hover:bg-stone-900"
          >
            <BookMarked className="size-4" aria-hidden />
            Rules · {eff.rules.length}
          </button>
        </div>
      </div>

      {visible.length ? (
        <div>
          {visible.map(({ t, other }, i) => {
            const m = monthKey(t.date);
            const head = i === 0 || monthKey(visible[i - 1].t.date) !== m;
            return (
              <Fragment key={t.id}>
                {head ? (
                  <div
                    className="sticky z-10 flex items-baseline justify-between border-b border-stone-200/80 bg-stone-100/95 px-4 pt-3 pb-2 backdrop-blur-md dark:border-stone-800 dark:bg-stone-950/90"
                    style={{ top: hdrH }}
                  >
                    <h2 className="text-sm font-semibold">
                      {monthLong(m, true)}
                    </h2>
                    <span className="text-xs text-stone-500 tabular-nums">
                      Spent {money(spendMonths.get(m) ?? 0)}
                    </span>
                  </div>
                ) : null}
                <Row
                  t={t}
                  other={other}
                  flash={flashSet.has(t.id)}
                  onEdit={() => setEdit(t)}
                />
              </Fragment>
            );
          })}
          <div ref={sentinel} className="h-12" />
        </div>
      ) : (
        <div className="qc-in mx-4 mt-6 rounded-2xl bg-white px-6 py-10 text-center ring-1 ring-stone-200 dark:bg-stone-900 dark:ring-stone-800">
          <p className="font-semibold">Nothing matches</p>
          <p className="mt-1 text-sm text-stone-500">
            {text ? `No rows mention “${text}”` : 'No rows for these filters'}.
          </p>
          <QuietButton
            className="mt-4"
            onClick={() => {
              setText('');
              setCat(null);
              setAcct(null);
            }}
          >
            Clear filters
          </QuietButton>
        </div>
      )}

      <Sheet
        open={sheet === 'account'}
        onClose={() => setSheet(null)}
        title="Account"
      >
        <OptionList
          value={acct}
          onPick={(v) => {
            setAcct(v);
            setSheet(null);
          }}
          options={[
            { value: null, label: 'Any account' },
            ...eff.accounts
              .filter((a) => a.kind !== 'asset' && a.kind !== 'mortgage')
              .map((a) => ({
                value: a.id,
                label: a.name,
                hint: a.institution,
              })),
          ]}
        />
      </Sheet>
      <Sheet
        open={sheet === 'category'}
        onClose={() => setSheet(null)}
        title="Category"
      >
        <OptionList
          value={cat}
          onPick={(v) => {
            setCat(v);
            setSheet(null);
          }}
          options={[
            { value: null, label: 'Any category' },
            ...eff.categories
              .filter((c) => c.parentId === null)
              .flatMap((top) => [
                { value: top.id, label: top.name, hint: 'All of it' },
                ...eff.categories
                  .filter((c) => c.parentId === top.id)
                  .map((c) => ({ value: c.id, label: c.name, indent: true })),
              ]),
          ]}
        />
      </Sheet>
      <RulesSheet open={sheet === 'rules'} onClose={() => setSheet(null)} />
      {edit ? <RecatSheet tx={edit} onClose={() => setEdit(null)} /> : null}

      <Aside>
        <AsideSection title="Newest rules">
          <RuleList limit={8} />
        </AsideSection>
      </Aside>
    </div>
  );
}

function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex h-10 shrink-0 items-center gap-1 rounded-full pr-2.5 pl-3.5 text-sm font-medium transition ${
        active
          ? 'bg-amber-500 text-stone-950'
          : 'bg-white text-stone-700 ring-1 ring-stone-200 hover:ring-stone-300 dark:bg-stone-900 dark:text-stone-300 dark:ring-stone-800'
      }`}
    >
      {label}
      <ChevronDown className="size-4" aria-hidden />
    </button>
  );
}

function OptionList({
  options,
  value,
  onPick,
}: {
  options: {
    value: string | null;
    label: string;
    hint?: string;
    indent?: boolean;
  }[];
  value: string | null;
  onPick: (v: string | null) => void;
}) {
  return (
    <ul className="-mx-2">
      {options.map((o) => (
        <li key={o.value ?? 'any'}>
          <button
            type="button"
            onClick={() => onPick(o.value)}
            className={`flex min-h-12 w-full items-center gap-3 rounded-xl px-2 text-left hover:bg-stone-200/50 dark:hover:bg-stone-800 ${o.indent ? 'pl-7 text-stone-600 dark:text-stone-400' : 'font-medium'}`}
          >
            <span className="flex-1">{o.label}</span>
            {o.hint ? (
              <span className="text-xs text-stone-500">{o.hint}</span>
            ) : null}
            <Check
              aria-hidden
              strokeWidth={3}
              className={`size-4 text-amber-600 dark:text-amber-300 ${o.value === value ? '' : 'invisible'}`}
            />
          </button>
        </li>
      ))}
    </ul>
  );
}

function Row({
  t,
  other,
  flash,
  onEdit,
}: {
  t: Transaction;
  other: Transaction | null;
  flash: boolean;
  onEdit: () => void;
}) {
  const { eff, pal } = useTally();
  const [open, setOpen] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const fired = useRef(false);
  const isTransfer = !!t.transferId;
  const from = other && t.amount > 0 ? other : t;
  const to = other && t.amount > 0 ? t : other;
  const cancel = () => window.clearTimeout(timer.current);

  return (
    <div
      className={`border-b border-stone-200/60 dark:border-stone-800/70 ${flash ? 'qc-flash' : ''}`}
    >
      <div className="flex items-center">
        <button
          type="button"
          aria-expanded={open}
          onPointerDown={() => {
            fired.current = false;
            if (isTransfer) return;
            timer.current = window.setTimeout(() => {
              fired.current = true;
              navigator.vibrate?.(8);
              onEdit();
            }, 480);
          }}
          onPointerUp={cancel}
          onPointerLeave={cancel}
          onPointerCancel={cancel}
          onContextMenu={(e) => {
            if (isTransfer) return;
            e.preventDefault();
            cancel();
            onEdit();
          }}
          onClick={() => {
            if (fired.current) {
              fired.current = false;
              return;
            }
            setOpen((o) => !o);
          }}
          className="flex min-h-[4.25rem] min-w-0 flex-1 items-center gap-3 py-2.5 pl-4 text-left transition select-none hover:bg-white/70 active:bg-white dark:hover:bg-stone-900/60 dark:active:bg-stone-900"
          style={{ WebkitTouchCallout: 'none' }}
        >
          {isTransfer ? (
            <span className="grid size-10 shrink-0 place-items-center rounded-full bg-stone-200/80 text-stone-600 dark:bg-stone-800 dark:text-stone-300">
              <ArrowLeftRight className="size-4.5" aria-hidden />
            </span>
          ) : (
            <Monogram name={t.merchant} size={40} />
          )}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[0.98rem] font-medium text-stone-900 dark:text-stone-50">
              {isTransfer
                ? `${accountName(eff, from.accountId)} → ${to ? accountName(eff, to.accountId) : '?'}`
                : t.merchant}
            </span>
            <span className="mt-1 flex items-center gap-2">
              <CategoryChip
                ledger={eff}
                categoryId={t.categoryId}
                name={categoryName(eff, t.categoryId)}
                pal={pal}
                manual={t.source === 'manual'}
              />
              <span className="shrink-0 text-xs text-stone-500">
                {dayLabel(t.date)}
              </span>
            </span>
          </span>
          <span
            className={`shrink-0 pr-1 text-[0.98rem] font-semibold tabular-nums ${
              isTransfer
                ? 'text-stone-500'
                : t.amount > 0
                  ? 'text-[#006300] dark:text-[#3bc43b]'
                  : 'text-stone-900 dark:text-stone-50'
            }`}
          >
            {isTransfer
              ? moneyCents(Math.abs(t.amount))
              : `${t.amount > 0 ? '+' : ''}${moneyCents(t.amount)}`}
          </span>
        </button>
        {isTransfer ? (
          <span className="w-11 shrink-0" />
        ) : (
          <button
            type="button"
            aria-label={`Change category for ${t.merchant}`}
            onClick={onEdit}
            className="mr-1 grid size-11 shrink-0 place-items-center rounded-full text-stone-400 hover:bg-stone-200/70 hover:text-stone-700 dark:hover:bg-stone-800 dark:hover:text-stone-200"
          >
            <EllipsisVertical className="size-4.5" aria-hidden />
          </button>
        )}
      </div>
      {open ? (
        <dl className="qc-fade grid grid-cols-[6.5rem_1fr] gap-x-3 gap-y-1 px-4 pb-3 pl-[4.25rem] text-xs">
          <dt className="text-stone-500">Bank text</dt>
          <dd className="truncate font-mono">{t.descriptor}</dd>
          {other ? (
            <>
              <dt className="text-stone-500">Other leg</dt>
              <dd className="truncate font-mono">
                {other.descriptor} · {dayLabel(other.date)}
              </dd>
            </>
          ) : null}
          <dt className="text-stone-500">Account</dt>
          <dd>
            {accountName(eff, t.accountId)} ·{' '}
            {eff.accounts.find((a) => a.id === t.accountId)?.institution}
          </dd>
          <dt className="text-stone-500">Category set by</dt>
          <dd>
            {t.source === 'manual'
              ? 'You'
              : t.source === 'model'
                ? `The model, ${pct(t.confidence ?? 0)} sure`
                : 'A rule'}
          </dd>
          <dt className="text-stone-500">Import</dt>
          <dd className="font-mono">{t.batchId}</dd>
        </dl>
      ) : null}
    </div>
  );
}

function RecatSheet({ tx, onClose }: { tx: Transaction; onClose: () => void }) {
  const { eff, recategorise, similar } = useTally();
  const [pick, setPick] = useState(tx.categoryId);
  const [always, setAlways] = useState(false);
  const match = ruleMatchFor(tx.descriptor);
  const n = similar(tx.descriptor);
  const groups = leafCategories(eff);
  const changed = pick !== tx.categoryId || always;
  return (
    <Sheet
      open
      tall
      onClose={onClose}
      title="Change category"
      footer={
        <div className="space-y-3">
          <div className="flex items-start gap-3 rounded-2xl bg-white p-3.5 ring-1 ring-stone-200 dark:bg-stone-950/60 dark:ring-stone-800">
            <div className="min-w-0 flex-1">
              <div className="text-[0.95rem] font-medium">Always do this</div>
              <p className="mt-0.5 text-xs text-stone-500">
                Makes a rule: bank text containing{' '}
                <span className="font-mono text-stone-700 dark:text-stone-300">
                  “{match}”
                </span>{' '}
                becomes {categoryName(eff, pick)}.{' '}
                <strong className="font-semibold text-stone-800 dark:text-stone-200">
                  {n} row{n === 1 ? '' : 's'}
                </strong>{' '}
                change now, and future imports follow it.
              </p>
            </div>
            <Toggle on={always} onChange={setAlways} label="Always do this" />
          </div>
          <div className="flex gap-2">
            <QuietButton onClick={onClose}>Cancel</QuietButton>
            <PrimaryButton
              className="flex-1"
              disabled={!changed}
              onClick={() => {
                recategorise(tx.id, pick, always);
                onClose();
              }}
            >
              {always ? `Change ${n} rows` : 'Change this row'}
            </PrimaryButton>
          </div>
        </div>
      }
    >
      <div className="mb-4 flex items-center gap-3">
        <Monogram name={tx.merchant} />
        <div className="min-w-0 flex-1">
          <div className="font-semibold">{tx.merchant}</div>
          <div className="truncate font-mono text-xs text-stone-500">
            {tx.descriptor}
          </div>
        </div>
        <div className="text-right">
          <div className="font-semibold tabular-nums">
            {moneyCents(tx.amount)}
          </div>
          <div className="text-xs text-stone-500">
            {dayLabel(tx.date, true)}
          </div>
        </div>
      </div>
      <div className="space-y-4">
        {groups.map(({ top, leaves }) => {
          const opts = leaves.length ? leaves : [top];
          return (
            <section key={top.id}>
              <h3 className="mb-1.5 text-xs font-semibold tracking-wide text-stone-500 uppercase">
                {top.name}
              </h3>
              <div className="flex flex-wrap gap-1.5">
                {opts.map((c) => {
                  const on = pick === c.id;
                  return (
                    <button
                      key={c.id}
                      type="button"
                      aria-pressed={on}
                      onClick={() => setPick(c.id)}
                      className={`min-h-10 rounded-xl px-3 text-sm font-medium transition ${
                        on
                          ? 'bg-amber-500 text-stone-950 shadow-sm'
                          : 'bg-white text-stone-700 ring-1 ring-stone-200 hover:ring-stone-300 dark:bg-stone-950/60 dark:text-stone-300 dark:ring-stone-800'
                      }`}
                    >
                      {c.name}
                    </button>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
    </Sheet>
  );
}

function RuleList({ limit }: { limit?: number }) {
  const { eff, userRules, pal } = useTally();
  const mine = new Set(userRules.map((r) => r.id));
  const rules = limit ? eff.rules.slice(0, limit) : eff.rules;
  return (
    <ul className="divide-y divide-stone-200 dark:divide-stone-800">
      {rules.map((r) => (
        <li
          key={r.id}
          className={`flex items-center gap-3 py-2.5 ${mine.has(r.id) ? 'qc-in' : ''}`}
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate font-mono text-[13px]">
                “{r.match}”
              </span>
              {mine.has(r.id) ? (
                <span className="rounded-full bg-amber-500 px-1.5 py-px text-[10px] font-bold text-stone-950 uppercase">
                  New
                </span>
              ) : null}
            </div>
            <div className="mt-1">
              <CategoryChip
                ledger={eff}
                categoryId={r.categoryId}
                name={categoryName(eff, r.categoryId)}
                pal={pal}
              />
            </div>
          </div>
          <span className="text-xs text-stone-500 tabular-nums">
            {r.hits} rows
          </span>
        </li>
      ))}
    </ul>
  );
}

function RulesSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { eff } = useTally();
  return (
    <Sheet open={open} onClose={onClose} title={`Rules · ${eff.rules.length}`}>
      <p className="mb-2 text-sm text-stone-500">
        Rules run before the model. A row a rule places never leaves the lab.
      </p>
      <RuleList />
    </Sheet>
  );
}
