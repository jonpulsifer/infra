import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  FileScan,
  FileSpreadsheet,
  FileText,
  Lock,
  Send,
  UploadCloud,
} from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import { cadCents, categoryById } from '~/fixtures/derive';
import type {
  Finding,
  Ledger,
  PreviewFile,
  Transaction,
} from '~/fixtures/types';
import { Kicker } from './bits';
import { accountLabel, longDate, monthYear } from './model';

type Step = 'drop' | 'files' | 'findings' | 'confirm' | 'done';
type Kind = Finding['kind'];

const STEPS: { key: Exclude<Step, 'done'>; label: string }[] = [
  { key: 'drop', label: 'Drop' },
  { key: 'files', label: 'Files' },
  { key: 'findings', label: 'Findings' },
  { key: 'confirm', label: 'Confirm' },
];

function byKind<K extends Kind>(fs: Finding[], k: K) {
  return fs.filter((f): f is Extract<Finding, { kind: K }> => f.kind === k);
}

function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

export function Import({
  ledger,
  onSeeTransactions,
}: {
  ledger: Ledger;
  onSeeTransactions: () => void;
}) {
  const p = ledger.preview;
  const [step, setStep] = useState<Step>(() => {
    const q = new URLSearchParams(window.location.search).get('step');
    return STEPS.some((x) => x.key === q) ? (q as Step) : 'drop';
  });
  const [dragging, setDragging] = useState(false);
  const [assign, setAssign] = useState<Record<string, string>>(() =>
    Object.fromEntries(p.files.map((f) => [f.name, f.accountId ?? ''])),
  );
  const [dupes, setDupes] = useState<Record<string, 'skip' | 'keep'>>({});
  const [pairs, setPairs] = useState<Record<string, 'link' | 'separate'>>({});
  const [gapAck, setGapAck] = useState<Record<string, boolean>>({});
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [local, setLocal] = useState<Set<string>>(new Set());
  const [openKind, setOpenKind] = useState<Kind | null>(null);

  const txn = useMemo(() => {
    const m = new Map<string, Transaction>();
    for (const t of ledger.transactions) m.set(t.id, t);
    for (const t of p.newTransactions) m.set(t.id, t);
    return m;
  }, [ledger, p]);
  const cats = useMemo(() => categoryById(ledger), [ledger]);

  const duplicates = byKind(p.findings, 'duplicate');
  const gaps = byKind(p.findings, 'missing-period');
  const transfers = byKind(p.findings, 'transfer');
  const unknown = byKind(p.findings, 'low-confidence');

  const skipped = duplicates.filter(
    (d) => (dupes[d.id] ?? 'skip') === 'skip',
  ).length;
  const rows = p.newTransactions.length - skipped;
  const settledDescriptors = new Set(
    unknown
      .filter((u) => picked[u.id])
      .map((u) => txn.get(u.transactionId)?.descriptor),
  );
  const outbound = p.outboundStrings.filter((s) => !settledDescriptors.has(s));
  const sending = outbound.filter((s) => !local.has(s));
  const keptLocal = outbound.filter((s) => local.has(s));
  const unassigned = p.files.filter((f) => !assign[f.name]);
  const allFrom = p.files.map((f) => f.from).sort()[0];
  const allTo = p.files
    .map((f) => f.to)
    .sort()
    .slice(-1)[0];

  const settled =
    duplicates.length +
    transfers.length +
    gaps.filter((g) => gapAck[g.id]).length +
    unknown.filter((u) => picked[u.id]).length;

  const reset = () => {
    setStep('drop');
    setDupes({});
    setPairs({});
    setGapAck({});
    setPicked({});
    setLocal(new Set());
    setOpenKind(null);
  };

  const phrases = (
    [
      {
        kind: 'duplicate',
        n: duplicates.length,
        text: plural(duplicates.length, 'duplicate'),
      },
      ...gaps.map((g) => ({
        kind: 'missing-period' as const,
        n: 1,
        text: `1 missing period on ${accountLabel(ledger, g.accountId)} ${monthYear(g.from).split(' ')[0]} to ${monthYear(g.to)}`,
      })),
      {
        kind: 'transfer',
        n: transfers.length,
        text: plural(transfers.length, 'transfer pair'),
      },
      {
        kind: 'low-confidence',
        n: unknown.length,
        text: `${plural(unknown.length, 'merchant')} the rules did not know`,
      },
    ] as { kind: Kind; text: string; n: number }[]
  ).filter((x) => x.n > 0);

  return (
    <div className="vb-in mx-auto max-w-[920px] px-5 pt-14 pb-32 sm:px-8 sm:pt-20">
      <Kicker>Bring in statements</Kicker>
      <h1 className="serif mt-3 text-[44px] leading-[1.05] text-(--ink) sm:text-[56px]">
        Import
      </h1>

      {step !== 'done' ? (
        <ol className="mt-10 flex flex-wrap items-center gap-x-2 gap-y-3">
          {STEPS.map((s, i) => {
            const idx = STEPS.findIndex((x) => x.key === step);
            const done = i < idx;
            const on = i === idx;
            return (
              <li key={s.key} className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={!done}
                  onClick={() => setStep(s.key)}
                  className={`flex items-center gap-2.5 rounded-full py-1.5 pr-4 pl-1.5 text-[14px] transition ${
                    on
                      ? 'bg-(--sunk) text-(--ink) ring-1 ring-(--hair)'
                      : done
                        ? 'text-(--ink2) hover:bg-(--wash)'
                        : 'text-(--muted)'
                  }`}
                >
                  <span
                    className={`serif inline-flex size-7 items-center justify-center rounded-full text-[14px] ${
                      on
                        ? 'bg-(--ink) text-(--page)'
                        : done
                          ? 'bg-(--sunk) text-(--ink)'
                          : 'ring-1 ring-(--hair)'
                    }`}
                  >
                    {done ? <Check className="size-3.5" /> : i + 1}
                  </span>
                  {s.label}
                </button>
                {i < STEPS.length - 1 ? (
                  <span aria-hidden className="h-px w-6 bg-(--hair)" />
                ) : null}
              </li>
            );
          })}
        </ol>
      ) : null}

      {step === 'drop' ? (
        <div className="vb-in mt-10">
          <label
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              setStep('files');
            }}
            className={`flex cursor-pointer flex-col items-center justify-center rounded-[28px] border-2 border-dashed px-8 py-24 text-center transition ${
              dragging
                ? 'border-(--s1) bg-(--wash)'
                : 'border-(--axis) hover:border-(--ink2) hover:bg-(--wash)'
            }`}
          >
            <input
              type="file"
              multiple
              className="sr-only"
              onChange={() => setStep('files')}
            />
            <UploadCloud
              className="size-10 text-(--ink2)"
              strokeWidth={1.25}
              aria-hidden
            />
            <span className="serif mt-6 text-[28px] text-(--ink)">
              Drop statements here
            </span>
            <span className="mt-3 max-w-md text-[15px] leading-relaxed text-(--ink2)">
              QFX, OFX, CSV or PDF, as many as you like. Nothing leaves this
              machine until the last step, and that step lists exactly what
              would.
            </span>
          </label>
          <div className="mt-6 flex justify-center">
            <button
              type="button"
              onClick={() => setStep('files')}
              className="inline-flex items-center gap-2 rounded-full px-5 py-2.5 text-[14px] text-(--ink) ring-1 ring-(--hair) transition hover:bg-(--wash) hover:ring-(--axis)"
            >
              Use this month’s exports ({p.files.length} files)
              <ArrowRight className="size-4" />
            </button>
          </div>
        </div>
      ) : null}

      {step === 'files' ? (
        <div className="vb-in mt-10">
          <p className="serif max-w-2xl text-[22px] leading-snug text-(--ink)">
            {plural(p.files.length, 'file')},{' '}
            {p.files.reduce((s, f) => s + f.rows, 0)} rows between{' '}
            {longDate(allFrom)} and {longDate(allTo)}.
            {unassigned.length
              ? ` ${unassigned.length === 1 ? 'One needs' : `${unassigned.length} need`} an account before tally can read it.`
              : ' Each one knows its account.'}
          </p>
          <div className="mt-8 grid gap-4 sm:grid-cols-2">
            {p.files.map((f) => (
              <FileCard
                key={f.name}
                file={f}
                ledger={ledger}
                value={assign[f.name]}
                onAssign={(v) => setAssign((a) => ({ ...a, [f.name]: v }))}
              />
            ))}
          </div>
          <Nav
            back={() => setStep('drop')}
            next={() => setStep('findings')}
            nextLabel="Read the files"
            disabled={unassigned.length > 0}
            hint={
              unassigned.length
                ? 'Pick an account for every file to continue.'
                : undefined
            }
          />
        </div>
      ) : null}

      {step === 'findings' ? (
        <div className="vb-in mt-10">
          <p className="serif text-[25px] leading-[1.5] text-pretty text-(--ink) sm:text-[28px]">
            Reading {plural(p.newTransactions.length, 'row')}, tally found{' '}
            {phrases.map((ph, i) => (
              <span key={ph.text}>
                <button
                  type="button"
                  onClick={() =>
                    setOpenKind(openKind === ph.kind ? null : ph.kind)
                  }
                  aria-expanded={openKind === ph.kind}
                  className={`underline decoration-1 underline-offset-[6px] transition ${
                    openKind === ph.kind
                      ? 'decoration-(--ink) decoration-2'
                      : 'decoration-(--axis) hover:decoration-(--ink)'
                  }`}
                >
                  {ph.text}
                </button>
                {i < phrases.length - 2
                  ? ', '
                  : i === phrases.length - 2
                    ? ', and '
                    : '.'}
              </span>
            ))}
          </p>
          <p className="mt-5 max-w-2xl text-[16px] leading-relaxed text-(--ink2)">
            {plural(p.rulesHit, 'row')} matched a rule you already have.{' '}
            {outbound.length
              ? `${plural(outbound.length, 'descriptor')} would go to the model for a category; settle them here and they stay home.`
              : 'Nothing needs the model.'}{' '}
            <span className="text-(--muted)">
              {settled} of {p.findings.length} findings settled.
            </span>
          </p>

          <div className="mt-10 divide-y divide-(--hair) border-y border-(--hair)">
            {duplicates.length ? (
              <Detail
                title="Duplicates"
                summary={`${skipped} will be skipped`}
                open={openKind === 'duplicate'}
                onToggle={() =>
                  setOpenKind(openKind === 'duplicate' ? null : 'duplicate')
                }
              >
                {duplicates.map((d) => {
                  const t = txn.get(d.transactionId);
                  const choice = dupes[d.id] ?? 'skip';
                  return (
                    <Card key={d.id}>
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <span className="text-[15px] text-(--ink)">
                          {t?.merchant}{' '}
                          <span className="num text-(--ink2)">
                            {t ? cadCents.format(Math.abs(t.amount)) : ''}
                          </span>
                        </span>
                        <span className="text-[13px] text-(--muted)">
                          {t
                            ? `${accountLabel(ledger, t.accountId)} · ${t.date}`
                            : ''}
                        </span>
                      </div>
                      <p className="mt-1.5 text-[14px] text-(--ink2)">
                        {d.reason}.
                      </p>
                      <Choice
                        value={choice}
                        options={[
                          { key: 'skip', label: 'Skip the new one' },
                          { key: 'keep', label: 'Keep both' },
                        ]}
                        onChange={(v) => setDupes((s) => ({ ...s, [d.id]: v }))}
                      />
                    </Card>
                  );
                })}
              </Detail>
            ) : null}
            {gaps.length ? (
              <Detail
                title="Missing period"
                summary={
                  gaps.every((g) => gapAck[g.id]) ? 'noted' : 'needs a look'
                }
                open={openKind === 'missing-period'}
                onToggle={() =>
                  setOpenKind(
                    openKind === 'missing-period' ? null : 'missing-period',
                  )
                }
              >
                {gaps.map((g) => (
                  <Card key={g.id}>
                    <p className="text-[15px] leading-relaxed text-(--ink)">
                      The {accountLabel(ledger, g.accountId)} statement says{' '}
                      <b className="num">
                        {cadCents.format(g.expectedBalance)}
                      </b>{' '}
                      on {longDate(g.to)}; the ledger adds up to{' '}
                      <b className="num">{cadCents.format(g.actualBalance)}</b>.{' '}
                      {cadCents.format(g.expectedBalance - g.actualBalance)} is
                      unaccounted for between {longDate(g.from)} and{' '}
                      {longDate(g.to)}, most likely an export that never came
                      in.
                    </p>
                    <Choice
                      value={gapAck[g.id] ? 'ack' : 'open'}
                      options={[
                        { key: 'open', label: 'I’ll find the file' },
                        { key: 'ack', label: 'Mark as a known gap' },
                      ]}
                      onChange={(v) =>
                        setGapAck((s) => ({ ...s, [g.id]: v === 'ack' }))
                      }
                    />
                  </Card>
                ))}
              </Detail>
            ) : null}
            {transfers.length ? (
              <Detail
                title="Transfer pairs"
                summary={`${transfers.filter((x) => (pairs[x.id] ?? 'link') === 'link').length} linked`}
                open={openKind === 'transfer'}
                onToggle={() =>
                  setOpenKind(openKind === 'transfer' ? null : 'transfer')
                }
              >
                {transfers.map((x) => {
                  const out = txn.get(x.outId);
                  const inn = txn.get(x.inId);
                  return (
                    <Card key={x.id}>
                      <p className="text-[15px] text-(--ink)">
                        {out ? accountLabel(ledger, out.accountId) : '?'}{' '}
                        <span className="text-(--muted)">→</span>{' '}
                        {inn ? accountLabel(ledger, inn.accountId) : '?'},{' '}
                        <span className="num">
                          {out ? cadCents.format(Math.abs(out.amount)) : ''}
                        </span>
                      </p>
                      <p className="mt-1.5 text-[14px] text-(--ink2)">
                        Same amount, {plural(x.daysApart, 'day')} apart. Linked,
                        it is counted once and stays out of spending.
                      </p>
                      <Choice
                        value={pairs[x.id] ?? 'link'}
                        options={[
                          { key: 'link', label: 'Link as one transfer' },
                          { key: 'separate', label: 'Keep separate' },
                        ]}
                        onChange={(v) => setPairs((s) => ({ ...s, [x.id]: v }))}
                      />
                    </Card>
                  );
                })}
              </Detail>
            ) : null}
            {unknown.length ? (
              <Detail
                title="Merchants the rules did not know"
                summary={`${unknown.filter((u) => picked[u.id]).length} of ${unknown.length} settled`}
                open={openKind === 'low-confidence'}
                onToggle={() =>
                  setOpenKind(
                    openKind === 'low-confidence' ? null : 'low-confidence',
                  )
                }
              >
                {unknown.map((u) => {
                  const t = txn.get(u.transactionId);
                  const sug = cats.get(u.suggestedCategoryId)?.name;
                  const chosen = picked[u.id];
                  return (
                    <Card key={u.id}>
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <code className="font-mono text-[13px] text-(--ink)">
                          {t?.descriptor}
                        </code>
                        <span className="num text-[14px] text-(--ink2)">
                          {t ? cadCents.format(Math.abs(t.amount)) : ''}
                        </span>
                      </div>
                      <p className="mt-1.5 text-[14px] text-(--ink2)">
                        {chosen
                          ? `Filed under ${cats.get(chosen)?.name}. This one stays home.`
                          : `Best guess: ${sug}, ${Math.round(u.confidence * 100)}% sure. Left alone, the descriptor goes to the model.`}
                      </p>
                      <div className="mt-4 flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() =>
                            setPicked((s) => ({
                              ...s,
                              [u.id]: u.suggestedCategoryId,
                            }))
                          }
                          className={`rounded-full px-3.5 py-1.5 text-[13px] transition ${
                            chosen === u.suggestedCategoryId
                              ? 'bg-(--ink) text-(--page)'
                              : 'ring-1 ring-(--hair) hover:ring-(--axis)'
                          }`}
                        >
                          {chosen === u.suggestedCategoryId
                            ? `✓ ${sug}`
                            : `Accept ${sug}`}
                        </button>
                        <label className="relative">
                          <span className="sr-only">
                            Choose another category
                          </span>
                          <select
                            value={
                              chosen && chosen !== u.suggestedCategoryId
                                ? chosen
                                : ''
                            }
                            onChange={(e) =>
                              setPicked((s) => ({
                                ...s,
                                [u.id]: e.target.value,
                              }))
                            }
                            className="appearance-none rounded-full bg-transparent py-1.5 pr-8 pl-3.5 text-[13px] text-(--ink2) ring-1 ring-(--hair) outline-none hover:ring-(--axis)"
                          >
                            <option value="">Something else…</option>
                            {ledger.categories
                              .filter((c) => c.parentId && c.flow === 'expense')
                              .map((c) => (
                                <option key={c.id} value={c.id}>
                                  {c.name}
                                </option>
                              ))}
                          </select>
                          <ChevronDown className="pointer-events-none absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 text-(--muted)" />
                        </label>
                      </div>
                    </Card>
                  );
                })}
              </Detail>
            ) : null}
          </div>
          <Nav
            back={() => setStep('files')}
            next={() => setStep('confirm')}
            nextLabel="Review what leaves"
          />
        </div>
      ) : null}

      {step === 'confirm' ? (
        <div className="vb-in mt-10">
          <h2 className="serif text-[30px] leading-tight text-(--ink) sm:text-[36px]">
            {sending.length
              ? `${plural(sending.length, 'string')} would leave the lab.`
              : 'Nothing leaves the lab.'}
          </h2>
          <p className="mt-4 max-w-2xl text-[16px] leading-relaxed text-(--ink2)">
            {sending.length
              ? 'These go to the categorisation model, exactly as written below. No amounts, dates, account numbers or names travel with them.'
              : 'Every row matched a rule or you settled it. The model is not called.'}
          </p>
          {outbound.length ? (
            <ul className="mt-8 divide-y divide-(--hair) overflow-hidden rounded-3xl ring-1 ring-(--hair)">
              {outbound.map((s) => {
                const held = local.has(s);
                return (
                  <li
                    key={s}
                    className={`flex items-center gap-4 px-5 py-4 transition ${held ? 'bg-(--sunk)' : 'bg-(--raise)'}`}
                  >
                    {held ? (
                      <Lock className="size-4 text-(--muted)" aria-hidden />
                    ) : (
                      <Send className="size-4 text-(--ink2)" aria-hidden />
                    )}
                    <code
                      className={`flex-1 font-mono text-[14px] ${held ? 'text-(--muted) line-through' : 'text-(--ink)'}`}
                    >
                      {s}
                    </code>
                    <button
                      type="button"
                      onClick={() =>
                        setLocal((cur) => {
                          const next = new Set(cur);
                          if (next.has(s)) next.delete(s);
                          else next.add(s);
                          return next;
                        })
                      }
                      className="rounded-full px-3 py-1 text-[13px] text-(--ink2) ring-1 ring-(--hair) hover:text-(--ink) hover:ring-(--axis)"
                    >
                      {held ? 'Send it' : 'Keep local'}
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}
          {keptLocal.length ? (
            <p className="mt-3 text-[13px] text-(--muted)">
              {plural(keptLocal.length, 'descriptor')} kept local will import as
              Uncategorized.
            </p>
          ) : null}

          <ul className="mt-10 space-y-2 text-[15px] text-(--ink2)">
            <Summary>
              {skipped
                ? `${plural(skipped, 'duplicate')} skipped`
                : 'Duplicates kept'}
              ,{' '}
              {plural(
                transfers.filter((x) => (pairs[x.id] ?? 'link') === 'link')
                  .length,
                'transfer pair',
              )}{' '}
              linked.
            </Summary>
            <Summary>
              {gaps.map((g) =>
                gapAck[g.id]
                  ? `The ${accountLabel(ledger, g.accountId)} gap is marked as known. `
                  : `The ${accountLabel(ledger, g.accountId)} gap stays open as a finding. `,
              )}
            </Summary>
            <Summary>
              {plural(unknown.filter((u) => picked[u.id]).length, 'merchant')}{' '}
              you filed by hand.
            </Summary>
          </ul>

          <div className="mt-12 flex flex-wrap items-center justify-between gap-4 border-t border-(--hair) pt-8">
            <button
              type="button"
              onClick={() => setStep('findings')}
              className="inline-flex items-center gap-2 text-[14px] text-(--ink2) hover:text-(--ink)"
            >
              <ArrowLeft className="size-4" /> Back to findings
            </button>
            <button
              type="button"
              onClick={() => setStep('done')}
              className="rounded-full bg-(--ink) px-7 py-3.5 text-[16px] font-medium text-(--page) shadow-[0_8px_24px_-10px_rgba(0,0,0,0.45)] transition hover:opacity-90"
            >
              Import {rows} rows
            </button>
          </div>
        </div>
      ) : null}

      {step === 'done' ? (
        <div className="vb-in mt-14 text-center">
          <span className="mx-auto inline-flex size-16 items-center justify-center rounded-full bg-(--sunk) ring-1 ring-(--hair)">
            <Check className="size-7 text-(--good)" />
          </span>
          <h2 className="serif mt-8 text-[40px] leading-tight text-(--ink)">
            {rows} rows are in the ledger.
          </h2>
          <p className="mx-auto mt-4 max-w-lg text-[16px] leading-relaxed text-(--ink2)">
            {sending.length
              ? `${plural(sending.length, 'descriptor')} went to the model and came back with categories.`
              : 'The model was never called.'}{' '}
            The batch can be undone in one step from its import record.
          </p>
          <div className="mt-10 flex justify-center gap-3">
            <button
              type="button"
              onClick={reset}
              className="rounded-full px-5 py-2.5 text-[14px] text-(--ink) ring-1 ring-(--hair) hover:bg-(--wash)"
            >
              Import more
            </button>
            <button
              type="button"
              onClick={onSeeTransactions}
              className="rounded-full bg-(--ink) px-5 py-2.5 text-[14px] text-(--page) hover:opacity-90"
            >
              See transactions
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function FileCard({
  file,
  ledger,
  value,
  onAssign,
}: {
  file: PreviewFile;
  ledger: Ledger;
  value: string;
  onAssign: (v: string) => void;
}) {
  const Icon =
    file.format === 'pdf'
      ? file.scanned
        ? FileScan
        : FileText
      : FileSpreadsheet;
  const needs = !value;
  const choices = ledger.accounts.filter(
    (a) => a.institution === file.institution || needs,
  );
  return (
    <article
      className={`rounded-3xl bg-(--raise) p-6 ring-1 transition ${
        needs ? 'ring-2 ring-(--s4)' : 'ring-(--hair)'
      }`}
    >
      <div className="flex items-start gap-4">
        <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-2xl bg-(--sunk) text-(--ink2)">
          <Icon className="size-5" strokeWidth={1.5} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-[13px] text-(--ink)">
            {file.name}
          </div>
          <div className="mt-1 text-[13px] text-(--muted)">
            {file.format.toUpperCase()} · {file.institution} ·{' '}
            {plural(file.rows, 'row')}
          </div>
        </div>
      </div>
      <div className="mt-5 text-[14px] text-(--ink2)">
        {longDate(file.from)} to {longDate(file.to)}
      </div>
      {file.format === 'pdf' ? (
        <div className="mt-1 text-[13px] text-(--muted)">
          {plural(file.pages ?? 0, 'page')}
          {file.scanned ? ', scanned. Text is read on this machine.' : '.'}
        </div>
      ) : null}
      <label className="mt-5 block">
        <span
          className={`text-[12px] ${needs ? 'font-medium text-(--ink)' : 'text-(--muted)'}`}
        >
          {needs ? `Which ${file.institution} account is this?` : 'Account'}
        </span>
        <span className="relative mt-1.5 block">
          <select
            value={value}
            onChange={(e) => onAssign(e.target.value)}
            className="w-full appearance-none rounded-xl bg-(--sunk) py-2.5 pr-9 pl-3.5 text-[14px] text-(--ink) ring-1 ring-(--hair) outline-none hover:ring-(--axis)"
          >
            <option value="">Choose an account…</option>
            {choices.map((a) => (
              <option key={a.id} value={a.id}>
                {a.institution} {a.name}
              </option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-(--muted)" />
        </span>
      </label>
    </article>
  );
}

function Detail({
  title,
  summary,
  open,
  onToggle,
  children,
}: {
  title: string;
  summary: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <section>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-4 py-5 text-left"
      >
        <span className="serif flex-1 text-[21px] text-(--ink)">{title}</span>
        <span className="text-[13px] text-(--muted)">{summary}</span>
        <ChevronDown
          className={`size-4 text-(--muted) transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open ? <div className="vb-in space-y-3 pb-6">{children}</div> : null}
    </section>
  );
}

function Card({ children }: { children: ReactNode }) {
  return <div className="rounded-2xl bg-(--sunk) p-5">{children}</div>;
}

function Choice<K extends string>({
  value,
  options,
  onChange,
}: {
  value: K;
  options: { key: K; label: string }[];
  onChange: (k: K) => void;
}) {
  return (
    <div className="mt-4 flex flex-wrap gap-2">
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          aria-pressed={value === o.key}
          onClick={() => onChange(o.key)}
          className={`rounded-full px-3.5 py-1.5 text-[13px] transition ${
            value === o.key
              ? 'bg-(--ink) text-(--page)'
              : 'text-(--ink) ring-1 ring-(--hair) hover:ring-(--axis)'
          }`}
        >
          {value === o.key ? '✓ ' : ''}
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Nav({
  back,
  next,
  nextLabel,
  disabled,
  hint,
}: {
  back: () => void;
  next: () => void;
  nextLabel: string;
  disabled?: boolean;
  hint?: string;
}) {
  return (
    <div className="mt-12 flex flex-wrap items-center justify-between gap-4 border-t border-(--hair) pt-8">
      <button
        type="button"
        onClick={back}
        className="inline-flex items-center gap-2 text-[14px] text-(--ink2) hover:text-(--ink)"
      >
        <ArrowLeft className="size-4" /> Back
      </button>
      <div className="flex items-center gap-4">
        {hint ? (
          <span className="text-[13px] text-(--muted)">{hint}</span>
        ) : null}
        <button
          type="button"
          disabled={disabled}
          onClick={next}
          className="inline-flex items-center gap-2 rounded-full bg-(--ink) px-6 py-3 text-[15px] font-medium text-(--page) transition enabled:hover:opacity-90 disabled:opacity-30"
        >
          {nextLabel} <ArrowRight className="size-4" />
        </button>
      </div>
    </div>
  );
}

function Summary({ children }: { children: ReactNode }) {
  return (
    <li className="flex items-start gap-3">
      <Check className="mt-1 size-4 shrink-0 text-(--muted)" aria-hidden />
      <span>{children}</span>
    </li>
  );
}
