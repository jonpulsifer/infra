import { UNCATEGORIZED } from '~/fixtures/derive';
import type {
  Account,
  ImportPreview,
  Ledger,
  Rule,
  Transaction,
  Valuation,
} from '~/fixtures/types';

export type Screen =
  | 'dashboard'
  | 'transactions'
  | 'import'
  | 'accounts'
  | 'rules';

export type Resolution = 'accepted' | 'dismissed';

/** What the owner has said about the open preview so far. */
export type Review = {
  resolutions: Record<string, Resolution>;
  withheld: string[];
  fileAccounts: Record<string, string>;
  /** Preview transaction id to the category the owner chose for it. */
  categories: Record<string, string>;
  /** Preview transaction ids whose correction becomes a rule. */
  makeRules: string[];
};

export type ImportState =
  | { phase: 'idle' }
  | { phase: 'uploading'; names: string[] }
  | { phase: 'review'; preview: ImportPreview; review: Review }
  | { phase: 'applying'; preview: ImportPreview; review: Review }
  | { phase: 'applied'; rows: number; batchId: string | null };

/**
 * The server's ledger, plus what the owner did that the server has not yet
 * confirmed. `overrides` and `pendingRules` are optimistic; a settle replaces
 * them with the server's answer and a revert drops them.
 */
export type State = {
  base: Ledger;
  overrides: Record<string, string>;
  pendingRules: Rule[];
  freshRules: string[];
  imp: ImportState;
  error: string | null;
};

export type Action =
  | { type: 'recategorise'; ids: string[]; categoryId: string }
  | { type: 'addRule'; rule: Rule; ids: string[] }
  | { type: 'settle'; ids: string[]; transactions: Transaction[] }
  | { type: 'settleRule'; tempId: string; rule: Rule }
  | { type: 'revert'; ids: string[]; ruleId?: string; error: string }
  | { type: 'sync'; ledger: Ledger; ids?: string[] }
  | { type: 'addAccount'; account: Account }
  | { type: 'addValuation'; valuation: Valuation }
  | { type: 'uploading'; names: string[] }
  | { type: 'preview'; preview: ImportPreview }
  | { type: 'resolve'; id: string; resolution: Resolution | null }
  | { type: 'withhold'; value: string }
  | { type: 'assignFile'; name: string; accountId: string }
  | {
      type: 'choose';
      transactionId: string;
      categoryId: string;
      rule: boolean;
    }
  | { type: 'applying' }
  | { type: 'applied'; ledger: Ledger; rows: number; batchId: string | null }
  | { type: 'discard' }
  | { type: 'error'; error: string | null };

export function initState(ledger: Ledger): State {
  return {
    base: ledger,
    overrides: {},
    pendingRules: [],
    freshRules: [],
    imp: { phase: 'idle' },
    error: null,
  };
}

export function emptyReview(): Review {
  return {
    resolutions: {},
    withheld: [],
    fileAccounts: {},
    categories: {},
    makeRules: [],
  };
}

function without<T>(rec: Record<string, T>, ids: string[]) {
  const next = { ...rec };
  for (const id of ids) delete next[id];
  return next;
}

function assign(rec: Record<string, string>, ids: string[], value: string) {
  const next = { ...rec };
  for (const id of ids) next[id] = value;
  return next;
}

function patchTransactions(ledger: Ledger, fresh: Transaction[]): Ledger {
  if (!fresh.length) return ledger;
  const byId = new Map(fresh.map((t) => [t.id, t]));
  return {
    ...ledger,
    transactions: ledger.transactions.map((t) => byId.get(t.id) ?? t),
  };
}

function editReview(state: State, edit: (r: Review) => Review): State {
  if (state.imp.phase !== 'review') return state;
  return { ...state, imp: { ...state.imp, review: edit(state.imp.review) } };
}

