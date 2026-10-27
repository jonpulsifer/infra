import {
  ArrowRight,
  Check,
  ChevronRight,
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
import { isTyping, Kbd } from './bits';
import { mLong } from './charts';
import {
  type Action,
  categoryOptions,
  type DeskState,
  ladder,
  patternFor,
  type Resolution,
  similarTo,
  topResolver,
} from './model';
import { cap, count, monthName, plural } from './prose';
import { cx, money, type Palette, pct, signedMoney, tw } from './theme';

const GROUPS: { kind: Finding['kind']; label: string }[] = [
  { kind: 'duplicate', label: 'Duplicates' },
  { kind: 'missing-period', label: 'Missing periods' },
  { kind: 'transfer', label: 'Transfer pairs' },
  { kind: 'low-confidence', label: 'Low-confidence merchants' },
];

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
  const [selId, setSelId] = useState(ordered[0]?.id ?? '');
  const [showOutbound, setShowOutbound] = useState(false);
  const [drag, setDrag] = useState(false);
  const txn = useMemo(
    () => new Map(ledger.transactions.map((t) => [t.id, t])),
    [ledger.transactions],
  );
  const acct = useMemo(
    () => new Map(ledger.accounts.map((a) => [a.id, a])),
    [ledger.accounts],
  );
  const catName = useMemo(
    () => new Map(ledger.categories.map((c) => [c.id, c.name])),
    [ledger.categories],
  );
  const top = useMemo(
    () => topResolver(ledger.categories),
    [ledger.categories],
  );
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

  const resolve = (f: Finding, r: 'accepted' | 'dismissed' | null) => {
    dispatch({ type: 'resolve', id: f.id, resolution: r });
    if (r) {
      const i = ordered.indexOf(f);
      const next =
        ordered
          .slice(i + 1)
          .find((x) => status(x) === 'open' && x.id !== f.id) ??
        ordered.find((x) => status(x) === 'open' && x.id !== f.id);
      if (next) setSelId(next.id);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e) || e.metaKey || e.ctrlKey) return;
      const i = ordered.findIndex((f) => f.id === selId);
      if (e.key === 'j' || e.key === 'k') {
        e.preventDefault();
        const n = Math.max(
          0,
          Math.min(ordered.length - 1, i + (e.key === 'j' ? 1 : -1)),
        );
        setSelId(ordered[n].id);
        document
          .getElementById(`finding-${ordered[n].id}`)
          ?.scrollIntoView({ block: 'nearest' });
      } else if (sel && e.key === 'a') {
        acceptSel();
      } else if (sel && e.key === 'x') {
        resolve(sel, 'dismissed');
      } else if (sel && e.key === 'u') {
        resolve(sel, null);
      } else if (e.key === 'o') {
        setShowOutbound((s) => !s);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const [lowChoice, setLowChoice] = useState<Record<string, string>>({});
  const [lowRule, setLowRule] = useState<Record<string, boolean>>({});

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
    } else {
      dispatch({ type: 'recategorise', ids: [t.id], categoryId: cat });
    }
    resolve(f, 'accepted');
  };

  const acceptSel = () => {
    if (!sel) return;
    if (sel.kind === 'low-confidence') acceptLow(sel);
    else resolve(sel, 'accepted');
  };

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

  return (
    <div className="flex h-full flex-col">
      <div
        className={cx(
          'flex h-10 shrink-0 items-center gap-3 border-b px-3 text-[12px]',
          tw.rule,
          tw.surface,
        )}
      >
        <span className={cx(tw.label, tw.ink2)}>Import preview</span>
        <span className={cx(tw.num, tw.ink3)}>
          {files.length} files · {p.newTransactions.length} rows · {p.rulesHit}{' '}
          by rule · {sending.length} to the model
        </span>
        <span className={cx('ml-auto', tw.num, open ? tw.warn : tw.good)}>
          {open
            ? `${open} of ${ordered.length} findings open`
            : 'All findings resolved'}
        </span>
        {state.committed ? (
          <span className={cx('inline-flex items-center gap-1.5', tw.good)}>
            <Check size={12} /> Committed {commitRows} rows as batch b-2026-10
          </span>
        ) : (
          <button
            type="button"
            className={tw.btnPrimary}
            disabled={unassigned.length > 0}
            title={
              unassigned.length
                ? 'Assign every file to an account first'
                : undefined
            }
            onClick={() => dispatch({ type: 'commit' })}
          >
            {unassigned.length
              ? `${unassigned.length} file needs an account`
              : `Commit ${commitRows} rows${open ? ` with ${open} open` : ''}`}
          </button>
        )}
      </div>

      <Digest
        ledger={ledger}
        ordered={ordered}
        status={status}
        selKind={sel?.kind ?? null}
        files={files.filter((f) => f.rows > 0).length}
        unassigned={unassigned.map((f) => f.name)}
        sending={sending.length}
        committed={state.committed ? commitRows : null}
        skipped={skipped}
        pick={(kind) => {
          const pool = ordered.filter((f) => f.kind === kind);
          const next = pool.find((f) => status(f) === 'open') ?? pool[0];
          if (!next) return;
          setSelId(next.id);
          document
            .getElementById(`finding-${next.id}`)
            ?.scrollIntoView({ block: 'nearest' });
        }}
      />

      <div className="grid min-h-0 flex-1 grid-cols-[264px_minmax(300px,1fr)_minmax(380px,1.25fr)]">
        <aside
          className={cx(
            'flex min-h-0 flex-col overflow-auto border-r pb-16',
            tw.rule,
          )}
        >
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
              'm-3 flex cursor-pointer flex-col items-center gap-1 rounded-[4px] border border-dashed px-3 py-4 text-center text-[11px] transition-colors',
              drag
                ? 'border-[#2a78d6] bg-[#eaf2fc] dark:border-[#3987e5] dark:bg-[#18263a]'
                : cx('border-[#cfcec7] dark:border-[#3a3a37]', tw.hover),
              tw.ink3,
            )}
          >
            <Upload size={14} />
            <span className={tw.ink2}>Drop exports or statements</span>
            <span>CSV · QFX · OFX · PDF, many at once</span>
            <input
              type="file"
              multiple
              className="sr-only"
              onChange={(e) => addFiles(e.target.files)}
            />
          </label>
          <div className={cx(tw.label, tw.ink3, 'px-3 pb-1')}>Files</div>
          {files.map((f) => (
            <FileRow
              key={f.name}
              f={f}
              assigned={state.fileAccounts[f.name]}
              accounts={ledger.accounts}
              acctName={(id) => {
                const a = acct.get(id);
                return a ? `${a.institution} ${a.name}` : id;
              }}
              assign={(accountId) =>
                dispatch({ type: 'assignFile', name: f.name, accountId })
              }
            />
          ))}
          <dl
            className={cx(
              'mx-3 mt-3 grid grid-cols-[1fr_auto] gap-y-1 border-t pt-3 text-[11px]',
              tw.rule,
            )}
          >
            {(
              [
                ['New rows', p.newTransactions.length],
                ['Categorised by rule', p.rulesHit],
                ['Sent to the model', sending.length],
                ['Duplicates skipped', skipped],
              ] as const
            ).map(([k, v]) => (
              <div key={k} className="contents">
                <dt className={tw.ink3}>{k}</dt>
                <dd className={cx('text-right', tw.num, tw.ink)}>{v}</dd>
              </div>
            ))}
          </dl>
        </aside>

        <section className={cx('flex min-h-0 flex-col border-r', tw.rule)}>
          <div className={cx('shrink-0 border-b', tw.rule)}>
            <button
              type="button"
              aria-expanded={showOutbound}
              onClick={() => setShowOutbound((s) => !s)}
              className={cx(
                'flex h-9 w-full items-center gap-2 px-3 text-left text-[12px]',
                tw.hover,
              )}
            >
              <ShieldCheck
                size={13}
                className={sending.length ? tw.warn : tw.good}
              />
              <ChevronRight
                size={12}
                className={cx(
                  'transition-transform',
                  showOutbound && 'rotate-90',
                  tw.ink3,
                )}
              />
              <span className={tw.ink}>
                Would leave the lab:{' '}
                <span className={tw.num}>
                  {sending.length} {sending.length === 1 ? 'string' : 'strings'}
                </span>
              </span>
              {state.withheld.length ? (
                <span className={cx('text-[11px]', tw.ink3)}>
                  · {state.withheld.length} withheld
                </span>
              ) : null}
              <span className="ml-auto">
                <Kbd>o</Kbd>
              </span>
            </button>
            {showOutbound ? (
              <div className="max-h-[280px] overflow-auto px-3 pb-3 animate-[desk-in_140ms_ease-out]">
                <p
                  className={cx(
                    'mb-2 flex gap-1.5 text-[11px] leading-4',
                    tw.ink3,
                  )}
                >
                  <ShieldCheck size={12} className="mt-0.5 shrink-0" />
                  These descriptors are the only thing sent to the model,
                  verbatim. No amounts, dates, accounts or names. Withhold one
                  to keep it here; its row stays uncategorised.
                </p>
                <ul className={cx('border-t', tw.rule)}>
                  {p.outboundStrings.map((s) => {
                    const held = state.withheld.includes(s);
                    return (
                      <li
                        key={s}
                        className={cx(
                          'flex h-7 items-center gap-2 border-b',
                          tw.rule,
                        )}
                      >
                        <code
                          className={cx(
                            'min-w-0 flex-1 truncate font-mono text-[11px]',
                            held ? cx('line-through', tw.ink3) : tw.ink,
                          )}
                        >
                          {s}
                        </code>
                        <button
                          type="button"
                          onClick={() =>
                            dispatch({ type: 'withhold', value: s })
                          }
                          className={cx(
                            'text-[11px] hover:underline',
                            tw.accent,
                          )}
                        >
                          {held ? 'Send' : 'Withhold'}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : null}
          </div>
          <div className="min-h-0 flex-1 overflow-auto pb-16">
            {GROUPS.map((g) => {
              const items = ordered.filter((f) => f.kind === g.kind);
              if (!items.length) return null;
              const left = items.filter((f) => status(f) === 'open').length;
              return (
                <div key={g.kind}>
                  <div
                    className={cx(
                      'sticky top-0 z-10 flex h-7 items-center justify-between border-b px-3',
                      tw.surface,
                      tw.rule,
                    )}
                  >
                    <span className={cx(tw.label, tw.ink2)}>{g.label}</span>
                    <span className={cx('text-[11px]', tw.num, tw.ink3)}>
                      {left ? `${left} open` : 'done'} · {items.length}
                    </span>
                  </div>
                  {items.map((f) => (
                    <FindingRow
                      key={f.id}
                      f={f}
                      status={status(f)}
                      selected={f.id === selId}
                      onSelect={() => setSelId(f.id)}
                      txn={txn}
                      acctName={(id) => acct.get(id)?.name ?? id}
                      catName={(id) => catName.get(id) ?? id}
                    />
                  ))}
                </div>
              );
            })}
          </div>
        </section>

        <section className="min-h-0 overflow-auto pb-16">
          {sel ? (
            <Detail
              f={sel}
              status={status(sel)}
              ledger={ledger}
              pal={pal}
              txn={txn}
              acctName={(id) => {
                const a = acct.get(id);
                return a ? `${a.institution} ${a.name}` : id;
              }}
              catName={(id) => catName.get(id) ?? id}
              catColor={(id) => pal.cat[top(id).id] ?? pal.spend}
              withheld={state.withheld}
              lowChoice={lowChoice[sel.id]}
              setLowChoice={(c) => setLowChoice((x) => ({ ...x, [sel.id]: c }))}
              lowRule={!!lowRule[sel.id]}
              setLowRule={(v) => setLowRule((x) => ({ ...x, [sel.id]: v }))}
              accept={acceptSel}
              dismiss={() => resolve(sel, 'dismissed')}
              reopen={() => resolve(sel, null)}
            />
          ) : (
            <div className={cx('p-6 text-[12px]', tw.ink3)}>
              Nothing to review.
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

/** Editorial's findings digest, set above the panes: each phrase selects its findings. */
function Digest({
  ledger,
  ordered,
  status,
  selKind,
  files,
  unassigned,
  sending,
  committed,
  skipped,
  pick,
}: {
  ledger: Ledger;
  ordered: Finding[];
  status: (f: Finding) => Resolution | 'open';
  selKind: Finding['kind'] | null;
  files: number;
  unassigned: string[];
  sending: number;
  committed: number | null;
  skipped: number;
  pick: (kind: Finding['kind']) => void;
}) {
  const p = ledger.preview;
  const acct = (id: string) => {
    const a = ledger.accounts.find((x) => x.id === id);
    return a ? `${a.institution} ${a.name}` : id;
  };
  const of = (kind: Finding['kind']) => ordered.filter((f) => f.kind === kind);
  const phrase = (kind: Finding['kind'], n: number): string => {
    if (kind === 'duplicate') return plural(n, 'duplicate');
    if (kind === 'transfer') return plural(n, 'transfer pair');
    if (kind === 'low-confidence')
      return `${plural(n, 'merchant')} the rules did not know`;
    const g = of('missing-period')[0];
    if (g?.kind !== 'missing-period') return plural(n, 'missing period');
    const a = monthName(g.from.slice(0, 7));
    const b = monthName(g.to.slice(0, 7));
    return `${n === 1 ? 'a' : count(n)} missing ${n === 1 ? 'period' : 'periods'} on ${acct(g.accountId)}, ${a}${a === b ? '' : ` to ${b}`} ${g.to.slice(0, 4)}`;
  };
  const kinds = (
    ['duplicate', 'missing-period', 'transfer', 'low-confidence'] as const
  )
    .map((k) => ({ k, items: of(k) }))
    .filter((x) => x.items.length);
  const settled = ordered.filter((f) => status(f) !== 'open').length;

  return (
    <div
      className={cx(
        'shrink-0 border-b px-3 py-2.5',
        tw.rule,
        'bg-[#f7f7f4] dark:bg-[#171716]',
      )}
    >
      <p
        className={cx(
          'dw-prose max-w-[96ch] text-[15px] leading-[22px] text-pretty',
          tw.ink,
        )}
      >
        {committed != null ? (
          <>
            {cap(plural(committed, 'row'))} went into the ledger as batch
            b-2026-10
            {skipped ? `; ${plural(skipped, 'duplicate')} stayed out` : ''}.
            Every figure on the dashboard already counts them.
          </>
        ) : (
          <>
            Reading {plural(p.newTransactions.length, 'row')} from{' '}
            {plural(files, 'file')}, tally found{' '}
            {kinds.map(({ k, items }, i) => {
              const done = items.every((f) => status(f) !== 'open');
              const on = selKind === k;
              return (
                <span key={k}>
                  {i === 0
                    ? ''
                    : i === kinds.length - 1
                      ? `${kinds.length > 2 ? ',' : ''} and `
                      : ', '}
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={() => pick(k)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        pick(k);
                      }
                    }}
                    aria-pressed={on}
                    className={cx(
                      'cursor-pointer underline underline-offset-[5px] transition-colors outline-none focus-visible:bg-[#eaf2fc] dark:focus-visible:bg-[#18263a]',
                      on
                        ? 'decoration-[#2a78d6] decoration-2 dark:decoration-[#5a9cec]'
                        : 'decoration-[#c3c2b7] decoration-1 hover:decoration-[#0b0b0b] dark:decoration-[#45453f] dark:hover:decoration-[#f0efec]',
                      done && cx(tw.ink3, 'decoration-transparent'),
                    )}
                  >
                    {phrase(k, items.length)}
                    {done ? (
                      <Check
                        size={12}
                        className={cx('ml-0.5 inline', tw.good)}
                      />
                    ) : null}
                  </span>
                </span>
              );
            })}
            .{' '}
            <span className={tw.ink2}>
              {cap(plural(p.rulesHit, 'row'))} matched a rule you already have;{' '}
              {sending
                ? `${plural(sending, 'descriptor')} would leave the lab unless you settle or withhold ${sending === 1 ? 'it' : 'them'}.`
                : 'nothing needs the model.'}
              {unassigned.length
                ? ` ${unassigned.length === 1 ? 'One file needs' : `${cap(count(unassigned.length))} files need`} an account before it can be read.`
                : ''}{' '}
              <span className="tabular-nums">
                {settled} of {ordered.length}
              </span>{' '}
              settled.
            </span>
          </>
        )}
      </p>
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
    <div className={cx('border-t px-3 py-2', tw.rule)}>
      <div className="flex items-center gap-2">
        {f.format === 'pdf' ? (
          <ScanLine size={13} className={tw.ink3} />
        ) : (
          <FileText size={13} className={tw.ink3} />
        )}
        <span
          className={cx(
            'min-w-0 flex-1 truncate font-mono text-[11px]',
            tw.ink,
          )}
          title={f.name}
        >
          {f.name}
        </span>
        <span
          className={cx(
            'rounded-[2px] px-1 font-mono text-[9px] uppercase',
            tw.wash,
            tw.ink3,
          )}
        >
          {f.format}
        </span>
      </div>
      {queued ? (
        <div
          className={cx('mt-1 flex items-center gap-1 text-[11px]', tw.ink3)}
        >
          <CircleDashed size={11} /> Queued · the prototype does not parse files
        </div>
      ) : (
        <>
          <div className={cx('mt-0.5 pl-[21px] text-[11px]', tw.num, tw.ink3)}>
            {f.rows} rows · {f.from} → {f.to}
          </div>
          <div className="mt-1 pl-[21px] text-[11px]">
            {accountId ? (
              <span className={cx('inline-flex items-center gap-1', tw.good)}>
                <Check size={11} /> {acctName(accountId)}
                {f.scanned ? (
                  <span className={tw.ink3}> · OCR {f.pages} pages</span>
                ) : null}
              </span>
            ) : (
              <span className="flex items-center gap-1.5">
                <TriangleAlert size={11} className={tw.warn} />
                <span className={tw.warn}>Which account?</span>
                <select
                  aria-label={`Account for ${f.name}`}
                  value=""
                  onChange={(e) => assign(e.target.value)}
                  className={cx(
                    tw.input,
                    'h-[22px] min-w-0 flex-1 px-1 text-[11px]',
                  )}
                >
                  <option value="" disabled>
                    {f.institution}…
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
          </div>
        </>
      )}
    </div>
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
  if (f.kind === 'duplicate') {
    const t = txn.get(f.transactionId);
    title = (
      <>
        {t?.merchant} <span className={tw.num}>{t ? money(t.amount) : ''}</span>
      </>
    );
    sub = f.reason;
  } else if (f.kind === 'missing-period') {
    title = `${acctName(f.accountId)}: ${f.from} → ${f.to}`;
    sub = `Statement and ledger disagree by ${money(f.expectedBalance - f.actualBalance)}`;
  } else if (f.kind === 'transfer') {
    const o = txn.get(f.outId);
    const i = txn.get(f.inId);
    title = (
      <>
        {o?.descriptor}{' '}
        <span className={tw.num}>{o ? money(Math.abs(o.amount)) : ''}</span>
      </>
    );
    sub = `${o ? acctName(o.accountId) : '?'} → ${i ? acctName(i.accountId) : '?'} · ${f.daysApart} day apart`;
  } else {
    const t = txn.get(f.transactionId);
    title = <span className="font-mono text-[11px]">{t?.descriptor}</span>;
    sub = `Suggests ${catName(f.suggestedCategoryId)} at ${pct(f.confidence)}`;
  }
  return (
    <button
      type="button"
      id={`finding-${f.id}`}
      onClick={onSelect}
      className={cx(
        'relative flex w-full items-start gap-2 border-b px-3 py-1.5 text-left',
        'border-[#efeee9] dark:border-[#20201e]',
        selected ? tw.selected : tw.hover,
      )}
    >
      {selected ? (
        <span className="absolute inset-y-0 left-0 w-[2px] bg-[#2a78d6] dark:bg-[#3987e5]" />
      ) : null}
      <span className="mt-[3px] shrink-0">
        {status === 'accepted' ? (
          <Check size={12} className={tw.good} />
        ) : status === 'dismissed' ? (
          <X size={12} className={tw.ink3} />
        ) : (
          <span className="block h-[7px] w-[7px] translate-x-[2px] translate-y-[2px] rounded-full border-[1.5px] border-[#b77c00] dark:border-[#fab219]" />
        )}
      </span>
      <span className={cx('min-w-0 flex-1', status !== 'open' && 'opacity-55')}>
        <span className={cx('block truncate text-[12px]', tw.ink)}>
          {title}
        </span>
        <span className={cx('block truncate text-[11px]', tw.ink3)}>{sub}</span>
      </span>
    </button>
  );
}

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
};

const ACTIONS: Record<Finding['kind'], [string, string, string]> = {
  duplicate: ['Possible duplicate', 'Skip incoming row', 'Keep both'],
  'missing-period': [
    'Missing period',
    'Book an adjustment',
    "I'll upload the export",
  ],
  transfer: ['Transfer candidate', 'Pair as one transfer', 'Not a transfer'],
  'low-confidence': [
    'Low-confidence merchant',
    'Accept',
    'Leave uncategorised',
  ],
};

function Detail(props: DetailProps) {
  const { f, status, accept, dismiss, reopen } = props;
  const [label, yes, no] = ACTIONS[f.kind];
  return (
    <div key={f.id} className="animate-[desk-in_140ms_ease-out]">
      <div
        className={cx(
          'sticky top-0 z-10 flex h-10 items-center gap-2 border-b px-4',
          tw.surface,
          tw.rule,
        )}
      >
        <span className={cx(tw.label, tw.ink2)}>{label}</span>
        {status !== 'open' ? (
          <span
            className={cx(
              'text-[11px]',
              status === 'accepted' ? tw.good : tw.ink3,
            )}
          >
            · {status === 'accepted' ? yes.toLowerCase() : no.toLowerCase()}
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-2">
          {status === 'open' ? (
            <>
              <button type="button" onClick={dismiss} className={tw.btn}>
                {no} <Kbd>x</Kbd>
              </button>
              <button type="button" onClick={accept} className={tw.btnPrimary}>
                {yes}
                <kbd className="font-mono text-[10px] opacity-60">a</kbd>
              </button>
            </>
          ) : (
            <button type="button" onClick={reopen} className={tw.btn}>
              Reopen <Kbd>u</Kbd>
            </button>
          )}
        </div>
      </div>
      <div className="px-4 py-3">
        {f.kind === 'duplicate' ? <DuplicateDetail {...props} f={f} /> : null}
        {f.kind === 'missing-period' ? (
          <MissingDetail {...props} f={f} />
        ) : null}
        {f.kind === 'transfer' ? <TransferDetail {...props} f={f} /> : null}
        {f.kind === 'low-confidence' ? <LowDetail {...props} f={f} /> : null}
      </div>
    </div>
  );
}

function FieldTable({
  cols,
  rows,
}: {
  cols: { title: ReactNode; values: Record<string, ReactNode> }[];
  rows: { key: string; label: string; differs?: boolean; mono?: boolean }[];
}) {
  return (
    <table className="w-full table-fixed text-[12px]">
      <thead>
        <tr>
          <th className="w-[92px]" />
          {cols.map((c, i) => (
            <th key={i} className={cx('pb-1.5 text-left font-medium', tw.ink2)}>
              {c.title}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key} className={cx('border-t', tw.rule)}>
            <td className={cx('py-1.5 text-[11px]', tw.ink3)}>{r.label}</td>
            {cols.map((c, i) => (
              <td
                key={i}
                className={cx(
                  'truncate py-1.5 pr-2',
                  r.mono && 'font-mono text-[11px] tabular-nums',
                  r.differs ? 'bg-[#fff4d6] dark:bg-[#3a2f12]' : '',
                  tw.ink,
                )}
              >
                {c.values[r.key]}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
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
  const pendingVariant = /descriptor/i.test(f.reason);
  const existing = {
    ...t,
    id: m.id,
    batchId: m.batchId,
    descriptor: pendingVariant
      ? `${t.descriptor.replace(/\*.*$/, '').trim()} *PENDING`
      : t.descriptor,
  };
  const file = ledger.preview.files.find((x) => x.accountId === t.accountId);
  const vals = (x: Transaction, source: string) => ({
    date: x.date,
    account: acctName(x.accountId),
    amount: money(x.amount),
    descriptor: x.descriptor,
    merchant: x.merchant,
    category: catName(x.categoryId),
    source,
    id: x.id,
  });
  return (
    <div className="space-y-4">
      <p className={cx('text-[12px]', tw.ink2)}>{f.reason}.</p>
      <FieldTable
        cols={[
          { title: 'Incoming', values: vals(t, file?.name ?? 'this import') },
          {
            title: 'Already in the ledger',
            values: vals(
              existing,
              batch ? `${batch.id} · ${batch.importedAt}` : existing.batchId,
            ),
          },
        ]}
        rows={[
          { key: 'date', label: 'Date', mono: true },
          { key: 'account', label: 'Account' },
          { key: 'amount', label: 'Amount', mono: true },
          {
            key: 'descriptor',
            label: 'Descriptor',
            mono: true,
            differs: existing.descriptor !== t.descriptor,
          },
          { key: 'merchant', label: 'Merchant' },
          { key: 'category', label: 'Category' },
          { key: 'source', label: 'From', mono: true, differs: true },
          { key: 'id', label: 'Row id', mono: true, differs: true },
        ]}
      />
      <p className={cx('text-[11px]', tw.ink3)}>
        Highlighted fields differ. Skipping keeps the ledger row and drops the
        incoming one from this batch.
      </p>
    </div>
  );
}

function MissingDetail({
  f,
  ledger,
  pal,
  acctName,
}: DetailProps & { f: Extract<Finding, { kind: 'missing-period' }> }) {
  const rungs = ladder(ledger, f);
  const diff = f.expectedBalance - f.actualBalance;
  return (
    <div className="space-y-4">
      <p className={cx('text-[12px] leading-5', tw.ink2)}>
        {acctName(f.accountId)} has no export between{' '}
        <span className={tw.num}>{f.from}</span> and{' '}
        <span className={tw.num}>{f.to}</span>. The statement closing that
        period says{' '}
        <span className={cx(tw.num, tw.ink)}>{money(f.expectedBalance)}</span>
        {'; the ledger reaches '}
        <span className={cx(tw.num, tw.ink)}>{money(f.actualBalance)}</span>.
      </p>
      <div className={cx(tw.label, tw.ink3)}>Balance ladder</div>
      <table className="w-full table-fixed text-[12px]">
        <thead>
          <tr className={cx(tw.label, tw.ink3)}>
            <th className="w-5" />
            <th className="w-[72px] pb-1 text-left font-medium">Month end</th>
            <th className="pb-1 text-right font-medium">In</th>
            <th className="pb-1 text-right font-medium">Out</th>
            <th className="pb-1 text-right font-medium">Ledger</th>
            <th className="pb-1 text-right font-medium">Statement</th>
          </tr>
        </thead>
        <tbody>
          {rungs.map((r, i) => {
            const prevGap = rungs[i - 1]?.gap;
            return (
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
                <td className="relative h-8">
                  <span
                    className="absolute top-0 bottom-0 left-[7px] w-0 border-l-2"
                    style={{
                      borderColor: r.gap || prevGap ? pal.warn : pal.axis,
                      borderStyle: r.gap ? 'dashed' : 'solid',
                      top: i === 0 ? '50%' : 0,
                      bottom: i === rungs.length - 1 ? '50%' : 0,
                    }}
                  />
                  <span
                    className="absolute top-1/2 left-[3px] h-[10px] w-[10px] -translate-y-1/2 rounded-full border-2"
                    style={{
                      borderColor: pal.surface,
                      background: r.gap ? pal.warn : pal.ink2,
                    }}
                  />
                </td>
                <td className={cx(tw.num, 'text-[11px]', tw.ink2)}>
                  {mLong(r.month)}
                </td>
                <td
                  className={cx(
                    'text-right',
                    tw.num,
                    r.gap ? tw.ink3 : tw.good,
                  )}
                >
                  {r.inflow == null ? 'no export' : money(r.inflow, false)}
                </td>
                <td
                  className={cx('text-right', tw.num, r.gap ? tw.ink3 : tw.ink)}
                >
                  {r.outflow == null ? '' : money(r.outflow, false)}
                </td>
                <td className={cx('text-right', tw.num, tw.ink)}>
                  {money(r.close)}
                </td>
                <td className={cx('text-right', tw.num)}>
                  {r.statement != null ? (
                    <span className={tw.warn}>
                      {money(r.statement)}
                      <span className="block text-[10px]">
                        Δ {signedMoney(r.statement - r.close)}
                      </span>
                    </span>
                  ) : (
                    <span className={tw.ink3}>—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className={cx('text-[11px] leading-4', tw.ink3)}>
        Upload the July–August export to close the gap, or book a{' '}
        <span className={tw.num}>{signedMoney(diff)}</span> balance adjustment
        dated {f.to} so the ladder reconciles from here on.
      </p>
    </div>
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
    <div className={cx('flex-1 rounded-[4px] border p-3', tw.rule)}>
      <div className={cx(tw.label, tw.ink3)}>{side}</div>
      <div className={cx('mt-1 text-[12px]', tw.ink)}>
        {acctName(t.accountId)}
      </div>
      <div
        className={cx(
          'mt-2 font-mono text-[15px] tabular-nums',
          t.amount > 0 ? tw.good : tw.ink,
        )}
      >
        {signedMoney(t.amount)}
      </div>
      <div className={cx('mt-2 font-mono text-[11px]', tw.ink3)}>
        {t.descriptor}
      </div>
      <div className={cx('font-mono text-[11px]', tw.ink3)}>{t.date}</div>
    </div>
  );
  return (
    <div className="space-y-4">
      <div className="flex items-stretch gap-2">
        {leg(o, 'Out')}
        <div
          className={cx(
            'flex flex-col items-center justify-center gap-1 text-[10px]',
            tw.ink3,
          )}
        >
          <ArrowRight size={14} />
          {f.daysApart}d
        </div>
        {leg(i, 'In')}
      </div>
      <p className={cx('text-[12px] leading-5', tw.ink2)}>
        The legs net to{' '}
        <span className={tw.num}>{money(o.amount + i.amount)}</span>. Pairing
        makes them one transfer: it leaves spend and income alone and shows as a
        single row.
      </p>
    </div>
  );
}

function LowDetail({
  f,
  ledger,
  txn,
  acctName,
  catName,
  catColor,
  withheld,
  lowChoice,
  setLowChoice,
  lowRule,
  setLowRule,
  pal,
}: DetailProps & { f: Extract<Finding, { kind: 'low-confidence' }> }) {
  const t = txn.get(f.transactionId);
  if (!t) return null;
  const choice = lowChoice ?? f.suggestedCategoryId;
  const options = categoryOptions(ledger.categories);
  const sim = similarTo(ledger, patternFor(t), choice, t.id);
  const held = withheld.includes(t.descriptor);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-[92px_1fr] gap-y-1.5 text-[12px]">
        <span className={cx('text-[11px]', tw.ink3)}>Date</span>
        <span className={cx(tw.num, tw.ink)}>{t.date}</span>
        <span className={cx('text-[11px]', tw.ink3)}>Account</span>
        <span className={tw.ink}>{acctName(t.accountId)}</span>
        <span className={cx('text-[11px]', tw.ink3)}>Amount</span>
        <span className={cx(tw.num, tw.ink)}>{money(t.amount)}</span>
        <span className={cx('text-[11px]', tw.ink3)}>Now</span>
        <span className={tw.ink}>{catName(t.categoryId)}</span>
      </div>
      <div>
        <div className={cx(tw.label, tw.ink3, 'mb-1')}>What the model sees</div>
        <div
          className={cx(
            'flex items-center gap-2 rounded-[4px] border px-2 py-1.5',
            tw.rule,
            tw.wash,
          )}
        >
          <code
            className={cx(
              'flex-1 font-mono text-[12px]',
              tw.ink,
              held && 'line-through',
            )}
          >
            {t.descriptor}
          </code>
          <span className={cx('text-[10px]', held ? tw.ink3 : tw.warn)}>
            {held ? 'withheld' : 'leaves the lab'}
          </span>
        </div>
      </div>
      <div>
        <div className={cx(tw.label, tw.ink3, 'mb-1')}>Suggestion</div>
        <div className="flex items-center gap-3">
          <span
            className="h-2.5 w-2.5 rounded-[2px]"
            style={{ background: catColor(f.suggestedCategoryId) }}
          />
          <span className={cx('text-[12px]', tw.ink)}>
            {catName(f.suggestedCategoryId)}
          </span>
          <div
            className="h-1.5 w-28 overflow-hidden rounded-full"
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
              'text-[11px]',
              tw.num,
              f.confidence < 0.6 ? tw.warn : tw.ink3,
            )}
          >
            {pct(f.confidence)} sure
          </span>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <span className={cx('w-[92px] text-[11px]', tw.ink3)}>
          File it under
        </span>
        <select
          aria-label="Category"
          value={choice}
          onChange={(e) => setLowChoice(e.target.value)}
          className={cx(tw.input, 'min-w-0 flex-1')}
        >
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.group === o.label ? o.label : `${o.group} › ${o.label}`}
            </option>
          ))}
        </select>
      </div>
      <label className={cx('flex items-center gap-2 text-[12px]', tw.ink2)}>
        <input
          type="checkbox"
          checked={lowRule}
          onChange={(e) => setLowRule(e.target.checked)}
          className="accent-[#2a78d6]"
        />
        Make a rule: descriptor contains{' '}
        <code
          className={cx('rounded-[2px] px-1 font-mono text-[11px]', tw.wash)}
        >
          {patternFor(t)}
        </code>
        <span className={cx(tw.num, tw.ink3)}>
          · {sim.length} more {sim.length === 1 ? 'row' : 'rows'}
        </span>
      </label>
    </div>
  );
}
