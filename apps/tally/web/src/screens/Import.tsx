import {
  ArrowRight,
  Check,
  CircleDashed,
  FileText,
  ScanLine,
  ShieldCheck,
  TriangleAlert,
  Upload,
  X,
} from 'lucide-react';
import {
  type Dispatch,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Kbd } from '~/components/bits';
import { Split } from '~/components/Split';
import { Block, InspectorHead, KV, rowRule, serif } from '~/components/ui';
import type {
  Finding,
  ImportPreview,
  Ledger,
  PreviewFile,
  Transaction,
} from '~/fixtures/types';
import { longDate, mLong } from '~/lib/dates';
import { isTyping } from '~/lib/keys';
import {
  categoryOptions,
  ladder,
  patternFor,
  similarTo,
  topResolver,
} from '~/lib/ledger';
import { money, pct, signedMoney } from '~/lib/money';
import {
  type Action,
  type ImportState,
  previewCounts,
  type Resolution,
  type Review as ReviewState,
} from '~/lib/store';
import { cx, groupColor, type Palette, tw } from '~/lib/theme';

const GROUPS: { kind: Finding['kind']; label: string; note: string }[] = [
  {
    kind: 'duplicate',
    label: 'Duplicates',
    note: 'Rows that look like ones already in the ledger.',
  },
  {
    kind: 'missing-period',
    label: 'Missing periods',
    note: 'Statement balances the ledger cannot reach.',
  },
  {
    kind: 'transfer',
    label: 'Transfer pairs',
    note: 'Money moving between your own accounts.',
  },
  {
    kind: 'low-confidence',
    label: 'Merchants the rules did not know',
    note: 'Filed by the model, below 80% sure.',
  },
];

const ACTIONS: Record<Finding['kind'], [string, string, string]> = {
  duplicate: ['Possible duplicate', 'Skip incoming row', 'Keep both'],
  'missing-period': [
    'Missing period',
    'Book an adjustment',
    'I’ll upload the export',
  ],
  transfer: ['Transfer candidate', 'Pair as one transfer', 'Not a transfer'],
  'low-confidence': [
    'Low-confidence merchant',
    'Accept',
    'Leave uncategorised',
  ],
};

export function Import(props: {
  ledger: Ledger;
  pal: Palette;
  imp: ImportState;
  dispatch: Dispatch<Action>;
  upload: (files: File[]) => void;
  apply: () => void;
  readOnly: boolean;
  synthetic: boolean;
}) {
  const { imp } = props;
  if (imp.phase === 'review' || imp.phase === 'applying')
    return (
      <Review
        {...props}
        key={imp.preview.id}
        preview={imp.preview}
        review={imp.review}
        applying={imp.phase === 'applying'}
      />
    );
  return <Intake {...props} />;
}

function DropZone({
  upload,
  disabled,
  busy,
}: {
  upload: (files: File[]) => void;
  disabled?: string;
  busy?: string;
}) {
  const [drag, setDrag] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const take = (list: FileList | null) => {
    if (disabled || busy || !list?.length) return;
    upload(Array.from(list));
    if (input.current) input.current.value = '';
  };
  return (
    <label
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        take(e.dataTransfer.files);
      }}
      className={cx(
        'flex items-center gap-3 border border-dashed px-4 py-3 text-[12px] transition-colors focus-within:border-[#2a78d6] dark:focus-within:border-[#3987e5]',
        disabled || busy ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
        drag
          ? 'border-[#2a78d6] bg-[#eaf2fc] dark:border-[#3987e5] dark:bg-[#18263a]'
          : cx('border-[#cfcec7] dark:border-[#3a3a37]', !disabled && tw.hover),
        tw.ink3,
      )}
    >
      {busy ? (
        <CircleDashed size={15} className="animate-spin" />
      ) : (
        <Upload size={15} />
      )}
      <span className={tw.ink2}>
        {busy ?? disabled ?? 'Drop exports or statements here'}
      </span>
      <span className="ml-auto">CSV · QFX · OFX · PDF, many at once</span>
      <input
        ref={input}
        type="file"
        multiple
        accept=".csv,.qfx,.ofx,.pdf,text/csv,application/pdf"
        disabled={!!disabled || !!busy}
        className="sr-only"
        onChange={(e) => take(e.target.files)}
      />
    </label>
  );
}

