import { UNCATEGORIZED } from '~/fixtures/derive';
import { buildLedger } from '~/fixtures/generate';
import type {
  ImportPreview,
  Ledger,
  PreviewFile,
  Rule,
  Transaction,
} from '~/fixtures/types';
import type { Decisions } from '~/lib/store';
import { type Api, ApiError } from './client';

const clone = <T>(v: T): T => structuredClone(v);

function extOf(name: string): PreviewFile['format'] {
  const ext = name.split('.').pop()?.toLowerCase();
  return ext === 'pdf' || ext === 'qfx' || ext === 'ofx' ? ext : 'csv';
}

function asOf(transactions: Transaction[]) {
  return transactions.reduce((m, t) => (t.date > m ? t.date : m), '');
}

/**
 * Fold a preview into a ledger the way the server's apply does. The synthetic
 * preview's rows already carry their account, so file assignments only
 * unblock the commit here.
 */
export function applyDecisions(
  ledger: Ledger,
  preview: ImportPreview,
  d: Decisions,
  batchId: string,
): { ledger: Ledger; rows: number } {
  const accepted = new Set(d.acceptFindings);
  const dismissed = new Set(d.dismissFindings);
  const withheld = new Set(d.withholdStrings);
  const skip = new Set<string>();
  const unpair = new Set<string>();
  for (const f of preview.findings) {
    if (f.kind === 'duplicate' && accepted.has(f.id)) skip.add(f.transactionId);
    if (f.kind === 'transfer' && dismissed.has(f.id)) {
      unpair.add(f.outId);
      unpair.add(f.inId);
    }
  }
  const incoming = preview.newTransactions
    .filter((t) => !skip.has(t.id))
    .map((t): Transaction => {
      const chosen = d.recategorise[t.id];
      const held = withheld.has(t.descriptor) && t.source === 'model';
      return {
        ...t,
        batchId,
        transferId: unpair.has(t.id) ? null : t.transferId,
        categoryId: chosen ?? (held ? UNCATEGORIZED : t.categoryId),
        source: chosen || held ? 'manual' : t.source,
        confidence: chosen || held ? null : t.confidence,
      };
    });
  const rules: Rule[] = d.makeRules.flatMap((id) => {
    const t = preview.newTransactions.find((x) => x.id === id);
    if (!t) return [];
    return [
      {
        id: `r-${batchId}-${id}`,
        match: t.descriptor.split(/\s+/).slice(0, 2).join(' '),
        categoryId: d.recategorise[id] ?? t.categoryId,
        merchant: t.merchant,
        createdFrom: 'correction',
        hits: 1,
      },
    ];
  });
  const transactions = [...ledger.transactions, ...incoming].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0,
  );
  return {
    rows: incoming.length,
    ledger: {
      ...ledger,
      transactions,
      rules: [...rules, ...ledger.rules],
      batches: [
        ...ledger.batches,
        {
          id: batchId,
          importedAt: new Date().toISOString().slice(0, 10),
          files: preview.files.length,
          rows: incoming.length,
          note: 'Synthetic import',
        },
      ],
      asOf: asOf(transactions),
    },
  };
}

/**
 * The same interface as the server, held in memory over the deterministic
 * synthetic ledger. Nothing leaves the page.
 */
export function syntheticApi(seed = 1337): Api {
  const built = buildLedger(seed);
  let ledger = built.ledger;
  const previews = new Map<string, ImportPreview>([
    [built.preview.id, built.preview],
  ]);
  let seq = 0;
  const preview = (id: string) => {
    const p = previews.get(id);
    if (!p) throw new ApiError(404, `404 No preview ${id}`);
    return p;
  };
  const txn = (id: string) => {
    const t = ledger.transactions.find((x) => x.id === id);
    if (!t) throw new ApiError(404, `404 No transaction ${id}`);
    return t;
  };
  return {
    source: 'synthetic',
    pendingPreviewId: built.preview.id,
    me: async () => ({
      login: ledger.owner,
      role: 'owner',
      ledgerId: 'synthetic',
    }),
    ledger: async () => clone(ledger),
    report: async (name) => {
      throw new ApiError(404, `404 No synthetic report ${name}`);
    },
    transactions: async (q = {}) =>
      clone(
        ledger.transactions.filter(
          (t) =>
            (!q.from || t.date >= q.from) &&
            (!q.to || t.date <= q.to) &&
            (!q.accountId || t.accountId === q.accountId) &&
            (!q.categoryId || t.categoryId === q.categoryId) &&
            (!q.q ||
              t.descriptor.toLowerCase().includes(q.q.toLowerCase()) ||
              t.merchant.toLowerCase().includes(q.q.toLowerCase())),
        ),
      ),
    previewImport: async (files) => {
      const id = `synthetic-${++seq}`;
      const first = previews.has(built.preview.id);
      const p: ImportPreview = first
        ? clone(built.preview)
        : {
            id,
            files: [],
            newTransactions: [],
            findings: [],
            outboundStrings: [],
            rulesHit: 0,
            modelCalls: 0,
          };
      p.id = id;
      p.files.push(
        ...files.map((f) => ({
          name: f.name,
          format: extOf(f.name),
          institution: '',
          accountId: null,
          rows: 0,
          from: '',
          to: '',
        })),
      );
      previews.set(id, p);
      return clone(p);
    },
    getPreview: async (id) => clone(preview(id)),
    applyPreview: async (id, decisions) => {
      const p = preview(id);
      const batchId = `b-synthetic-${++seq}`;
      ledger = applyDecisions(ledger, p, decisions, batchId).ledger;
      previews.clear();
      const batch = ledger.batches[ledger.batches.length - 1];
      return { ledger: clone(ledger), batch: clone(batch) };
    },
    setCategory: async (id, categoryId) => {
      const next = {
        ...txn(id),
        categoryId,
        source: 'manual' as const,
        confidence: null,
      };
      ledger = {
        ...ledger,
        transactions: ledger.transactions.map((t) => (t.id === id ? next : t)),
      };
      return clone(next);
    },
    rules: async () => clone(ledger.rules),
    createRule: async (draft) => {
      const p = draft.match.toLowerCase();
      const moved: Transaction[] = [];
      const transactions = ledger.transactions.map((t) => {
        if (t.transferId || t.categoryId === draft.categoryId) return t;
        if (!t.descriptor.toLowerCase().includes(p)) return t;
        const next = {
          ...t,
          categoryId: draft.categoryId,
          source: 'rule' as const,
          confidence: null,
        };
        moved.push(next);
        return next;
      });
      const rule: Rule = {
        id: `r-${++seq}`,
        match: draft.match,
        categoryId: draft.categoryId,
        merchant: draft.merchant,
        createdFrom: 'correction',
        hits: moved.length,
        accountId: draft.accountId ?? null,
      };
      ledger = { ...ledger, transactions, rules: [rule, ...ledger.rules] };
      return clone({ rule, moved });
    },
    accounts: async () => clone(ledger.accounts),
    createAccount: async (draft) => {
      const account = { ...draft, id: `acct-${++seq}` };
      ledger = { ...ledger, accounts: [...ledger.accounts, account] };
      return clone(account);
    },
    addValuation: async (v) => {
      ledger = {
        ...ledger,
        valuations: [...ledger.valuations, v].sort((a, b) =>
          a.date < b.date ? -1 : a.date > b.date ? 1 : 0,
        ),
      };
      return clone(v);
    },
  };
}
