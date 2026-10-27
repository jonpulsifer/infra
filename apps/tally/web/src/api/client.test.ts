import { describe, expect, test } from 'bun:test';
import { ledgerFromWire, previewFromWire } from './client';

const wireLedger = {
  id: 'l1',
  members: [
    { login: 'owner@example.com', role: 'owner' },
    { login: 'viewer@example.com', role: 'viewer' },
  ],
  accounts: [
    {
      id: 'chq',
      name: 'Chequing',
      institution: 'Test',
      kind: 'chequing',
      since: '2024-01-01',
      currency: 'CAD',
    },
  ],
  categories: [{ id: 'food', name: 'Food', parentId: null, flow: 'expense' }],
  transactions: [
    {
      id: 't1',
      accountId: 'chq',
      date: '2024-01-05',
      amount: '-12.34',
      descriptor: 'SHOP 1',
      merchant: 'Shop',
      categoryId: 'food',
      tags: [],
      transferId: null,
      source: 'rule',
      confidence: null,
      batchId: 'b1',
      fitid: 'F1',
      pending: false,
    },
    {
      id: 't2',
      accountId: 'chq',
      date: '2024-02-05',
      amount: '100.00',
      descriptor: 'PAY',
      merchant: 'Pay',
      categoryId: 'food',
      batchId: 'b1',
    },
  ],
  assertions: [
    { accountId: 'chq', date: '2024-01-31', balance: '500.00', origin: 'a' },
    { accountId: 'chq', date: '2024-02-29', balance: '600.00', origin: 'b' },
    { accountId: 'chq', date: '2024-03-31', balance: '650.00', origin: 'c' },
  ],
  batches: [
    {
      id: 'b1',
      importedAt: '2024-03-01T10:00:00Z',
      files: 1,
      rows: 2,
      note: '',
    },
  ],
};

describe('ledgerFromWire', () => {
  const l = ledgerFromWire(wireLedger);

  test('decimals arrive as strings and leave as numbers', () => {
    expect(l.transactions[0].amount).toBe(-12.34);
    expect(l.transactions[1].tags).toEqual([]);
  });

  test('members become an owner and viewers', () => {
    expect(l.owner).toBe('owner@example.com');
    expect(l.viewers).toEqual(['viewer@example.com']);
  });

  test('asOf is the last row when the server does not send it', () => {
    expect(l.asOf).toBe('2024-02-05');
  });

  test('statements are checked against the rows between them', () => {
    expect(l.assertions.map((a) => a.ok)).toEqual([true, true, false]);
  });

  test('a datetime is cut to its day', () => {
    expect(l.batches[0].importedAt).toBe('2024-03-01');
  });
});

describe('previewFromWire', () => {
  const body = {
    files: [
      {
        name: 'a.csv',
        format: 'csv',
        institution: null,
        accountId: null,
        rows: 1,
        dateFrom: '2024-01-01',
        dateTo: '2024-01-31',
        pages: null,
        scanned: null,
        needsAccount: true,
      },
    ],
    newTransactions: [],
    findings: [
      {
        kind: 'missing-period',
        id: 'f1',
        accountId: 'chq',
        dateFrom: '2024-01-01',
        dateTo: '2024-01-31',
        expectedBalance: '10.00',
        actualBalance: '9.50',
      },
      { kind: 'something-new', id: 'f2' },
    ],
    outboundStrings: ['SHOP 1'],
    rulesHit: 0,
    modelCalls: 0,
  };

  test('flat with an id, or wrapped, read the same', () => {
    const flat = previewFromWire({ id: 'p1', ...body });
    const wrapped = previewFromWire({ id: 'p1', preview: body });
    expect(wrapped).toEqual(flat);
    expect(flat.id).toBe('p1');
  });

  test('server field names map onto the app', () => {
    const p = previewFromWire({ id: 'p1', ...body });
    expect(p.files[0]).toMatchObject({
      from: '2024-01-01',
      to: '2024-01-31',
      institution: '',
      needsAccount: true,
    });
    expect(p.findings).toEqual([
      {
        kind: 'missing-period',
        id: 'f1',
        accountId: 'chq',
        from: '2024-01-01',
        to: '2024-01-31',
        expectedBalance: 10,
        actualBalance: 9.5,
      },
    ]);
  });
});