/** No preview open: bring files in, or say what the last apply did. */
function Intake({
  imp,
  upload,
  readOnly,
  synthetic,
}: {
  imp: ImportState;
  upload: (files: File[]) => void;
  readOnly: boolean;
  synthetic: boolean;
}) {
  const [sheet, setSheet] = useState(false);
  const reader = (
    <div className="mx-auto max-w-[760px] px-5 pt-10 sm:px-10">
      <div className={cx(tw.label, tw.ink3)}>Bring in statements</div>
      <h1 className={cx(serif, 'mt-2 text-[34px] leading-tight', tw.ink)}>
        Import
      </h1>
      <p
        className={cx('mt-2 text-[15px] leading-relaxed text-pretty', tw.ink2)}
      >
        {imp.phase === 'applied'
          ? `${imp.rows} rows went into the ledger${imp.batchId ? ` as batch ${imp.batchId}` : ''}. Drop the next export to keep going.`
          : 'Drop bank exports and statements. tally reads them in the lab, checks them against the ledger and shows what it found before anything is written.'}
      </p>
      {imp.phase === 'applied' ? (
        <div
          className={cx(
            'mt-5 flex items-center gap-2 border-y py-2.5 text-[12px]',
            tw.rule,
            tw.good,
          )}
        >
          <Check size={13} /> Applied
        </div>
      ) : null}
      <section className="mt-10">
        <ReaderHead numeral="I." kicker="Files" title="What comes in" />
        <DropZone
          upload={upload}
          disabled={readOnly ? 'Viewers cannot import' : undefined}
          busy={
            imp.phase === 'uploading'
              ? `Reading ${imp.names.length} ${imp.names.length === 1 ? 'file' : 'files'}…`
              : undefined
          }
        />
        {synthetic ? (
          <p className={cx('mt-2 text-[11px]', tw.ink3)}>
            The synthetic ledger does not parse files; it lists them and serves
            its own sample rows.
          </p>
        ) : null}
      </section>
    </div>
  );
  const inspector = (
    <div className="rf-in">
      <InspectorHead
        kicker="Before anything is written"
        title="What an import does"
      />
      <Block title="In order">
        <ol
          className={cx('list-decimal space-y-1.5 pl-4 text-[12px]', tw.ink2)}
        >
          <li>Each file is parsed in the lab. PDFs are read locally.</li>
          <li>
            Rows are matched against the ledger: duplicates, transfers between
            your accounts and statement balances that do not reconcile.
          </li>
          <li>
            Rules file what they know. What they do not know is listed as the
            descriptors that would go to the model, and only those.
          </li>
          <li>You decide each finding, then apply.</li>
        </ol>
      </Block>
    </div>
  );
  return (
    <Split
      open={sheet}
      setOpen={setSheet}
      peek="What an import does"
      reader={reader}
      inspector={inspector}
    />
  );
}

