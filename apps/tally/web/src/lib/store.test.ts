import { describe, expect, test } from 'bun:test';
import type { ImportPreview, Ledger, Transaction } from '~/fixtures/types';
import {
  decisionsFor,
  emptyReview,
  initState,
  liveLedger,
  previewCounts,
  reduce,
} from './store';

const row = (id: string, categoryId = 'food'): Transaction => ({
  id,
  accountId: 'chq',
  date: '2024-03-01',
  amount: -12.5,
  descriptor: `SHOP ${id}`,
  merchant: 'Shop',
  categoryId,
  tags: [],
  transferId: null,
  source: 'rule',
  confidence: null,
  batchId: 'b1',
});

const ledger: Ledger = {
  owner: 'owner@example.com',
  viewers: [],
  accounts: [],
  categories: [],
  transactions: [row('t1'), row('t2')],
  holdings: [],
  valuations: [],
  assertions: [],
  batches: [],
  rules: [],
  asOf: '2024-03-01',
};

const preview: ImportPreview = {
  id: 'p1',
  files: [
    {
      name: 'a.csv',
      format: 'csv',
      institution: 'Test',
      accountId: null,
      rows: 3,
      from: '2024-03-01',
      to: '2024-03-31',
      needsAccount: true,
    },
  ],
  newTransactions: [row('n1'), row('n2'), row('n3')],
  findings: [
    {
      kind: 'duplicate',
      id: 'f1',
      transactionId: 'n1',
      matchesId: 't1',
      reason: 'same amount',
    },
    {
      kind: 'low-confidence',
      id: 'f2',
      transactionId: 'n2',
      suggestedCategoryId: 'fun',
      confidence: 0.5,
    },
    {
      kind: 'low-confidence',
      id: 'f3',
      transactionId: 'n3',
      suggestedCategoryId: 'fun',
      confidence: 0.4,
    },
  ],
  outboundStrings: ['SHOP n2', 'SHOP n3'],
  rulesHit: 1,
  modelCalls: 0,
};

describe('optimistic edits', () => {
  test('a recategorise shows at once and settles to the server row', () => {
    let s = reduce(initState(ledger), {
      type: 'recategorise',
      ids: ['t1'],
      categoryId: 'fun',
    });
    expect(liveLedger(s).transactions[0].categoryId).toBe('fun');
    const server = { ...row('t1', 'fun'), source: 'manual' as const };
    s = reduce(s, { type: 'settle', ids: ['t1'], transactions: [server] });
    expect(s.overrides).toEqual({});
    expect(liveLedger(s).transactions[0]).toEqual(server);
  });

  test('a refused recategorise reverts and says why', () => {
    let s = reduce(initState(ledger), {
      type: 'recategorise',
      ids: ['t1'],
      categoryId: 'fun',
    });
    s = reduce(s, { type: 'revert', ids: ['t1'], error: '403 viewer' });
    expect(liveLedger(s).transactions[0].categoryId).toBe('food');
    expect(s.error).toBe('403 viewer');
  });

  test('a rule is pending until the server names it', () => {
    const temp = {
      id: 'pending-1',
      match: 'SHOP',
      categoryId: 'fun',
      merchant: 'Shop',
      createdFrom: 'correction' as const,
      hits: 2,
    };
    let s = reduce(initState(ledger), {
      type: 'addRule',
      rule: temp,
      ids: ['t1', 't2'],
    });
    expect(liveLedger(s).rules.map((r) => r.id)).toEqual(['pending-1']);
    expect(
      liveLedger(s).transactions.every((t) => t.categoryId === 'fun'),
    ).toBe(true);
    s = reduce(s, {
      type: 'settleRule',
      tempId: 'pending-1',
      rule: { ...temp, id: 'r9' },
    });
    expect(liveLedger(s).rules.map((r) => r.id)).toEqual(['r9']);
    expect(s.freshRules).toEqual(['r9']);
  });

  test('a refused rule takes its rows back with it', () => {
    const temp = {
      id: 'pending-1',
      match: 'SHOP',
      categoryId: 'fun',
      merchant: 'Shop',
      createdFrom: 'correction' as const,
      hits: 2,
    };
    let s = reduce(initState(ledger), {
      type: 'addRule',
      rule: temp,
      ids: ['t1', 't2'],
    });
    s = reduce(s, {
      type: 'revert',
      ids: ['t1', 't2'],
      ruleId: 'pending-1',
      error: 'no',
    });
    expect(liveLedger(s)).toBe(s.base);
    expect(s.freshRules).toEqual([]);
  });
});