export function reduce(state: State, action: Action): State {
  switch (action.type) {
    case 'recategorise':
      return {
        ...state,
        overrides: assign(state.overrides, action.ids, action.categoryId),
      };
    case 'addRule':
      return {
        ...state,
        pendingRules: [action.rule, ...state.pendingRules],
        freshRules: [action.rule.id, ...state.freshRules],
        overrides: assign(state.overrides, action.ids, action.rule.categoryId),
      };
    case 'settle':
      return {
        ...state,
        base: patchTransactions(state.base, action.transactions),
        overrides: without(state.overrides, action.ids),
      };
    case 'settleRule':
      return {
        ...state,
        base: {
          ...state.base,
          rules: [
            action.rule,
            ...state.base.rules.filter((r) => r.id !== action.rule.id),
          ],
        },
        pendingRules: state.pendingRules.filter((r) => r.id !== action.tempId),
        freshRules: state.freshRules.map((id) =>
          id === action.tempId ? action.rule.id : id,
        ),
      };
    case 'revert':
      return {
        ...state,
        overrides: without(state.overrides, action.ids),
        pendingRules: state.pendingRules.filter((r) => r.id !== action.ruleId),
        freshRules: state.freshRules.filter((id) => id !== action.ruleId),
        error: action.error,
      };
    case 'sync':
      return {
        ...state,
        base: action.ledger,
        overrides: action.ids
          ? without(state.overrides, action.ids)
          : state.overrides,
      };
    case 'addAccount':
      return {
        ...state,
        base: {
          ...state.base,
          accounts: [...state.base.accounts, action.account],
        },
      };
    case 'addValuation':
      return {
        ...state,
        base: {
          ...state.base,
          valuations: [...state.base.valuations, action.valuation].sort(
            (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0),
          ),
        },
      };
    case 'uploading':
      return { ...state, imp: { phase: 'uploading', names: action.names } };
    case 'preview':
      return {
        ...state,
        imp: {
          phase: 'review',
          preview: action.preview,
          review: emptyReview(),
        },
      };
    case 'resolve':
      return editReview(state, (r) => {
        const resolutions = { ...r.resolutions };
        if (action.resolution) resolutions[action.id] = action.resolution;
        else delete resolutions[action.id];
        return { ...r, resolutions };
      });
    case 'withhold':
      return editReview(state, (r) => ({
        ...r,
        withheld: r.withheld.includes(action.value)
          ? r.withheld.filter((s) => s !== action.value)
          : [...r.withheld, action.value],
      }));
    case 'assignFile':
      return editReview(state, (r) => ({
        ...r,
        fileAccounts: { ...r.fileAccounts, [action.name]: action.accountId },
      }));
    case 'choose':
      return editReview(state, (r) => ({
        ...r,
        categories: {
          ...r.categories,
          [action.transactionId]: action.categoryId,
        },
        makeRules: action.rule
          ? [...new Set([...r.makeRules, action.transactionId])]
          : r.makeRules.filter((id) => id !== action.transactionId),
      }));
    case 'applying':
      if (state.imp.phase !== 'review') return state;
      return { ...state, imp: { ...state.imp, phase: 'applying' } };
    case 'applied':
      return {
        ...state,
        base: action.ledger,
        imp: { phase: 'applied', rows: action.rows, batchId: action.batchId },
      };
    case 'discard':
      return { ...state, imp: { phase: 'idle' } };
    case 'error':
      return {
        ...state,
        error: action.error,
        imp:
          state.imp.phase === 'uploading'
            ? { phase: 'idle' }
            : state.imp.phase === 'applying'
              ? { ...state.imp, phase: 'review' }
              : state.imp,
      };
  }
}

/** The ledger the screens read: the server's, with optimistic edits laid over it. */
export function liveLedger(state: State): Ledger {
  const ids = Object.keys(state.overrides);
  if (!ids.length && !state.pendingRules.length) return state.base;
  return {
    ...state.base,
    rules: [...state.pendingRules, ...state.base.rules],
    transactions: ids.length
      ? state.base.transactions.map((t) => {
          const c = state.overrides[t.id];
          return c && c !== t.categoryId
            ? {
                ...t,
                categoryId: c,
                source: 'manual' as const,
                confidence: null,
              }
            : t;
        })
      : state.base.transactions,
  };
}

/** What a preview would commit, given the review so far. */
export function previewCounts(preview: ImportPreview, review: Review) {
  const open = preview.findings.filter((f) => !review.resolutions[f.id]).length;
  const skipped = preview.findings.filter(
    (f) => f.kind === 'duplicate' && review.resolutions[f.id] === 'accepted',
  ).length;
  const unassigned = preview.files.filter(
    (f) =>
      (f.needsAccount || !f.accountId) &&
      !review.fileAccounts[f.name] &&
      f.rows > 0,
  );
  return {
    open,
    skipped,
    unassigned,
    rows: preview.newTransactions.length - skipped,
  };
}

/** The decisions the server's apply route takes, from a review. */
export function decisionsFor(preview: ImportPreview, review: Review) {
  const accepted = (id: string) => review.resolutions[id] === 'accepted';
  const recategorise: Record<string, string> = {};
  const makeRules: string[] = [];
  for (const f of preview.findings) {
    if (f.kind !== 'low-confidence') continue;
    const tid = f.transactionId;
    if (accepted(f.id)) {
      recategorise[tid] = review.categories[tid] ?? f.suggestedCategoryId;
      if (review.makeRules.includes(tid)) makeRules.push(tid);
    } else if (review.resolutions[f.id] === 'dismissed')
      recategorise[tid] = UNCATEGORIZED;
  }
  return {
    acceptFindings: Object.keys(review.resolutions).filter(accepted),
    dismissFindings: Object.keys(review.resolutions).filter(
      (id) => review.resolutions[id] === 'dismissed',
    ),
    accountForFile: review.fileAccounts,
    recategorise,
    makeRules,
    withholdStrings: review.withheld,
  };
}

export type Decisions = ReturnType<typeof decisionsFor>;