function Review({
  ledger,
  pal,
  preview: p,
  review,
  applying,
  dispatch,
  apply,
  readOnly,
}: {
  ledger: Ledger;
  pal: Palette;
  preview: ImportPreview;
  review: ReviewState;
  applying: boolean;
  dispatch: Dispatch<Action>;
  apply: () => void;
  readOnly: boolean;
}) {
  const ordered = useMemo(
    () => GROUPS.flatMap((g) => p.findings.filter((f) => f.kind === g.kind)),
    [p.findings],
  );
  const [selId, setSelId] = useState(
    () =>
      ordered.find((f) => !review.resolutions[f.id])?.id ??
      ordered[0]?.id ??
      '',
  );
  const [sheet, setSheet] = useState(false);
  const txn = useMemo(
    () =>
      new Map(
        [...ledger.transactions, ...p.newTransactions].map((t) => [t.id, t]),
      ),
    [ledger.transactions, p.newTransactions],
  );
  const acct = useMemo(
    () => new Map(ledger.accounts.map((a) => [a.id, a])),
    [ledger.accounts],
  );
  const catName = useMemo(() => {
    const m = new Map(ledger.categories.map((c) => [c.id, c.name]));
    return (id: string) => m.get(id) ?? id;
  }, [ledger.categories]);
  const top = useMemo(
    () => topResolver(ledger.categories),
    [ledger.categories],
  );
  const acctName = (id: string) => {
    const a = acct.get(id);
    return a ? `${a.institution} ${a.name}` : id;
  };

  const status = (f: Finding): Resolution | 'open' =>
    review.resolutions[f.id] ?? 'open';
  const counts = previewCounts(p, review);
  const { open, skipped, unassigned } = counts;
  const sel = ordered.find((f) => f.id === selId) ?? null;
  const files = p.files;
  const sending = p.outboundStrings.filter((s) => !review.withheld.includes(s));
  const dated = p.files.filter((f) => f.from && f.to);
  const from = dated.map((f) => f.from).sort()[0] ?? '';
  const to =
    dated
      .map((f) => f.to)
      .sort()
      .slice(-1)[0] ?? '';

  const select = (id: string) => {
    setSelId(id);
    document
      .getElementById(`rf-finding-${id}`)
      ?.scrollIntoView({ block: 'nearest' });
  };

  const resolve = (f: Finding, r: Resolution | null) => {
    if (readOnly || applying) return;
    dispatch({ type: 'resolve', id: f.id, resolution: r });
    if (!r) return;
    const i = ordered.indexOf(f);
    const next =
      ordered.slice(i + 1).find((x) => status(x) === 'open' && x.id !== f.id) ??
      ordered.find((x) => status(x) === 'open' && x.id !== f.id);
    if (next) select(next.id);
  };

  const choose = (
    f: Extract<Finding, { kind: 'low-confidence' }>,
    change: { categoryId?: string; rule?: boolean },
  ) =>
    dispatch({
      type: 'choose',
      transactionId: f.transactionId,
      categoryId:
        change.categoryId ??
        review.categories[f.transactionId] ??
        f.suggestedCategoryId,
      rule: change.rule ?? review.makeRules.includes(f.transactionId),
    });

  const accept = () => {
    if (!sel) return;
    if (sel.kind === 'low-confidence') choose(sel, {});
    resolve(sel, 'accepted');
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isTyping(e) || e.metaKey || e.ctrlKey) return;
      const i = ordered.findIndex((f) => f.id === selId);
      if (e.key === 'j' || e.key === 'k') {
        e.preventDefault();
        const n = Math.max(
          0,
          Math.min(ordered.length - 1, i + (e.key === 'j' ? 1 : -1)),
        );
        if (ordered[n]) select(ordered[n].id);
      } else if (sel && e.key === 'a' && status(sel) === 'open') accept();
      else if (sel && e.key === 'x' && status(sel) === 'open')
        resolve(sel, 'dismissed');
      else if (sel && e.key === 'u') resolve(sel, null);
      else if (e.key === 'o')
        document
          .getElementById('rf-outbound')
          ?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      else if (e.key === 'Enter' && sel) setSheet(true);
      else if (e.key === 'Escape') setSheet(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const commit = (
    <span className="flex items-center gap-2">
      <button
        type="button"
        className={tw.btn}
        disabled={applying}
        onClick={() => dispatch({ type: 'discard' })}
      >
        Discard
      </button>
      <button
        type="button"
        className={tw.btnPrimary}
        disabled={unassigned.length > 0 || applying || readOnly}
        title={
          unassigned.length
            ? 'Assign every file to an account first'
            : undefined
        }
        onClick={apply}
      >
        {applying
          ? 'Applying…'
          : unassigned.length
            ? `${unassigned.length} ${unassigned.length === 1 ? 'file needs' : 'files need'} an account`
            : `Apply ${counts.rows} rows${open ? ` with ${open} open` : ''}`}
      </button>
    </span>
  );

  const reader = (
    <div className="mx-auto max-w-[760px] px-5 pt-10 sm:px-10">
      <div className={cx(tw.label, tw.ink3)}>Bring in statements</div>
      <h1 className={cx(serif, 'mt-2 text-[34px] leading-tight', tw.ink)}>
        Import
      </h1>
      <p
        className={cx('mt-2 text-[15px] leading-relaxed text-pretty', tw.ink2)}
      >
        {files.length} {files.length === 1 ? 'file carries' : 'files carry'}{' '}
        <span className={cx('font-mono', tw.ink)}>
          {p.newTransactions.length}
        </span>{' '}
        new rows{from ? ` from ${longDate(from)} to ${longDate(to)}` : ''}.{' '}
        <span className={cx('font-mono', tw.ink)}>{p.rulesHit}</span> were filed
        by a rule; {sending.length} descriptors would go to the model.{' '}
        {open
          ? `${open} of ${ordered.length} findings still want a decision.`
          : 'Every finding has a decision.'}
      </p>
      <div
        className={cx(
          'mt-5 flex flex-wrap items-center gap-3 border-y py-2.5 text-[12px]',
          tw.rule,
        )}
      >
        <span className={cx('font-mono', open ? tw.warn : tw.good)}>
          {open ? `${open} open` : 'all resolved'}
        </span>
        <span className={tw.ink3}>
          · {skipped} duplicate{skipped === 1 ? '' : 's'} skipped
        </span>
        <span className="ml-auto">{commit}</span>
      </div>

      <section className="mt-12">
        <ReaderHead numeral="I." kicker="Files" title="What came in" />
        <DropZone
          upload={() => {}}
          disabled="Apply or discard this import to bring in more"
        />
        <ul className="mt-2">
          {files.map((f) => (
            <FileRow
              key={f.name}
              f={f}
              assigned={review.fileAccounts[f.name]}
              accounts={ledger.accounts}
              acctName={acctName}
              assign={(accountId) =>
                dispatch({ type: 'assignFile', name: f.name, accountId })
              }
            />
          ))}
        </ul>
      </section>

      <section className="mt-12">
        <ReaderHead
          numeral="II."
          kicker="Findings"
          title="What needs a decision"
          right={
            <span className={cx('text-[11px]', tw.ink3)}>
              <Kbd>j</Kbd> <Kbd>k</Kbd> move · <Kbd>a</Kbd> accept ·{' '}
              <Kbd>x</Kbd> dismiss
            </span>
          }
        />
        {GROUPS.map((g) => {
          const items = ordered.filter((f) => f.kind === g.kind);
          if (!items.length) return null;
          const left = items.filter((f) => status(f) === 'open').length;
          return (
            <div key={g.kind} className="mb-6">
              <div className="flex items-baseline gap-3 pb-1.5">
                <h3 className={cx(serif, 'text-[19px]', tw.ink)}>{g.label}</h3>
                <span className={cx('text-[11px]', tw.ink3)}>{g.note}</span>
                <span
                  className={cx(
                    'ml-auto font-mono text-[11px]',
                    left ? tw.warn : tw.good,
                  )}
                >
                  {left ? `${left} open` : 'done'} / {items.length}
                </span>
              </div>
              {items.map((f) => (
                <FindingRow
                  key={f.id}
                  f={f}
                  status={status(f)}
                  selected={f.id === selId}
                  onSelect={() => {
                    setSelId(f.id);
                    setSheet(true);
                  }}
                  txn={txn}
                  acctName={(id) => acct.get(id)?.name ?? id}
                  catName={catName}
                />
              ))}
            </div>
          );
        })}
      </section>

      <section id="rf-outbound" className="mt-12 scroll-mt-6">
        <ReaderHead
          numeral="III."
          kicker="Privacy"
          title="What would leave the lab"
          right={<Kbd>o</Kbd>}
        />
        <p
          className={cx('mb-3 flex gap-2 text-[13px] leading-relaxed', tw.ink2)}
        >
          <ShieldCheck
            size={15}
            className={cx(
              'mt-0.5 shrink-0',
              sending.length ? tw.warn : tw.good,
            )}
          />
          These descriptors are the only thing sent to the model, verbatim, with
          long numbers replaced. No amounts, dates, accounts or names. Withhold
          one to refuse its answer: its row stays uncategorised and no rule is
          kept. Only a withhold made before the preview keeps a string here.
        </p>
        <ul className={cx('border-t', tw.rule)}>
          {p.outboundStrings.map((s) => {
            const held = review.withheld.includes(s);
            return (
              <li
                key={s}
                className={cx('flex h-8 items-center gap-3 border-b', rowRule)}
              >
                <span
                  className={cx(
                    'h-1.5 w-1.5 rounded-full',
                    held
                      ? 'bg-[#a8a69e] dark:bg-[#5f5e59]'
                      : 'bg-[#b77c00] dark:bg-[#fab219]',
                  )}
                />
                <code
                  className={cx(
                    'min-w-0 flex-1 truncate font-mono text-[12px]',
                    held ? cx('line-through', tw.ink3) : tw.ink,
                  )}
                >
                  {s}
                </code>
                <span className={cx('text-[11px]', tw.ink3)}>
                  {held ? 'stays here' : 'leaves'}
                </span>
                <button
                  type="button"
                  disabled={readOnly || applying}
                  onClick={() => dispatch({ type: 'withhold', value: s })}
                  className={cx(
                    'w-16 text-right text-[11px] hover:underline',
                    tw.accent,
                  )}
                >
                  {held ? 'Send' : 'Withhold'}
                </button>
              </li>
            );
          })}
        </ul>
        <p className={cx('mt-2 font-mono text-[11px]', tw.ink3)}>
          {sending.length} to send · {review.withheld.length} withheld
          {p.modelCalls ? ` · ${p.modelCalls} model calls` : ''}
        </p>
      </section>
    </div>
  );

  const inspector = sel ? (
    <Detail
      key={sel.id}
      f={sel}
      status={status(sel)}
      ledger={ledger}
      pal={pal}
      txn={txn}
      acctName={acctName}
      catName={catName}
      catColor={(id) => groupColor(pal, top(id).id)}
      withheld={review.withheld}
      lowChoice={
        sel.kind === 'low-confidence'
          ? review.categories[sel.transactionId]
          : undefined
      }
      setLowChoice={(c) =>
        sel.kind === 'low-confidence' && choose(sel, { categoryId: c })
      }
      lowRule={
        sel.kind === 'low-confidence' &&
        review.makeRules.includes(sel.transactionId)
      }
      setLowRule={(v) =>
        sel.kind === 'low-confidence' && choose(sel, { rule: v })
      }
      preview={p}
      readOnly={readOnly || applying}
      accept={accept}
      dismiss={() => resolve(sel, 'dismissed')}
      reopen={() => resolve(sel, null)}
      position={`${ordered.indexOf(sel) + 1} of ${ordered.length}`}
    />
  ) : (
    <div className={cx('p-6 text-[12px]', tw.ink3)}>Nothing to review.</div>
  );

  return (
    <Split
      open={sheet}
      setOpen={setSheet}
      peek={sel ? ACTIONS[sel.kind][0] : 'Nothing to review'}
      reader={reader}
      inspector={inspector}
    />
  );
}

function ReaderHead({
  numeral,
  kicker,
  title,
  right,
}: {
  numeral: string;
  kicker: string;
  title: string;
  right?: ReactNode;
}) {
  return (
    <div className="mb-4 flex items-end gap-3">
      <div>
        <div className="flex items-baseline gap-2">
          <span className={cx(serif, 'text-[14px]', tw.ink3)}>{numeral}</span>
          <span className={cx(tw.label, tw.ink3)}>{kicker}</span>
        </div>
        <h2 className={cx(serif, 'mt-1 text-[26px] leading-tight', tw.ink)}>
          {title}
        </h2>
      </div>
      {right ? <div className="ml-auto pb-1">{right}</div> : null}
    </div>
  );
}

function FileRow({
  f,
  assigned,
  accounts,
  acctName,
  assign,
}: {
  f: PreviewFile;
  assigned?: string;
  accounts: Ledger['accounts'];
  acctName: (id: string) => string;
  assign: (id: string) => void;
}) {
  const accountId = f.needsAccount ? assigned : (f.accountId ?? assigned);
  const queued = f.rows === 0;
  return (
    <li
      className={cx(
        'grid grid-cols-[18px_1fr_auto] items-center gap-x-2 border-b py-2 text-[12px]',
        rowRule,
      )}
    >
      {f.format === 'pdf' ? (
        <ScanLine size={13} className={tw.ink3} />
      ) : (
        <FileText size={13} className={tw.ink3} />
      )}
      <span className="min-w-0">
        <span className={cx('block truncate font-mono text-[11px]', tw.ink)}>
          {f.name}
        </span>
        <span className={cx('block text-[11px]', tw.ink3)}>
          {queued ? (
            <span className="inline-flex items-center gap-1">
              <CircleDashed size={10} /> No rows read from this file
            </span>
          ) : (
            <span className="font-mono">
              {f.format.toUpperCase()} · {f.rows} rows
              {f.from ? ` · ${f.from} → ${f.to}` : ''}
              {f.scanned ? ` · OCR ${f.pages}p` : ''}
            </span>
          )}
        </span>
      </span>
      <span className="text-[11px]">
        {queued ? null : accountId ? (
          <span className={cx('inline-flex items-center gap-1', tw.good)}>
            <Check size={11} /> {acctName(accountId)}
          </span>
        ) : (
          <span className="flex items-center gap-1.5">
            <TriangleAlert size={11} className={tw.warn} />
            <select
              aria-label={`Account for ${f.name}`}
              value=""
              onChange={(e) => assign(e.target.value)}
              className={cx(tw.input, 'h-[22px] px-1 text-[11px]')}
            >
              <option value="" disabled>
                Which {f.institution ? `${f.institution} ` : ''}account?
              </option>
              {accounts
                .filter((a) =>
                  f.format === 'pdf'
                    ? a.kind === 'investment'
                    : a.kind === 'credit' ||
                      a.kind === 'chequing' ||
                      a.kind === 'savings',
                )
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.institution} {a.name}
                  </option>
                ))}
            </select>
          </span>
        )}
      </span>
    </li>
  );
}

