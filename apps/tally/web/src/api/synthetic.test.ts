import { describe, expect, test } from 'bun:test';
import { decisionsFor, emptyReview } from '~/lib/store';
import { syntheticApi } from './synthetic';

describe('the synthetic api', () => {
  test('a pending preview is waiting and its rows are not yet in the ledger', async () => {
    const api = syntheticApi();
    expect(api.pendingPreviewId).not.toBeNull();
    const preview = await api.getPreview(api.pendingPreviewId ?? '');
    const ledger = await api.ledger();
    const ids = new Set(ledger.transactions.map((t) => t.id));
    expect(preview.newTransactions.length).toBeGreaterThan(0);
    expect(preview.newTransactions.some((t) => ids.has(t.id))).toBe(false);
  });

  test('applying skips accepted duplicates and adds the rest', async () => {
    const api = syntheticApi();
    const id = api.pendingPreviewId ?? '';
    const preview = await api.getPreview(id);
    const before = (await api.ledger()).transactions.length;
    const review = emptyReview();
    const dups = preview.findings.filter((f) => f.kind === 'duplicate');
    for (const f of dups) review.resolutions[f.id] = 'accepted';
    const { ledger, batch } = await api.applyPreview(
      id,
      decisionsFor(preview, review),
    );
    const added = preview.newTransactions.length - dups.length;
    expect(ledger.transactions.length).toBe(before + added);
    expect(batch?.rows).toBe(added);
    await expect(api.getPreview(id)).rejects.toThrow('404');
  });

  test('a rule refiles the rows it matches and says which', async () => {
    const api = syntheticApi();
    const ledger = await api.ledger();
    const t = ledger.transactions.find((x) => !x.transferId);
    if (!t) throw new Error('no row');
    const match = t.descriptor.split(' ')[0];
    const { rule, moved } = await api.createRule({
      match,
      categoryId: 'uncategorized',
      merchant: t.merchant,
    });
    expect(rule.match).toBe(match);
    expect(moved?.length).toBeGreaterThan(0);
    expect(moved?.every((m) => m.categoryId === 'uncategorized')).toBe(true);
  });

  test('every call answers from a copy, so callers cannot mutate it', async () => {
    const api = syntheticApi();
    const a = await api.ledger();
    a.transactions.length = 0;
    expect((await api.ledger()).transactions.length).toBeGreaterThan(0);
  });
});
