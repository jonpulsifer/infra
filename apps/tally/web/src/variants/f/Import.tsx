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
  useState,
} from 'react';
import type {
  Finding,
  Ledger,
  PreviewFile,
  Transaction,
} from '~/fixtures/types';
import { isTyping, Kbd } from '~/variants/a/bits';
import { mLong } from '~/variants/a/charts';
import {
  type Action,
  categoryOptions,
  type DeskState,
  ladder,
  patternFor,
  type Resolution,
  similarTo,
  topResolver,
} from '~/variants/a/model';
import {
  cx,
  money,
  type Palette,
  pct,
  signedMoney,
  tw,
} from '~/variants/a/theme';
import { Split } from './Split';
import { longDate } from './state';
import { Block, groupColor, InspectorHead, KV, rowRule, serif } from './ui';

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

export function Import({
  ledger,
  pal,
  state,
  dispatch,
}: {
  ledger: Ledger;
  pal: Palette;
  state: DeskState;
  dispatch: Dispatch<Action>;
}) {
  const p = ledger.preview;
  const ordered = useMemo(
    () => GROUPS.flatMap((g) => p.findings.filter((f) => f.kind === g.kind)),
    [p.findings],
  );
  const [selId, setSelId] = useState(
    () =>
      ordered.find((f) => !state.resolutions[f.id])?.id ?? ordered[0]?.id ?? '',
  );
  const [drag, setDrag] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [lowChoice, setLowChoice] = useState<Record<string, string>>({});
  const [lowRule, setLowRule] = useState<Record<string, boolean>>({});
  const txn = useMemo(
    () => new Map(ledger.transactions.map((t) => [t.id, t])),
    [ledger.transactions],
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
    state.resolutions[f.id] ?? 'open';
  const open = ordered.filter((f) => status(f) === 'open').length;
  const sel = ordered.find((f) => f.id === selId) ?? null;
  const files = [...p.files, ...state.addedFiles];
  const unassigned = files.filter(
    (f) => !f.accountId && !state.fileAccounts[f.name] && f.rows > 0,
  );
  const sending = p.outboundStrings.filter((s) => !state.withheld.includes(s));
  const skipped = ordered.filter(
    (f) => f.kind === 'duplicate' && status(f) === 'accepted',
  ).length;
  const commitRows = p.newTransactions.length - skipped;
  const from = p.files.map((f) => f.from).sort()[0];
  const to = p.files
    .map((f) => f.to)
    .sort()
    .slice(-1)[0];

  const select = (id: string) => {
    setSelId(id);
    document
      .getElementById(`rf-finding-${id}`)
      ?.scrollIntoView({ block: 'nearest' });
  };

  const resolve = (f: Finding, r: Resolution | null) => {
    dispatch({ type: 'resolve', id: f.id, resolution: r });
    if (!r) return;
    const i = ordered.indexOf(f);
    const next =
      ordered.slice(i + 1).find((x) => status(x) === 'open' && x.id !== f.id) ??
      ordered.find((x) => status(x) === 'open' && x.id !== f.id);
    if (next) select(next.id);
  };

  const acceptLow = (f: Extract<Finding, { kind: 'low-confidence' }>) => {
    const t = txn.get(f.transactionId);
    if (!t) return;
    const cat = lowChoice[f.id] ?? f.suggestedCategoryId;
    if (lowRule[f.id]) {
      const pattern = patternFor(t);
      const sim = similarTo(ledger, pattern, cat, t.id);
      dispatch({
        type: 'addRule',
        rule: {
          id: `r${ledger.rules.length}-${t.id}`,
          match: pattern,
          categoryId: cat,
          merchant: t.merchant,
          createdFrom: 'correction',
          hits: sim.length + 1,
        },
        ids: [t.id, ...sim.map((s) => s.id)],
      });
    } else dispatch({ type: 'recategorise', ids: [t.id], categoryId: cat });
    resolve(f, 'accepted');
  };

  const accept = () => {
    if (!sel) return;
    if (sel.kind === 'low-confidence') acceptLow(sel);
    else resolve(sel, 'accepted');
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

  const addFiles = (list: FileList | null) => {
    if (!list?.length) return;
    const added: PreviewFile[] = Array.from(list).map((f) => {
      const ext = f.name.split('.').pop()?.toLowerCase();
      return {
        name: f.name,
        format: ext === 'pdf' || ext === 'qfx' || ext === 'ofx' ? ext : 'csv',
        institution: '—',
        accountId: null,
        rows: 0,
        from: '',
        to: '',
      };
    });
    dispatch({ type: 'addFiles', files: added });
  };

  const commit = state.committed ? (
    <span
      className={cx('inline-flex items-center gap-1.5 text-[12px]', tw.good)}
    >
      <Check size={13} /> Committed {commitRows} rows as batch b-2026-10
    </span>
  ) : (
    <button
      type="button"
      className={tw.btnPrimary}
      disabled={unassigned.length > 0}
      title={
        unassigned.length ? 'Assign every file to an account first' : undefined
      }
      onClick={() => dispatch({ type: 'commit' })}
    >
      {unassigned.length
        ? `${unassigned.length} file needs an account`
        : `Commit ${commitRows} rows${open ? ` with ${open} open` : ''}`}
    </button>
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
        {files.length} files carry{' '}
        <span className={cx('font-mono', tw.ink)}>
          {p.newTransactions.length}
        </span>{' '}
        new rows from {longDate(from)} to {longDate(to)}.{' '}
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
        <label
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            addFiles(e.dataTransfer.files);
          }}
          className={cx(
            'flex cursor-pointer items-center gap-3 border border-dashed px-4 py-3 text-[12px] transition-colors',
            drag
              ? 'border-[#2a78d6] bg-[#eaf2fc] dark:border-[#3987e5] dark:bg-[#18263a]'
              : cx('border-[#cfcec7] dark:border-[#3a3a37]', tw.hover),
            tw.ink3,
          )}
        >
          <Upload size={15} />
          <span className={tw.ink2}>Drop exports or statements here</span>
          <span className="ml-auto">CSV · QFX · OFX · PDF, many at once</span>
          <input
            type="file"
            multiple
            className="sr-only"
            onChange={(e) => addFiles(e.target.files)}
          />
        </label>
        <ul className="mt-2">
          {files.map((f) => (
            <FileRow
              key={f.name}
              f={f}
              assigned={state.fileAccounts[f.name]}
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
          These descriptors are the only thing sent to the model, verbatim. No
          amounts, dates, accounts or names. Withhold one to keep it here; its
          row stays uncategorised.
        </p>
        <ul className={cx('border-t', tw.rule)}>
          {p.outboundStrings.map((s) => {
            const held = state.withheld.includes(s);
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
          {sending.length} sent · {state.withheld.length} withheld ·{' '}
          {p.modelCalls} model calls
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
      withheld={state.withheld}
      lowChoice={lowChoice[sel.id]}
      setLowChoice={(c) => setLowChoice((x) => ({ ...x, [sel.id]: c }))}
      lowRule={!!lowRule[sel.id]}
      setLowRule={(v) => setLowRule((x) => ({ ...x, [sel.id]: v }))}
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
  const accountId = f.accountId ?? assigned;
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
              <CircleDashed size={10} /> Queued · the prototype does not parse
              files
            </span>
          ) : (
            <span className="font-mono">
              {f.format.toUpperCase()} · {f.rows} rows · {f.from} → {f.to}
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
                Which {f.institution} account?
              </option>
              {accounts
                .filter(
                  (a) =>
                    a.kind === 'credit' ||
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
    amount = t ? money(t.amount) : null;
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
    sub = `${o ? acctName(o.accountId) : '?'} → ${i ? acctName(i.accountId) : '?'} · ${f.daysApart}d apart`;
  } else {
    const t = txn.get(f.transactionId);
    title = <span className="font-mono text-[12px]">{t?.descriptor}</span>;
    amount = t ? money(t.amount) : null;
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
  accept: () => void;
  dismiss: () => void;
  reopen: () => void;
  position: string;
};

function Detail(props: DetailProps) {
  const { f, status, accept, dismiss, reopen, txn, acctName } = props;
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
            <button type="button" onClick={accept} className={tw.btnPrimary}>
              {yes}
              <kbd className="font-mono text-[10px] opacity-60">a</kbd>
            </button>
            <button type="button" onClick={dismiss} className={tw.btn}>
              {no} <Kbd>x</Kbd>
            </button>
          </>
        ) : (
          <button type="button" onClick={reopen} className={tw.btn}>
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
  txn,
  acctName,
  catName,
}: DetailProps & { f: Extract<Finding, { kind: 'duplicate' }> }) {
  const t = txn.get(f.transactionId);
  const m = txn.get(f.matchesId);
  if (!t || !m) return null;
  const batch = ledger.batches.find((b) => b.id === m.batchId);
  const variant = /descriptor/i.test(f.reason);
  const existing = {
    ...t,
    id: m.id,
    batchId: m.batchId,
    descriptor: variant
      ? `${t.descriptor.replace(/\*.*$/, '').trim()} *PENDING`
      : t.descriptor,
  };
  const file = ledger.preview.files.find((x) => x.accountId === t.accountId);
  const fields: [string, (x: Transaction) => ReactNode, boolean, boolean][] = [
    ['Date', (x) => x.date, false, true],
    ['Account', (x) => acctName(x.accountId), false, false],
    ['Amount', (x) => money(x.amount), false, true],
    [
      'Descriptor',
      (x) => x.descriptor,
      existing.descriptor !== t.descriptor,
      true,
    ],
    ['Category', (x) => catName(x.categoryId), false, false],
    ['Row id', (x) => x.id, true, true],
  ];
  return (
    <>
      <Block title="Side by side" right={f.reason}>
        <table className="w-full table-fixed text-[12px]">
          <thead>
            <tr className={cx(tw.label, tw.ink3)}>
              <th className="w-[76px]" />
              <th className="pb-1 text-left font-medium">Incoming</th>
              <th className="pb-1 text-left font-medium">In the ledger</th>
            </tr>
          </thead>
          <tbody>
            {fields.map(([k, get, differs, mono]) => (
              <tr key={k} className={cx('border-t', rowRule)}>
                <td className={cx('py-1.5 text-[11px]', tw.ink3)}>{k}</td>
                {[t, existing].map((x) => (
                  <td
                    key={x.id}
                    className={cx(
                      'truncate py-1.5 pr-2',
                      mono && 'font-mono text-[11px] tabular-nums',
                      differs && 'bg-[#fff4d6] dark:bg-[#3a2f12]',
                      tw.ink,
                    )}
                  >
                    {get(x)}
                  </td>
                ))}
              </tr>
            ))}
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
                {batch ? `${batch.id} · ${batch.importedAt}` : existing.batchId}
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
                  {r.inflow == null ? '—' : money(r.inflow, false)}
                </td>
                <td
                  className={cx(
                    'text-right font-mono',
                    r.gap ? tw.ink3 : tw.ink,
                  )}
                >
                  {r.outflow == null ? '' : money(r.outflow, false)}
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
        <span className="font-mono">{money(o.amount + i.amount)}</span>. Pairing
        makes them one transfer: it leaves spending and income alone and shows
        as a single row in the ledger.
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
                {money(t.amount)}
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