function FindingRow({
  f,
  status,
  selected,
  onSelect,
  txn,
  acctName,
  catName,
}: {
  f: Finding;
  status: string;
  selected: boolean;
  onSelect: () => void;
  txn: Map<string, Transaction>;
  acctName: (id: string) => string;
  catName: (id: string) => string;
}) {
  let title: ReactNode = '';
  let sub: ReactNode = '';
  let amount: ReactNode = null;
  if (f.kind === 'duplicate') {
    const t = txn.get(f.transactionId);
    title = t?.merchant;
    amount = t ? signedMoney(t.amount) : null;
    sub = f.reason;
  } else if (f.kind === 'missing-period') {
    title = `${acctName(f.accountId)}, ${f.from} → ${f.to}`;
    amount = signedMoney(f.expectedBalance - f.actualBalance);
    sub = 'Statement and ledger disagree';
  } else if (f.kind === 'transfer') {
    const o = txn.get(f.outId);
    const i = txn.get(f.inId);
    title = o?.descriptor;
    amount = o ? money(Math.abs(o.amount)) : null;
    sub = `${o ? acctName(o.accountId) : '?'} → ${i ? acctName(i.accountId) : '?'} · ${f.daysApart}d apart${f.auto ? ' · paired automatically' : ''}`;
  } else {
    const t = txn.get(f.transactionId);
    title = <span className="font-mono text-[12px]">{t?.descriptor}</span>;
    amount = t ? signedMoney(t.amount) : null;
    sub = `Suggests ${catName(f.suggestedCategoryId)} at ${pct(f.confidence)}`;
  }
  return (
    <button
      type="button"
      id={`rf-finding-${f.id}`}
      onClick={onSelect}
      className={cx(
        'relative grid w-full grid-cols-[16px_1fr_auto] items-start gap-x-2 border-t py-2 pr-1 pl-2 text-left',
        rowRule,
        selected ? tw.selected : tw.hover,
      )}
    >
      {selected ? (
        <span className="absolute inset-y-0 left-0 w-[2px] bg-[#2a78d6] dark:bg-[#3987e5]" />
      ) : null}
      <span className="mt-[3px]">
        {status === 'accepted' ? (
          <Check size={12} className={tw.good} />
        ) : status === 'dismissed' ? (
          <X size={12} className={tw.ink3} />
        ) : (
          <span className="block h-[7px] w-[7px] translate-x-[2px] translate-y-[2px] rounded-full border-[1.5px] border-[#b77c00] dark:border-[#fab219]" />
        )}
      </span>
      <span className={cx('min-w-0', status !== 'open' && 'opacity-55')}>
        <span className={cx('block truncate text-[13px]', tw.ink)}>
          {title}
        </span>
        <span className={cx('block truncate text-[11px]', tw.ink3)}>{sub}</span>
      </span>
      <span
        className={cx(
          'pt-px font-mono text-[12px] tabular-nums',
          status !== 'open' && 'opacity-55',
          tw.ink2,
        )}
      >
        {amount}
      </span>
    </button>
  );
}