describe('the import review', () => {
  const opened = () => reduce(initState(ledger), { type: 'preview', preview });

  test('a file that names no account blocks the commit until assigned', () => {
    let s = opened();
    if (s.imp.phase !== 'review') throw new Error('not reviewing');
    expect(previewCounts(preview, s.imp.review).unassigned).toHaveLength(1);
    s = reduce(s, { type: 'assignFile', name: 'a.csv', accountId: 'chq' });
    if (s.imp.phase !== 'review') throw new Error('not reviewing');
    expect(previewCounts(preview, s.imp.review).unassigned).toHaveLength(0);
  });

  test('decisions carry every choice the review made', () => {
    let s = opened();
    s = reduce(s, { type: 'resolve', id: 'f1', resolution: 'accepted' });
    s = reduce(s, {
      type: 'choose',
      transactionId: 'n2',
      categoryId: 'food',
      rule: true,
    });
    s = reduce(s, { type: 'resolve', id: 'f2', resolution: 'accepted' });
    s = reduce(s, { type: 'resolve', id: 'f3', resolution: 'dismissed' });
    s = reduce(s, { type: 'withhold', value: 'SHOP n3' });
    s = reduce(s, { type: 'assignFile', name: 'a.csv', accountId: 'chq' });
    if (s.imp.phase !== 'review') throw new Error('not reviewing');
    const d = decisionsFor(preview, s.imp.review);
    expect(d.acceptFindings.sort()).toEqual(['f1', 'f2']);
    expect(d.dismissFindings).toEqual(['f3']);
    expect(d.recategorise).toEqual({ n2: 'food', n3: 'uncategorized' });
    expect(d.makeRules).toEqual(['n2']);
    expect(d.withholdStrings).toEqual(['SHOP n3']);
    expect(d.accountForFile).toEqual({ 'a.csv': 'chq' });
    expect(previewCounts(preview, s.imp.review).rows).toBe(2);
  });

  test('an unaccepted choice is not sent', () => {
    let s = opened();
    s = reduce(s, {
      type: 'choose',
      transactionId: 'n2',
      categoryId: 'food',
      rule: true,
    });
    if (s.imp.phase !== 'review') throw new Error('not reviewing');
    const d = decisionsFor(preview, s.imp.review);
    expect(d.recategorise).toEqual({});
    expect(d.makeRules).toEqual([]);
  });

  test('a failed apply returns to the review with its decisions', () => {
    let s = opened();
    s = reduce(s, { type: 'resolve', id: 'f1', resolution: 'accepted' });
    s = reduce(s, { type: 'applying' });
    expect(s.imp.phase).toBe('applying');
    s = reduce(s, { type: 'error', error: '500' });
    expect(s.imp.phase).toBe('review');
    if (s.imp.phase !== 'review') throw new Error('not reviewing');
    expect(s.imp.review.resolutions).toEqual({ f1: 'accepted' });
  });

  test('an empty review sends nothing', () => {
    expect(decisionsFor(preview, emptyReview())).toEqual({
      acceptFindings: [],
      dismissFindings: [],
      accountForFile: {},
      recategorise: {},
      makeRules: [],
      withholdStrings: [],
    });
  });
});
