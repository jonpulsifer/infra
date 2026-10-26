import {
  ArrowRight,
  Check,
  CircleCheck,
  FileSpreadsheet,
  FileText,
  Loader2,
  ScanText,
  ShieldCheck,
  Undo2,
  Upload,
  X,
} from 'lucide-react';
import {
  type PointerEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { Finding, PreviewFile } from '~/fixtures/types';
import {
  Answer,
  Aside,
  AsideSection,
  Card,
  PrimaryButton,
  QuietButton,
  Sheet,
} from '../bits';
import { actionsFor, FindingBody } from '../findings';
import { accountName, categoryName, dayLabel, findingTitle } from '../model';
import { type ImportStep, useTally } from '../store';

export function ImportScreen() {
  const { base, eff, imported, go } = useTally();
  const p = base.preview;
  return (
    <div className="qc-in">
      <Answer
        question="What's new to import?"
        line={
          imported
            ? "You're up to date"
            : `${p.files.length} statements are ready to read`
        }
        sub={
          imported
            ? `The last import brought in ${imported.rows} rows on ${dayLabel(imported.importedAt)}.`
            : 'October exports from RBC, Amex and TD, and an old scanned Questrade statement.'
        }
      />
      <div className="px-4">
        <button
          type="button"
          onClick={() => go({ importStep: 'pick' })}
          className="group flex w-full flex-col items-center rounded-3xl border-2 border-dashed border-amber-400/70 bg-amber-50/60 px-6 py-9 text-center transition hover:border-amber-500 hover:bg-amber-50 dark:border-amber-400/40 dark:bg-amber-400/5 dark:hover:bg-amber-400/10"
        >
          <span className="grid size-14 place-items-center rounded-2xl bg-amber-500 text-stone-950 shadow-sm transition group-hover:-translate-y-0.5">
            <Upload className="size-6" aria-hidden />
          </span>
          <span className="mt-4 text-lg font-semibold">Pick statements</span>
          <span className="mt-1 text-sm text-stone-600 dark:text-stone-400">
            CSV, QFX, OFX or PDF. Nothing is saved until you say so.
          </span>
        </button>

        <ol className="mt-5 grid grid-cols-3 gap-2 text-center text-xs text-stone-600 dark:text-stone-400">
          {['Read the files', 'Check each finding', 'Import'].map((s, i) => (
            <li
              key={s}
              className="rounded-2xl bg-white px-2 py-3 ring-1 ring-stone-200/80 dark:bg-stone-900 dark:ring-stone-800"
            >
              <span className="mx-auto mb-1.5 grid size-6 place-items-center rounded-full bg-stone-200 text-[11px] font-bold text-stone-700 dark:bg-stone-800 dark:text-stone-300">
                {i + 1}
              </span>
              {s}
            </li>
          ))}
        </ol>

        <h2 className="mt-8 mb-2 text-xs font-semibold tracking-wide text-stone-500 uppercase">
          Past imports
        </h2>
        <ul className="divide-y divide-stone-200 rounded-2xl bg-white ring-1 ring-stone-200/80 dark:divide-stone-800 dark:bg-stone-900 dark:ring-stone-800">
          {eff.batches.map((b) => (
            <li
              key={b.id}
              className={`flex items-center gap-3 px-4 py-3 ${imported?.id === b.id ? 'qc-flash' : ''}`}
            >
              <span className="grid size-9 place-items-center rounded-xl bg-stone-100 text-stone-500 dark:bg-stone-800">
                <FileText className="size-4" aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{b.note}</div>
                <div className="text-xs text-stone-500">
                  {dayLabel(b.importedAt, true)} · {b.files} files
                </div>
              </div>
              <span className="text-sm tabular-nums">
                {b.rows.toLocaleString('en-CA')} rows
              </span>
            </li>
          ))}
        </ul>
      </div>
      <Aside>
        <AsideSection title="What leaves the lab">
          <p className="text-sm text-stone-600 dark:text-stone-400">
            Rules run first, on this machine. Only the bank text of rows no rule
            can place goes to the model: no amounts, dates or account numbers.
            You see every string before you import.
          </p>
          <p className="mt-3 text-sm">
            This batch: <strong>{p.outboundStrings.length}</strong> strings,{' '}
            <strong>{p.rulesHit}</strong> rows placed by rules.
          </p>
        </AsideSection>
      </Aside>
    </div>
  );
}

const FORMAT_ICON = {
  csv: FileSpreadsheet,
  qfx: FileText,
  ofx: FileText,
  pdf: ScanText,
};

export function ImportFlow() {
  const { nav, go } = useTally();
  const step = nav.importStep;
  const close = () =>
    go({ importStep: null, tab: nav.tab, question: nav.question });
  const setStep = (s: ImportStep) =>
    go({ importStep: s, tab: nav.tab, question: nav.question });
  const titles: Record<string, string> = {
    pick: 'Pick statements',
    parse: 'Reading',
    review: 'Check what we found',
    summary: 'Ready to import',
  };
  return (
    <Sheet
      open={!!step}
      onClose={close}
      title={step ? titles[step] : ''}
      tall={step === 'review'}
    >
      {step === 'pick' ? <Pick onNext={() => setStep('parse')} /> : null}
      {step === 'parse' ? <Parse onNext={(s) => setStep(s)} /> : null}
      {step === 'review' ? <Deck onDone={() => setStep('summary')} /> : null}
      {step === 'summary' ? <Summary onDone={close} /> : null}
    </Sheet>
  );
}

function FileRow({ f, right }: { f: PreviewFile; right?: ReactNode }) {
  const Icon = FORMAT_ICON[f.format];
  return (
    <div className="flex items-center gap-3">
      <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-stone-100 text-stone-600 dark:bg-stone-800 dark:text-stone-300">
        <Icon className="size-4.5" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-[13px]">{f.name}</div>
        <div className="text-xs text-stone-500">
          {f.institution} · {f.rows} rows · {dayLabel(f.from)} to{' '}
          {dayLabel(f.to, true)}
        </div>
      </div>
      {right}
    </div>
  );
}

function Pick({ onNext }: { onNext: () => void }) {
  const { base } = useTally();
  const files = base.preview.files;
  const [picked, setPicked] = useState(() => files.map((f) => f.name));
  const [match, setMatch] = useState<Record<string, string>>({});
  const unmatched = files.filter(
    (f) => picked.includes(f.name) && !f.accountId && !match[f.name],
  );
  const cards = base.accounts.filter((a) => a.kind === 'credit');
  return (
    <div className="space-y-3 pb-2">
      <p className="text-sm text-stone-600 dark:text-stone-400">
        Four files from your Downloads folder. Untick any you want to leave out.
      </p>
      <ul className="space-y-2">
        {files.map((f) => {
          const on = picked.includes(f.name);
          return (
            <li
              key={f.name}
              className={`rounded-2xl p-3 ring-1 transition ${on ? 'bg-white ring-amber-300 dark:bg-stone-950/60 dark:ring-amber-500/40' : 'ring-stone-200 dark:ring-stone-800'}`}
            >
              <FileRow
                f={f}
                right={
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={on}
                    aria-label={`Include ${f.name}`}
                    onClick={() =>
                      setPicked((p) =>
                        on ? p.filter((x) => x !== f.name) : [...p, f.name],
                      )
                    }
                    className={`grid size-11 shrink-0 place-items-center rounded-xl ${on ? 'text-amber-600 dark:text-amber-300' : 'text-stone-300 dark:text-stone-600'}`}
                  >
                    <span
                      className={`grid size-6 place-items-center rounded-md ${on ? 'bg-amber-500 text-stone-950' : 'ring-2 ring-current'}`}
                    >
                      {on ? (
                        <Check className="size-4" strokeWidth={3} aria-hidden />
                      ) : null}
                    </span>
                  </button>
                }
              />
              {on && !f.accountId ? (
                <label className="mt-2.5 flex items-center gap-2 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-400/10 dark:text-amber-100">
                  <span className="flex-1">Which account is this?</span>
                  <select
                    value={match[f.name] ?? ''}
                    onChange={(e) =>
                      setMatch((m) => ({ ...m, [f.name]: e.target.value }))
                    }
                    className="h-10 rounded-lg bg-white px-2 text-sm text-stone-900 ring-1 ring-amber-300 dark:bg-stone-900 dark:text-stone-100 dark:ring-amber-500/40"
                  >
                    <option value="">Choose…</option>
                    {cards.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.institution} {a.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : f.accountId && on ? (
                <p className="mt-2 pl-[3.25rem] text-xs text-stone-500">
                  Into {accountName(base, f.accountId)}
                  {f.scanned ? ` · scanned, ${f.pages} pages to read` : ''}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
      <PrimaryButton
        className="w-full"
        disabled={!picked.length || unmatched.length > 0}
        onClick={onNext}
      >
        {unmatched.length
          ? 'Match the TD file first'
          : `Read ${picked.length} file${picked.length === 1 ? '' : 's'}`}
        <ArrowRight className="size-4" aria-hidden />
      </PrimaryButton>
    </div>
  );
}

function Parse({ onNext }: { onNext: (s: ImportStep) => void }) {
  const { base, outcomes } = useTally();
  const files = base.preview.files;
  const [prog, setProg] = useState(() => files.map(() => 0));
  useEffect(() => {
    const id = window.setInterval(() => {
      setProg((p) =>
        p.map((v, i) => {
          const f = files[i];
          const rate = f.format === 'pdf' ? 0.045 : 0.09 + (i % 2) * 0.05;
          return Math.min(1, v + rate);
        }),
      );
    }, 90);
    return () => window.clearInterval(id);
  }, [files]);
  const done = prog.every((v) => v >= 1);
  const open = base.preview.findings.filter((f) => !outcomes[f.id]).length;
  return (
    <div className="space-y-3 pb-2">
      <ul className="space-y-2">
        {files.map((f, i) => {
          const v = prog[i];
          const page = Math.max(1, Math.ceil(v * (f.pages ?? 1)));
          return (
            <li
              key={f.name}
              className="rounded-2xl bg-white p-3 ring-1 ring-stone-200 dark:bg-stone-950/60 dark:ring-stone-800"
            >
              <FileRow
                f={f}
                right={
                  v >= 1 ? (
                    <CircleCheck
                      className="size-5 text-[#0ca30c]"
                      aria-label="Read"
                    />
                  ) : (
                    <Loader2
                      className="size-5 animate-spin text-amber-600"
                      aria-label="Reading"
                    />
                  )
                }
              />
              <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-stone-100 dark:bg-stone-800">
                <div
                  className="h-full rounded-full bg-amber-500 transition-[width] duration-100"
                  style={{ width: `${v * 100}%` }}
                />
              </div>
              <div className="mt-1 text-xs text-stone-500">
                {v >= 1
                  ? `${f.rows} rows`
                  : f.scanned
                    ? `Reading page ${page} of ${f.pages}`
                    : 'Parsing'}
              </div>
            </li>
          );
        })}
      </ul>
      {done ? (
        <div className="qc-in space-y-3">
          <p className="text-[0.95rem]">
            <strong>{base.preview.newTransactions.length} new rows.</strong>{' '}
            {base.preview.rulesHit} placed by your rules.{' '}
            {open
              ? `${open} need a look before they go in.`
              : 'Nothing needs a look.'}
          </p>
          <PrimaryButton
            className="w-full"
            onClick={() => onNext(open ? 'review' : 'summary')}
          >
            {open ? `Review ${open} findings` : 'See the summary'}
            <ArrowRight className="size-4" aria-hidden />
          </PrimaryButton>
        </div>
      ) : null}
    </div>
  );
}

const THRESHOLD = 96;

function Deck({ onDone }: { onDone: () => void }) {
  const { base, outcomes, resolve, unresolve } = useTally();
  const all = base.preview.findings;
  const [queue] = useState(() => all.filter((f) => !outcomes[f.id]));
  const [pos, setPos] = useState(0);
  const [dx, setDx] = useState(0);
  const [leaving, setLeaving] = useState<0 | 1 | -1>(0);
  const start = useRef<number | null>(null);
  const cat = (id: string) => categoryName(base, id);
  const f: Finding | undefined = queue[pos];
  const next = queue[pos + 1];

  const decide = (dir: 1 | -1) => {
    if (!f || leaving) return;
    const { primary, secondary } = actionsFor(f, cat);
    setLeaving(dir);
    window.setTimeout(() => {
      resolve(f, dir === 1 ? primary.outcome : secondary.outcome);
      setLeaving(0);
      setDx(0);
      setPos((p) => p + 1);
    }, 220);
  };
  const undo = () => {
    const prev = queue[pos - 1];
    if (!prev) return;
    unresolve(prev);
    setPos((p) => p - 1);
  };
  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button')) return;
    start.current = e.clientX;
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (start.current !== null) setDx(e.clientX - start.current);
  };
  const onUp = () => {
    if (start.current === null) return;
    start.current = null;
    if (dx > THRESHOLD) decide(1);
    else if (dx < -THRESHOLD) decide(-1);
    else setDx(0);
  };

  if (!f) {
    return (
      <div className="qc-in flex h-full flex-col items-center justify-center pb-10 text-center">
        <CircleCheck className="size-12 text-[#0ca30c]" aria-hidden />
        <p className="mt-3 text-lg font-semibold">That's every finding</p>
        <p className="mt-1 text-sm text-stone-500">
          {queue.length} checked. One last look before anything is saved.
        </p>
        <PrimaryButton className="mt-6 w-full" onClick={onDone}>
          See the summary
          <ArrowRight className="size-4" aria-hidden />
        </PrimaryButton>
        {pos > 0 ? (
          <QuietButton className="mt-2 w-full" onClick={undo}>
            <Undo2 className="size-4" aria-hidden />
            Undo the last one
          </QuietButton>
        ) : null}
      </div>
    );
  }

  const { primary, secondary } = actionsFor(f, cat);
  const offset = leaving ? leaving * 520 : dx;
  const hint = dx > 24 ? primary.label : dx < -24 ? secondary.label : null;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3">
        <div className="flex h-1.5 flex-1 overflow-hidden rounded-full bg-stone-200 dark:bg-stone-800">
          <div
            className="h-full rounded-full bg-amber-500 transition-[width] duration-300"
            style={{ width: `${(pos / queue.length) * 100}%` }}
          />
        </div>
        <span className="text-xs text-stone-500 tabular-nums">
          {pos + 1} of {queue.length}
        </span>
      </div>

      <div className="relative mt-4 min-h-0 flex-1">
        {next ? (
          <div className="absolute inset-x-3 top-3 bottom-0 rounded-3xl bg-white/70 ring-1 ring-stone-200 dark:bg-stone-800/50 dark:ring-stone-800" />
        ) : null}
        <div
          role="group"
          aria-label={`${findingTitle(f)}. Swipe right to ${primary.label}, left to ${secondary.label}.`}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          className="absolute inset-x-0 top-0 bottom-3 cursor-grab overflow-y-auto rounded-3xl bg-white p-5 shadow-lg ring-1 ring-stone-200 active:cursor-grabbing dark:bg-stone-950 dark:ring-stone-700"
          style={{
            transform: `translateX(${offset}px) rotate(${offset / 24}deg)`,
            transition:
              start.current !== null
                ? 'none'
                : 'transform 220ms cubic-bezier(.2,.8,.2,1)',
            touchAction: 'pan-y',
            opacity: leaving ? 0 : 1,
          }}
        >
          <div className="mb-3 flex items-center justify-between">
            <span className="rounded-full bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-800 dark:bg-amber-400/10 dark:text-amber-200">
              {findingTitle(f)}
            </span>
            {hint ? (
              <span
                className={`rounded-full px-2.5 py-1 text-xs font-bold ${dx > 0 ? 'bg-amber-500 text-stone-950' : 'bg-stone-200 text-stone-700 dark:bg-stone-800 dark:text-stone-200'}`}
              >
                {hint}
              </span>
            ) : null}
          </div>
          <FindingBody f={f} />
        </div>
      </div>

      <div className="mt-4 flex gap-2">
        <QuietButton className="flex-1" onClick={() => decide(-1)}>
          <X className="size-4" aria-hidden />
          {secondary.label}
        </QuietButton>
        <PrimaryButton className="flex-[1.4]" onClick={() => decide(1)}>
          <Check className="size-4" aria-hidden />
          {primary.label}
        </PrimaryButton>
      </div>
      <div className="mt-2 flex items-center justify-between pb-1 text-xs text-stone-500">
        <span>Swipe the card, or tap</span>
        {pos > 0 ? (
          <button
            type="button"
            onClick={undo}
            className="inline-flex h-9 items-center gap-1 rounded-full px-2 font-medium hover:bg-stone-200/60 dark:hover:bg-stone-800"
          >
            <Undo2 className="size-3.5" aria-hidden />
            Undo
          </button>
        ) : null}
      </div>
    </div>
  );
}

function Summary({ onDone }: { onDone: () => void }) {
  const { base, outcomes, withheld, toggleWithheld, doImport } = useTally();
  const p = base.preview;
  const handled = p.findings.filter((f) => outcomes[f.id]).length;
  const merged = p.findings.filter(
    (f) => f.kind === 'duplicate' && outcomes[f.id] === 'merged',
  ).length;
  const rows = p.newTransactions.length - merged;
  const sent = p.outboundStrings.filter((s) => !withheld.includes(s));
  const stats = useMemo(
    () => [
      ['New rows', rows.toLocaleString('en-CA')],
      ['Placed by rules', String(p.rulesHit)],
      ['Findings handled', `${handled} of ${p.findings.length}`],
      ['Model calls', String(sent.length)],
    ],
    [rows, p, handled, sent.length],
  );
  return (
    <div className="space-y-5 pb-2">
      <div className="grid grid-cols-2 gap-2">
        {stats.map(([k, v]) => (
          <Card key={k} className="bg-white p-3.5 dark:bg-stone-950/60">
            <div className="text-xs text-stone-500">{k}</div>
            <div className="mt-0.5 text-xl font-semibold tracking-tight">
              {v}
            </div>
          </Card>
        ))}
      </div>
      <section>
        <div className="flex items-center gap-2">
          <ShieldCheck
            className="size-4.5 text-amber-600 dark:text-amber-300"
            aria-hidden
          />
          <h3 className="font-semibold">These strings leave the lab</h3>
        </div>
        <p className="mt-1 text-sm text-stone-600 dark:text-stone-400">
          Only this bank text goes to the model, to guess a category. No
          amounts, dates or account numbers. Tap one to hold it back; its row
          stays uncategorised.
        </p>
        <ul className="mt-3 flex flex-wrap gap-1.5">
          {p.outboundStrings.map((s) => {
            const held = withheld.includes(s);
            return (
              <li key={s}>
                <button
                  type="button"
                  aria-pressed={!held}
                  onClick={() => toggleWithheld(s)}
                  className={`min-h-10 rounded-xl px-3 font-mono text-[13px] transition ${
                    held
                      ? 'text-stone-400 line-through ring-1 ring-stone-200 dark:text-stone-600 dark:ring-stone-800'
                      : 'bg-white text-stone-900 ring-1 ring-amber-300 dark:bg-stone-950/60 dark:text-stone-100 dark:ring-amber-500/40'
                  }`}
                >
                  {s}
                </button>
              </li>
            );
          })}
        </ul>
        {withheld.length ? (
          <p className="mt-2 text-xs text-stone-500">
            {withheld.length} held back.
          </p>
        ) : null}
      </section>
      <PrimaryButton
        className="w-full"
        onClick={() => {
          doImport(rows, p.files.length);
          onDone();
        }}
      >
        Import {rows} rows
      </PrimaryButton>
    </div>
  );
}