// Inspector: the selected finding --------------------------------------------

type DetailProps = {
  f: Finding;
  status: string;
  ledger: Ledger;
  pal: Palette;
  txn: Map<string, Transaction>;
  acctName: (id: string) => string;
  catName: (id: string) => string;
  catColor: (id: string) => string;
  withheld: string[];
  lowChoice?: string;
  setLowChoice: (c: string) => void;
  lowRule: boolean;
  setLowRule: (v: boolean) => void;
  preview: ImportPreview;
  readOnly: boolean;
  accept: () => void;
  dismiss: () => void;
  reopen: () => void;
  position: string;
};

function Detail(props: DetailProps) {
  const { f, status, accept, dismiss, reopen, txn, acctName, readOnly } = props;
  const [label, yes, no] = ACTIONS[f.kind];
  const title =
    f.kind === 'missing-period'
      ? acctName(f.accountId)
      : f.kind === 'transfer'
        ? (txn.get(f.outId)?.descriptor ?? '')
        : (txn.get(f.transactionId)?.merchant ?? '');
  return (
    <div className="rf-in">
      <InspectorHead
        kicker={`${label} · ${props.position}`}
        title={title}
        sub={
          status === 'open' ? (
            <span className={tw.warn}>Open</span>
          ) : (
            <span className={status === 'accepted' ? tw.good : ''}>
              {status === 'accepted' ? yes : no}
            </span>
          )
        }
      />
      <div
        className={cx(
          'sticky top-0 z-10 flex items-center gap-2 border-b px-4 py-2',
          tw.surface,
          tw.rule,
        )}
      >
        {status === 'open' ? (
          <>
            <button
              type="button"
              onClick={accept}
              disabled={readOnly}
              className={tw.btnPrimary}
            >
              {yes}
              <kbd className="font-mono text-[10px] opacity-60">a</kbd>
            </button>
            <button
              type="button"
              onClick={dismiss}
              disabled={readOnly}
              className={tw.btn}
            >
              {no} <Kbd>x</Kbd>
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={reopen}
            disabled={readOnly}
            className={tw.btn}
          >
            Reopen <Kbd>u</Kbd>
          </button>
        )}
      </div>
      {f.kind === 'duplicate' ? <DuplicateDetail {...props} f={f} /> : null}
      {f.kind === 'missing-period' ? <MissingDetail {...props} f={f} /> : null}
      {f.kind === 'transfer' ? <TransferDetail {...props} f={f} /> : null}
      {f.kind === 'low-confidence' ? <LowDetail {...props} f={f} /> : null}
    </div>
  );
}

