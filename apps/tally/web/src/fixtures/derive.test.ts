import { describe, expect, test } from 'bun:test';
import {
  accountBalances,
  netWorthSeries,
  topLevel,
  UNCATEGORIZED,
} from './derive';
import { buildLedger } from './generate';
import type { Account, Ledger, Transaction } from './types';

const acct = (id: string, kind: Account['kind']): Account => ({
  id,
  name: id,
  institution: 'Test',
  kind,
  since: '2024-01-01',
});

const txn = (
  id: string,
  accountId: string,
  date: string,
  amount: number,
): Transaction => ({
  id,
  accountId,
  date,
  amount,
  descriptor: 'TEST',
  merchant: 'Test',
  categoryId: 'food',
  tags: [],
  transferId: null,
  source: 'rule',
  confidence: null,
  batchId: 'b1',
});

function tiny(): Ledger {
  return {
    owner: 'owner@example.com',
    viewers: [],
    accounts: [
      acct('chq', 'chequing'),
      acct('card', 'credit'),
      acct('home', 'asset'),
      acct('loan', 'mortgage'),
    ],
    categories: [
      { id: 'food', name: 'Food', parentId: null, flow: 'expense' },
      {
        id: UNCATEGORIZED,
        name: 'Uncategorized',
        parentId: null,
        flow: 'expense',
      },
    ],
    transactions: [
      txn('t1', 'chq', '2024-01-03', 1000.49),
      txn('t2', 'card', '2024-01-09', -0.49),
      txn('t3', 'chq', '2024-02-02', 0.51),
    ],
    holdings: [],
    valuations: [
      {
        accountId: 'home',
        date: '2024-01-01',
        value: 250000.5,
        source: 'purchase',
      },
    ],
    assertions: [
      { accountId: 'loan', date: '2024-01-31', balance: -200000.49, ok: true },
    ],
    batches: [],
    rules: [],
    asOf: '2024-02-02',
  };
}

describe('net worth', () => {
  test('the reader and the accounts screen sum the same cents', () => {
    for (const ledger of [tiny(), buildLedger().ledger]) {
      const last = netWorthSeries(ledger).at(-1);
      const sum = [...accountBalances(ledger).values()].reduce(
        (s, v) => s + v,
        0,
      );
      expect(Math.round((last?.total ?? 0) * 100)).toBe(Math.round(sum * 100));
      expect(Math.round(last?.total ?? 0)).toBe(Math.round(sum));
    }
  });

  test('components add up to the total exactly', () => {
    for (const p of netWorthSeries(tiny())) {
      const cents = Math.round(
        (p.cash + p.investments + p.house + p.mortgage) * 100,
      );
      expect(cents).toBe(Math.round(p.total * 100));
    }
  });

  test('a mortgage is found by kind, not by id', () => {
    const [jan] = netWorthSeries(tiny());
    expect(jan.mortgage).toBe(-200000.49);
    expect(jan.house).toBe(250000.5);
  });

  test('carrying a statement forward marks the month estimated', () => {
    const [jan, feb] = netWorthSeries(tiny());
    expect(jan.estimated).toBe(false);
    expect(feb.estimated).toBe(true);
  });
});

describe('topLevel', () => {
  test('an unknown category reads as uncategorised', () => {
    expect(topLevel(tiny(), 'nope').id).toBe(UNCATEGORIZED);
  });

  test('a ledger with no uncategorised category still answers', () => {
    const ledger = { ...tiny(), categories: [] };
    expect(topLevel(ledger, 'nope').id).toBe(UNCATEGORIZED);
  });
});
