import { ArrowLeftRight, Check, Search, Sparkles, X } from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import {
  cadCents,
  categoryById,
  searchTransactions,
  topLevel,
} from '~/fixtures/derive';
import type { Ledger, Rule, Transaction } from '~/fixtures/types';
import { Empty, Kicker, Monogram } from './bits';
import {
  accountLabel,
  dayHeading,
  type Entry,
  groupByDay,
  monogram,
  transferLegs,
} from './model';
import { groupColor } from './theme';

export type Recategorise = (
  id: string,
  categoryId: string,
  always: boolean,
) => number;

const PAGE = 14;

function amountText(n: number) {
  return n < 0 ? `−${cadCents.format(-n)}` : `+${cadCents.format(n)}`;
}

export function Transactions({
  ledger,
  sessionRules,
  initialCategory,
  onRecategorise,
}: {
  ledger: Ledger;
  sessionRules: Rule[];
  initialCategory?: string;
  onRecategorise: Recategorise;
}) {
  const [text, setText] = useState('');
  const [categoryId, setCategoryId] = useState(initialCategory ?? '');
  const [accountId, setAccountId] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [pages, setPages] = useState(1);
  const [flash, setFlash] = useState<string | null>(null);

  const byId = useMemo(() => categoryById(ledger), [ledger]);
  const legs = useMemo(() => transferLegs(ledger), [ledger]);
  const rows = useMemo(
    () =>
      searchTransactions(ledger, {
        text,
        categoryId: categoryId || undefined,
        accountId: accountId || undefined,
      }),
    [ledger, text, categoryId, accountId],
  );
  const days = useMemo(() => groupByDay(rows, legs), [rows, legs]);
  const shown = days.slice(0, pages * PAGE);
  const tops = ledger.categories.filter((c) => !c.parentId);
  const filtered = !!(text || categoryId || accountId);

  const reset = () => {
    setText('');
    setCategoryId('');
    setAccountId('');
    setPages(1);
  };

  return (
    <div className="vb-in mx-auto max-w-[880px] px-5 pt-14 pb-32 sm:px-8 sm:pt-20">
      <Kicker>The ledger</Kicker>
      <h1 className="serif mt-3 text-[44px] leading-[1.05] text-(--ink) sm:text-[56px]">
        Transactions
      </h1>
      <p className="mt-4 text-[17px] text-(--ink2)">
        {rows.length.toLocaleString('en-CA')}{' '}
        {filtered ? 'match' : 'rows across'}{' '}
        {filtered ? '' : `${ledger.accounts.length} accounts`}
        {filtered ? (
          <>
            {' · '}
            <button
              type="button"
              onClick={reset}
              className="text-(--ink) underline decoration-(--axis) underline-offset-4 hover:decoration-(--ink)"
            >
              clear filters
            </button>
          </>
        ) : (
          '. Transfers between your own accounts show once, with both sides named.'
        )}
      </p>

      <div className="sticky top-[68px] z-10 -mx-5 mt-10 bg-(--page)/90 px-5 py-3 backdrop-blur-md sm:-mx-8 sm:px-8">
        <div className="flex flex-wrap gap-2.5">
          <label className="flex min-w-[220px] flex-1 items-center gap-2 rounded-full bg-(--sunk) px-4 py-2.5 ring-1 ring-(--hair) focus-within:ring-(--axis)">
            <Search className="size-4 text-(--muted)" aria-hidden />
            <span className="sr-only">Search</span>
            <input
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setPages(1);
              }}
              placeholder="Search merchants and bank descriptors"
              className="w-full bg-transparent text-[15px] text-(--ink) outline-none placeholder:text-(--muted)"
            />
            {text ? (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => setText('')}
                className="text-(--muted) hover:text-(--ink)"
              >
                <X className="size-4" />
              </button>
            ) : null}
          </label>
          <Select
            label="Category"
            value={categoryId}
            onChange={(v) => {
              setCategoryId(v);
              setPages(1);
            }}
          >
            <option value="">All categories</option>
            {tops.map((top) => {
              const kids = ledger.categories.filter(
                (c) => c.parentId === top.id,
              );
              return kids.length ? (
                <optgroup key={top.id} label={top.name}>
                  <option value={top.id}>All {top.name.toLowerCase()}</option>
                  {kids.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </optgroup>
              ) : (
                <option key={top.id} value={top.id}>
                  {top.name}
                </option>
              );
            })}
          </Select>
          <Select
            label="Account"
            value={accountId}
            onChange={(v) => {
              setAccountId(v);
              setPages(1);
            }}
          >
            <option value="">All accounts</option>
            {ledger.accounts
              .filter((a) => a.kind !== 'asset' && a.kind !== 'mortgage')
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.institution} {a.name}
                </option>
              ))}
          </Select>
        </div>
      </div>

      {flash ? (
        <output className="vb-in mt-6 flex items-center gap-3 rounded-2xl bg-(--sunk) px-5 py-3.5 text-[14px] text-(--ink) ring-1 ring-(--hair)">
          <Check className="size-4 text-(--good)" aria-hidden />
          {flash}
          <button
            type="button"
            className="ml-auto text-(--muted) hover:text-(--ink)"
            aria-label="Dismiss"
            onClick={() => setFlash(null)}
          >
            <X className="size-4" />
          </button>
        </output>
      ) : null}

      {sessionRules.length ? (
        <section className="mt-8 rounded-3xl border border-(--hair) px-6 py-5">
          <div className="flex items-center gap-2 text-[13px] font-medium text-(--ink2)">
            <Sparkles className="size-4" aria-hidden /> Rules you made this
            session
          </div>
          <ul className="mt-3 divide-y divide-(--hair)">
            {sessionRules.map((r) => (
              <li
                key={r.id}
                className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2.5"
              >
                <code className="rounded bg-(--sunk) px-1.5 py-0.5 font-mono text-[12px] text-(--ink)">
                  {r.match}
                </code>
                <span className="text-(--muted)">→</span>
                <span className="text-[14px] text-(--ink)">
                  {byId.get(r.categoryId)?.name}
                </span>
                <span className="ml-auto text-[12px] text-(--muted)">
                  {r.hits} {r.hits === 1 ? 'row' : 'rows'} today, and every
                  import after
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="mt-6">
        {shown.length === 0 ? (
          <div className="mt-10">
            <Empty title="Nothing matches">
              No transaction has that merchant or descriptor in the accounts and
              categories you picked.{' '}
              <button
                type="button"
                className="underline underline-offset-4"
                onClick={reset}
              >
                Clear the filters
              </button>
              .
            </Empty>
          </div>
        ) : null}
        {shown.map((day) => {
          const head = dayHeading(day.date);
          const spent = day.entries.reduce(
            (s, e) =>
              s + (e.kind === 'txn' && e.t.amount < 0 ? -e.t.amount : 0),
            0,
          );
          return (
            <section key={day.date} className="mt-10">
              <header className="flex items-baseline justify-between border-b border-(--hair) pb-2.5">
                <h2 className="text-(--ink)">
                  <span className="serif text-[22px]">{head.weekday}</span>
                  <span className="ml-3 text-[14px] text-(--muted)">
                    {head.date}, {head.year}
                  </span>
                </h2>
                {spent ? (
                  <span className="num text-[13px] text-(--muted)">
                    {cadCents.format(spent)} out
                  </span>
                ) : null}
              </header>
              <ul>
                {day.entries.map((e) => (
                  <Row
                    key={e.key}
                    entry={e}
                    ledger={ledger}
                    open={open === e.key}
                    onToggle={() => setOpen(open === e.key ? null : e.key)}
                    onSave={(id, cat, always) => {
                      const n = onRecategorise(id, cat, always);
                      const name = byId.get(cat)?.name ?? cat;
                      setFlash(
                        always
                          ? `Moved ${n} ${n === 1 ? 'row' : 'rows'} to ${name} and made a rule for the next import.`
                          : `Moved to ${name}.`,
                      );
                      setOpen(null);
                    }}
                  />
                ))}
              </ul>
            </section>
          );
        })}
        {days.length > shown.length ? (
          <div className="mt-12 flex justify-center">
            <button
              type="button"
              onClick={() => setPages((p) => p + 1)}
              className="rounded-full px-5 py-2.5 text-[14px] text-(--ink) ring-1 ring-(--hair) transition hover:bg-(--wash) hover:ring-(--axis)"
            >
              Earlier days (
              {(days.length - shown.length).toLocaleString('en-CA')} more)
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Select({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  children: ReactNode;
}) {
  return (
    <label className="relative">
      <span className="sr-only">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`appearance-none rounded-full bg-(--sunk) py-2.5 pr-9 pl-4 text-[14px] ring-1 ring-(--hair) outline-none hover:ring-(--axis) ${value ? 'text-(--ink)' : 'text-(--ink2)'}`}
      >
        {children}
      </select>
      <span
        aria-hidden
        className="pointer-events-none absolute top-1/2 right-3.5 -translate-y-1/2 text-[10px] text-(--muted)"
      >
        ▼
      </span>
    </label>
  );
}

function Row({
  entry,
  ledger,
  open,
  onToggle,
  onSave,
}: {
  entry: Entry;
  ledger: Ledger;
  open: boolean;
  onToggle: () => void;
  onSave: (id: string, categoryId: string, always: boolean) => void;
}) {
  const byId = categoryById(ledger);
  if (entry.kind === 'transfer') {
    const from = accountLabel(ledger, entry.out.accountId);
    const to = entry.in
      ? accountLabel(ledger, entry.in.accountId)
      : 'an account outside tally';
    return (
      <li className="border-b border-(--hair) last:border-b-0">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="grid w-full grid-cols-[40px_1fr_auto] items-center gap-4 rounded-xl py-4 text-left transition-colors hover:bg-(--wash) sm:-mx-3 sm:w-[calc(100%+1.5rem)] sm:px-3"
        >
          <span className="inline-flex size-10 items-center justify-center rounded-full bg-(--sunk) text-(--ink2) ring-1 ring-(--hair)">
            <ArrowLeftRight className="size-4" aria-hidden />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-[15px] text-(--ink)">
              {from} <span className="text-(--muted)">→</span> {to}
            </span>
            <span className="mt-0.5 block text-[13px] text-(--muted)">
              {byId.get(entry.out.categoryId)?.name} ·{' '}
              {entry.in ? 'both sides matched' : 'one side only'}
            </span>
          </span>
          <span className="num text-[15px] text-(--ink2)">
            {cadCents.format(Math.abs(entry.out.amount))}
          </span>
        </button>
        {open ? (
          <div className="vb-in mb-4 grid gap-3 rounded-2xl bg-(--sunk) p-5 text-[14px] sm:grid-cols-2">
            {[entry.out, entry.in].filter(Boolean).map((t) => (
              <Leg
                key={(t as Transaction).id}
                t={t as Transaction}
                ledger={ledger}
              />
            ))}
            <p className="text-[13px] text-(--muted) sm:col-span-2">
              Counted once and left out of spending and income. Money moved,
              nothing was bought.
            </p>
          </div>
        ) : null}
      </li>
    );
  }
  const t = entry.t;
  const cat = byId.get(t.categoryId);
  const top = topLevel(ledger, t.categoryId);
  return (
    <li className="border-b border-(--hair) last:border-b-0">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="grid w-full grid-cols-[40px_1fr_auto] items-center gap-4 rounded-xl py-4 text-left transition-colors hover:bg-(--wash) sm:-mx-3 sm:w-[calc(100%+1.5rem)] sm:px-3"
      >
        <Monogram text={monogram(t.merchant)} groupId={top.id} />
        <span className="min-w-0">
          <span className="block truncate text-[15px] text-(--ink)">
            {t.merchant}
          </span>
          <span className="mt-0.5 flex items-center gap-1.5 text-[13px] text-(--muted)">
            <span
              className="size-1.5 shrink-0 rounded-full"
              style={{ background: groupColor(top.id) }}
            />
            <span
              className={t.categoryId === 'uncategorized' ? 'text-(--bad)' : ''}
            >
              {cat?.name}
            </span>
            <span>·</span>
            <span className="truncate">
              {accountLabel(ledger, t.accountId)}
            </span>
            {t.source === 'model' &&
            t.confidence != null &&
            t.confidence < 0.8 ? (
              <span className="ml-1 rounded-full px-1.5 text-[11px] ring-1 ring-(--hair)">
                guess
              </span>
            ) : null}
          </span>
        </span>
        <span
          className="num text-[15px] font-medium"
          style={{ color: t.amount > 0 ? 'var(--good)' : 'var(--ink)' }}
        >
          {amountText(t.amount)}
        </span>
      </button>
      {open ? <Recategoriser t={t} ledger={ledger} onSave={onSave} /> : null}
    </li>
  );
}

function Leg({ t, ledger }: { t: Transaction; ledger: Ledger }) {
  return (
    <div className="rounded-xl bg-(--raise) p-4 ring-1 ring-(--hair)">
      <div className="text-[12px] text-(--muted)">
        {t.amount < 0 ? 'Left' : 'Arrived in'} · {t.date}
      </div>
      <div className="mt-1 text-(--ink)">
        {accountLabel(ledger, t.accountId)}
      </div>
      <code className="mt-2 block font-mono text-[12px] text-(--ink2)">
        {t.descriptor}
      </code>
      <div className="num mt-2 font-semibold text-(--ink)">
        {amountText(t.amount)}
      </div>
    </div>
  );
}

function sourceLine(t: Transaction) {
  if (t.source === 'manual') return 'You set this category.';
  if (t.source === 'rule') return 'A rule set this category.';
  const c = t.confidence ?? 0;
  return `The model guessed this, ${Math.round(c * 100)}% sure.`;
}

function Recategoriser({
  t,
  ledger,
  onSave,
}: {
  t: Transaction;
  ledger: Ledger;
  onSave: (id: string, categoryId: string, always: boolean) => void;
}) {
  const [pick, setPick] = useState(t.categoryId);
  const [always, setAlways] = useState(false);
  const flowWanted = t.amount > 0 ? 'income' : 'expense';
  const tops = ledger.categories.filter(
    (c) => !c.parentId && c.flow === flowWanted,
  );
  const similar = ledger.transactions.filter(
    (x) =>
      x.id !== t.id &&
      x.descriptor === t.descriptor &&
      !x.transferId &&
      x.categoryId !== pick,
  ).length;
  const pickName = ledger.categories.find((c) => c.id === pick)?.name ?? pick;
  const changed = pick !== t.categoryId || (always && similar > 0);

  return (
    <div className="vb-in mb-5 rounded-2xl bg-(--sunk) p-5 sm:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <code className="font-mono text-[12px] text-(--ink2)">
          {t.descriptor}
        </code>
        <span className="text-[12px] text-(--muted)">
          {t.date} · {sourceLine(t)}
        </span>
      </div>
      <div className="mt-5 space-y-4">
        {tops.map((top) => {
          const kids = ledger.categories.filter((c) => c.parentId === top.id);
          const options = kids.length ? kids : [top];
          return (
            <fieldset
              key={top.id}
              className="flex flex-wrap items-center gap-2"
            >
              <legend className="mb-2 w-full text-[11px] font-semibold tracking-[0.14em] text-(--muted) uppercase">
                {top.name}
              </legend>
              {options.map((c) => {
                const on = pick === c.id;
                return (
                  <button
                    key={c.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setPick(c.id)}
                    className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] transition ${
                      on
                        ? 'bg-(--ink) text-(--page)'
                        : 'bg-(--raise) text-(--ink) ring-1 ring-(--hair) hover:ring-(--axis)'
                    }`}
                  >
                    <span
                      className="size-1.5 rounded-full"
                      style={{ background: groupColor(top.id) }}
                    />
                    {c.name}
                  </button>
                );
              })}
            </fieldset>
          );
        })}
      </div>
      <label className="mt-6 flex cursor-pointer items-start gap-3 rounded-xl bg-(--raise) p-4 ring-1 ring-(--hair)">
        <input
          type="checkbox"
          checked={always}
          onChange={(e) => setAlways(e.target.checked)}
          className="mt-0.5 size-4 accent-(--ink)"
        />
        <span className="text-[14px] leading-snug text-(--ink)">
          Always file{' '}
          <span className="font-mono text-[12.5px]">{t.descriptor}</span> under{' '}
          {pickName}
          <span className="mt-1 block text-[13px] text-(--muted)">
            {similar
              ? `Also moves ${similar} other ${similar === 1 ? 'row' : 'rows'} with this descriptor, and every future import.`
              : 'No other rows have this descriptor yet; the rule applies to future imports.'}
          </span>
        </span>
      </label>
      <div className="mt-5 flex justify-end gap-2">
        <button
          type="button"
          disabled={!changed}
          onClick={() => onSave(t.id, pick, always)}
          className="rounded-full bg-(--ink) px-5 py-2 text-[14px] font-medium text-(--page) transition enabled:hover:opacity-90 disabled:opacity-30"
        >
          {always && similar
            ? `Move ${similar + (pick !== t.categoryId ? 1 : 0)} rows`
            : 'Save'}
        </button>
      </div>
    </div>
  );
}