function DuplicateDetail({
  f,
  ledger,
  preview,
  txn,
  acctName,
  catName,
}: DetailProps & { f: Extract<Finding, { kind: 'duplicate' }> }) {
  const t = txn.get(f.transactionId);
  const m = txn.get(f.matchesId);
  if (!t || !m) return null;
  const batch = ledger.batches.find((b) => b.id === m.batchId);
  const file = preview.files.find((x) => x.accountId === t.accountId);
  const fields: [string, (x: Transaction) => ReactNode, boolean][] = [
    ['Date', (x) => x.date, true],
    ['Account', (x) => acctName(x.accountId), false],
    ['Amount', (x) => signedMoney(x.amount), true],
    ['Descriptor', (x) => x.descriptor, true],
    ['Category', (x) => catName(x.categoryId), false],
    ['Bank id', (x) => x.fitid ?? '—', true],
    ['Row id', (x) => x.id, true],
  ];
  return (
    <>
      <Block
        title="Side by side"
        right={f.tier === 'fitid' ? 'same bank id' : f.reason}
      >
        <table className="w-full table-fixed text-[12px]">
          <thead>
            <tr className={cx(tw.label, tw.ink3)}>
              <th className="w-[76px]" />
              <th className="pb-1 text-left font-medium">Incoming</th>
              <th className="pb-1 text-left font-medium">In the ledger</th>
            </tr>
          </thead>
          <tbody>
            {fields.map(([k, get, mono]) => {
              const differs = String(get(t)) !== String(get(m));
              return (
                <tr key={k} className={cx('border-t', rowRule)}>
                  <td className={cx('py-1.5 text-[11px]', tw.ink3)}>{k}</td>
                  {[t, m].map((x) => (
                    <td
                      key={x.id}
                      className={cx(
                        'truncate py-1.5 pr-2',
                        mono && 'font-mono text-[11px] tabular-nums',
                        differs &&
                          k !== 'Row id' &&
                          'bg-[#fff4d6] dark:bg-[#3a2f12]',
                        tw.ink,
                      )}
                    >
                      {get(x)}
                    </td>
                  ))}
                </tr>
              );
            })}
            <tr className={cx('border-t', rowRule)}>
              <td className={cx('py-1.5 text-[11px]', tw.ink3)}>From</td>
              <td
                className={cx(
                  'truncate py-1.5 pr-2 font-mono text-[11px]',
                  tw.ink,
                )}
              >
                {file?.name ?? 'this import'}
              </td>
              <td
                className={cx(
                  'truncate py-1.5 pr-2 font-mono text-[11px]',
                  tw.ink,
                )}
              >
                {batch ? `${batch.id} · ${batch.importedAt}` : m.batchId}
              </td>
            </tr>
          </tbody>
        </table>
      </Block>
      <p className={cx('px-4 py-3 text-[11px] leading-4', tw.ink3)}>
        Highlighted fields differ. Skipping keeps the ledger row and drops the
        incoming one from this batch.
      </p>
    </>
  );
}

