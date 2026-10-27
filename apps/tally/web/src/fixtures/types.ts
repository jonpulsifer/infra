// The app's in-memory nouns. src/tally/model.py is the server's side of the
// same nouns; src/api/client.ts adapts its camelCase JSON into these.

export type AccountKind =
  | 'chequing'
  | 'savings'
  | 'credit'
  | 'mortgage'
  | 'investment'
  | 'asset';

export type Account = {
  id: string;
  name: string;
  institution: string;
  kind: AccountKind;
  /** ISO date the account's history starts in the ledger. */
  since: string;
};

export type Category = {
  id: string;
  name: string;
  parentId: string | null;
  /** 'income' | 'expense' | 'transfer' at the top level. */
  flow: 'income' | 'expense' | 'transfer';
};

export type Transaction = {
  id: string;
  accountId: string;
  /** ISO date, posted. */
  date: string;
  /** Signed CAD. Negative leaves the account. */
  amount: number;
  /** What the bank printed. */
  descriptor: string;
  /** Normalised merchant name. */
  merchant: string;
  categoryId: string;
  tags: string[];
  /** Both legs of a transfer share this id. */
  transferId: string | null;
  /** How the category was set. */
  source: 'rule' | 'model' | 'manual';
  /** 0..1 when source is 'model'. */
  confidence: number | null;
  batchId: string;
  /** The institution's id. A dedupe hint only. */
  fitid?: string | null;
  pending?: boolean;
};

export type Position = {
  symbol: string;
  name: string;
  quantity: number;
  price: number;
  marketValue: number;
  bookCost: number;
};

export type HoldingSnapshot = {
  accountId: string;
  date: string;
  positions: Position[];
  total: number;
  /** Where the snapshot came from. */
  origin: 'statement-pdf' | 'export';
};

export type Valuation = {
  accountId: string;
  date: string;
  value: number;
  source: 'purchase' | 'assessment' | 'estimate';
};

export type BalanceAssertion = {
  accountId: string;
  date: string;
  balance: number;
  /** Whether the ledger's running total agrees. */
  ok: boolean;
  /** Which file or statement said so. */
  origin?: string;
};

export type ImportBatch = {
  id: string;
  importedAt: string;
  files: number;
  rows: number;
  note: string;
};

export type Rule = {
  id: string;
  /** Case-insensitive substring or regex over the descriptor. */
  match: string;
  categoryId: string;
  merchant: string;
  createdFrom: 'correction' | 'seed' | 'model';
  hits: number;
  accountId?: string | null;
};

// Import preview: the shape the review screen reacts to.

export type PreviewFile = {
  name: string;
  format: 'csv' | 'qfx' | 'ofx' | 'pdf' | 'xlsx';
  institution: string;
  accountId: string | null;
  rows: number;
  from: string;
  to: string;
  /** For PDFs: page count and whether OCR is needed. */
  pages?: number;
  scanned?: boolean;
  /** A CSV that names no account: the import asks which one. */
  needsAccount?: boolean;
  /** The account kind the file declares, for an account the import creates. */
  accountKind?: AccountKind | null;
};

export type Finding =
  | {
      kind: 'duplicate';
      id: string;
      transactionId: string;
      matchesId: string;
      reason: string;
      tier?: 'fitid' | 'fuzzy';
    }
  | {
      kind: 'missing-period';
      id: string;
      accountId: string;
      from: string;
      to: string;
      expectedBalance: number;
      actualBalance: number;
    }
  | {
      kind: 'transfer';
      id: string;
      outId: string;
      inId: string;
      daysApart: number;
      /** Unique on both sides, so paired without asking. */
      auto?: boolean;
    }
  | {
      kind: 'low-confidence';
      id: string;
      transactionId: string;
      suggestedCategoryId: string;
      confidence: number;
    };

export type ImportPreview = {
  id: string;
  files: PreviewFile[];
  newTransactions: Transaction[];
  findings: Finding[];
  /** Exactly what would be sent to the model, nothing else. */
  outboundStrings: string[];
  rulesHit: number;
  modelCalls: number;
  /** Statement snapshots and balances the files carry, folded in on apply. */
  holdings?: HoldingSnapshot[];
  assertions?: BalanceAssertion[];
};

export type Ledger = {
  owner: string;
  viewers: string[];
  accounts: Account[];
  categories: Category[];
  transactions: Transaction[];
  holdings: HoldingSnapshot[];
  valuations: Valuation[];
  assertions: BalanceAssertion[];
  batches: ImportBatch[];
  rules: Rule[];
  /** Last day of data. */
  asOf: string;
};