function MissingDetail({
  f,
  ledger,
  pal,
}: DetailProps & { f: Extract<Finding, { kind: 'missing-period' }> }) {
  const rungs = ladder(ledger, f);
  const diff = f.expectedBalance - f.actualBalance;
  return (
    <>
      <Block title="The gap">
        <KV
          rows={[
            [
              'No export',
              <span key="v" className="font-mono">
                {f.from} → {f.to}
              </span>,
            ],
            [
              'Statement',
              <span key="v" className="font-mono">
                {money(f.expectedBalance)}
              </span>,
            ],
            [
              'Ledger',
              <span key="v" className="font-mono">
                {money(f.actualBalance)}
              </span>,
            ],
            [
              'Difference',
              <span key="v" className="font-mono">
                {signedMoney(diff)}
              </span>,
              tw.warn,
            ],
          ]}
        />
      </Block>
      <Block title="Balance ladder" right="month ends">
        <table className="w-full table-fixed text-[11px]">
          <thead>
            <tr className={cx(tw.label, tw.ink3)}>
              <th className="w-4" />
              <th className="w-[64px] pb-1 text-left font-medium">Month</th>
              <th className="pb-1 text-right font-medium">In</th>
              <th className="pb-1 text-right font-medium">Out</th>
              <th className="pb-1 text-right font-medium">Ledger</th>
              <th className="pb-1 text-right font-medium">Stmt</th>
            </tr>
          </thead>
          <tbody>
            {rungs.map((r, i) => (
              <tr
                key={r.month}
                style={
                  r.gap
                    ? {
                        backgroundImage: `repeating-linear-gradient(135deg, transparent 0 6px, ${pal.warn}1f 6px 7px)`,
                      }
                    : undefined
                }
              >
                <td className="relative h-7">
                  <span
                    className="absolute left-[5px] w-0 border-l-2"
                    style={{
                      borderColor:
                        r.gap || rungs[i - 1]?.gap ? pal.warn : pal.axis,
                      borderStyle: r.gap ? 'dashed' : 'solid',
                      top: i === 0 ? '50%' : 0,
                      bottom: i === rungs.length - 1 ? '50%' : 0,
                    }}
                  />
                  <span
                    className="absolute top-1/2 left-[1px] h-[10px] w-[10px] -translate-y-1/2 rounded-full border-2"
                    style={{
                      borderColor: pal.surface,
                      background: r.gap ? pal.warn : pal.ink2,
                    }}
                  />
                </td>
                <td className={cx('font-mono', tw.ink2)}>{mLong(r.month)}</td>
                <td
                  className={cx(
                    'text-right font-mono',
                    r.gap ? tw.ink3 : tw.good,
                  )}
                >
                  {r.inflow == null ? '—' : signedMoney(r.inflow, false)}
                </td>
                <td
                  className={cx(
                    'text-right font-mono',
                    r.gap ? tw.ink3 : tw.ink,
                  )}
                >
                  {r.outflow == null ? '' : signedMoney(r.outflow, false)}
                </td>
                <td className={cx('text-right font-mono', tw.ink)}>
                  {money(r.close, false)}
                </td>
                <td
                  className={cx(
                    'text-right font-mono',
                    r.statement != null ? tw.warn : tw.ink3,
                  )}
                >
                  {r.statement != null ? money(r.statement, false) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Block>
      <p className={cx('px-4 py-3 text-[11px] leading-4', tw.ink3)}>
        Upload the missing export to close the gap, or book a{' '}
        <span className="font-mono">{signedMoney(diff)}</span> adjustment dated{' '}
        {f.to} so the ladder reconciles from here on.
      </p>
    </>
  );
}

function TransferDetail({
  f,
  txn,
  acctName,
}: DetailProps & { f: Extract<Finding, { kind: 'transfer' }> }) {
  const o = txn.get(f.outId);
  const i = txn.get(f.inId);
  if (!o || !i) return null;
  const leg = (t: Transaction, side: string) => (
    <div className="min-w-0 flex-1 px-4 py-3">
      <div className={cx(tw.label, tw.ink3)}>{side}</div>
      <div className={cx('mt-1 truncate text-[12px]', tw.ink)}>
        {acctName(t.accountId)}
      </div>
      <div
        className={cx(
          'mt-2 font-mono text-[16px] tabular-nums',
          t.amount > 0 ? tw.good : tw.ink,
        )}
      >
        {signedMoney(t.amount)}
      </div>
      <div className={cx('mt-2 truncate font-mono text-[11px]', tw.ink3)}>
        {t.descriptor}
      </div>
      <div className={cx('font-mono text-[11px]', tw.ink3)}>{t.date}</div>
    </div>
  );
  return (
    <>
      <div className={cx('flex items-stretch border-b', tw.rule)}>
        {leg(o, 'Out')}
        <div
          className={cx(
            'flex flex-col items-center justify-center gap-1 border-x px-2 text-[10px]',
            tw.rule,
            tw.ink3,
          )}
        >
          <ArrowRight size={14} />
          {f.daysApart}d
        </div>
        {leg(i, 'In')}
      </div>
      <p className={cx('px-4 py-3 text-[12px] leading-5', tw.ink2)}>
        The legs net to{' '}
        <span className="font-mono">{signedMoney(o.amount + i.amount)}</span>.
        Pairing makes them one transfer: it leaves spending and income alone and
        shows as a single row in the ledger.
      </p>
    </>
  );
}

function LowDetail({
  f,
  ledger,
  pal,
  txn,
  acctName,
  catName,
  catColor,
  withheld,
  lowChoice,
  setLowChoice,
  lowRule,
  setLowRule,
  readOnly,
}: DetailProps & { f: Extract<Finding, { kind: 'low-confidence' }> }) {
  const t = txn.get(f.transactionId);
  if (!t) return null;
  const choice = lowChoice ?? f.suggestedCategoryId;
  const sim = similarTo(ledger, patternFor(t), choice, t.id);
  const held = withheld.includes(t.descriptor);
  return (
    <>
      <Block title="The row">
        <KV
          rows={[
            [
              'Date',
              <span key="v" className="font-mono">
                {t.date}
              </span>,
            ],
            ['Account', acctName(t.accountId)],
            [
              'Amount',
              <span key="v" className="font-mono">
                {signedMoney(t.amount)}
              </span>,
            ],
            ['Now', catName(t.categoryId)],
          ]}
        />
      </Block>
      <Block
        title="What the model sees"
        right={held ? 'withheld' : 'leaves the lab'}
      >
        <code
          className={cx(
            'block rounded-[3px] px-2 py-1.5 font-mono text-[12px]',
            tw.wash,
            tw.ink,
            held && 'line-through',
          )}
        >
          {t.descriptor}
        </code>
      </Block>
      <Block title="Suggestion">
        <div className="flex items-center gap-3 text-[12px]">
          <span
            className="h-2.5 w-2.5 rounded-[2px]"
            style={{ background: catColor(f.suggestedCategoryId) }}
          />
          <span className={tw.ink}>{catName(f.suggestedCategoryId)}</span>
          <div
            className="h-1.5 flex-1 overflow-hidden rounded-full"
            style={{ background: pal.grid }}
            role="meter"
            aria-valuenow={Math.round(f.confidence * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Confidence"
          >
            <div
              className="h-full rounded-full"
              style={{
                width: `${f.confidence * 100}%`,
                background: f.confidence < 0.6 ? pal.warn : pal.ink2,
              }}
            />
          </div>
          <span
            className={cx(
              'font-mono text-[11px]',
              f.confidence < 0.6 ? tw.warn : tw.ink3,
            )}
          >
            {pct(f.confidence)}
          </span>
        </div>
        <div className="mt-3 flex items-center gap-2">
          <span className={cx('w-[92px] text-[11px]', tw.ink3)}>
            File it under
          </span>
          <select
            aria-label="Category"
            disabled={readOnly}
            value={choice}
            onChange={(e) => setLowChoice(e.target.value)}
            className={cx(tw.input, 'min-w-0 flex-1')}
          >
            {categoryOptions(ledger.categories).map((o) => (
              <option key={o.id} value={o.id}>
                {o.group === o.label ? o.label : `${o.group} › ${o.label}`}
              </option>
            ))}
          </select>
        </div>
        <label
          className={cx('mt-3 flex items-start gap-2 text-[12px]', tw.ink2)}
        >
          <input
            type="checkbox"
            disabled={readOnly}
            checked={lowRule}
            onChange={(e) => setLowRule(e.target.checked)}
            className="mt-0.5 accent-[#2a78d6]"
          />
          <span>
            Make a rule: descriptor contains{' '}
            <code
              className={cx(
                'rounded-[2px] px-1 font-mono text-[11px]',
                tw.wash,
              )}
            >
              {patternFor(t)}
            </code>
            <span className={cx('font-mono', tw.ink3)}>
              {' '}
              · {sim.length} more {sim.length === 1 ? 'row' : 'rows'} move
            </span>
          </span>
        </label>
      </Block>
    </>
  );
}
