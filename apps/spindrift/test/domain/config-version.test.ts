/**
 * `configVersion`, and the three ways a hash over pinned references goes wrong
 * without anything noticing (Task 30, §10).
 *
 * Each test here is a property the deploy path depends on: the loop compares
 * versions to decide whether a Deploy is a change, so a hash that is unstable
 * deploys forever and a hash that is too stable never deploys at all.
 */
import { describe, expect, test } from 'bun:test';
import {
  keysThatWillNotFollow,
  reapable,
  sharesStoreOfRecord,
  storeOfRecordFor,
} from '../../src/domain/config.ts';
import {
  canonicalConfigDocument,
  configVersionOf,
  documentOf,
} from '../../src/domain/config-version.ts';

const TOKEN = { name: 'TOKEN', secret: { key: 'item/token', version: '3' } };
const DSN = { name: 'DSN', secret: { key: 'item/dsn', version: '1' } };

describe('the hash is over references, in one order', () => {
  test('row order does not change the version', async () => {
    // Two reads of the same config can come back in either order; a version
    // that disagreed would make every pass of the loop look like a change.
    expect(await configVersionOf([TOKEN, DSN])).toBe(
      await configVersionOf([DSN, TOKEN]),
    );
  });

  test('a new pinned version is a new configVersion', async () => {
    // The whole point (§10): a config change must produce a new Deploy rather
    // than silently not applying.
    const repinned = { ...TOKEN, secret: { ...TOKEN.secret, version: '4' } };
    expect(await configVersionOf([repinned])).not.toBe(
      await configVersionOf([TOKEN]),
    );
  });

  test('the empty document has a version', async () => {
    // "No config" is a state a Deploy is pinned to, and a rollback to it has to
    // be able to say so. A null here would be indistinguishable from unrecorded.
    expect(await configVersionOf([])).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test('canonicalization keeps only the reference', () => {
    const canonical = canonicalConfigDocument([
      { ...TOKEN, extra: 'ignored' } as never,
    ]);
    expect(canonical).toEqual([TOKEN]);
  });
});

describe('a half-written pin is dropped, never delivered', () => {
  test('a row with no version does not become an entry', () => {
    // An entry naming an item with no version is the floating latest §10
    // forbids; delivering it is how a workload ends up holding another
    // release's secret.
    expect(
      documentOf([
        { key: 'TOKEN', storeRef: 'item/token', storeVersion: null },
      ]),
    ).toEqual([]);
  });
});

describe('the store of record is a Target property', () => {
  const writable = (adapter: string) => adapter !== 'gcp-secret-manager';

  test('the installation store wins where the Target reaches it', () => {
    expect(
      storeOfRecordFor(
        ['onepassword', 'gcp-secret-manager'],
        () => true,
        'gcp-secret-manager',
      ),
    ).toBe('gcp-secret-manager');
  });

  test('a Target that reaches nothing writable has none', () => {
    expect(
      storeOfRecordFor(['gcp-secret-manager'], writable, 'gcp-secret-manager'),
    ).toBeNull();
  });

  test('two Targets in front of one vault share it', () => {
    expect(sharesStoreOfRecord('onepassword', 'onepassword')).toBe(true);
    expect(sharesStoreOfRecord('onepassword', 'gcp-secret-manager')).toBe(
      false,
    );
    // No store of record is not the same as sharing one.
    expect(sharesStoreOfRecord(null, null)).toBe(false);
  });
});

describe('what a move demands', () => {
  test('nothing, when the store is shared', () => {
    expect(
      keysThatWillNotFollow({
        configured: ['TOKEN', 'DSN'],
        alreadyAtDestination: [],
        sharesStore: true,
      }),
    ).toEqual([]);
  });

  test('every key that is not already there, when it is not', () => {
    expect(
      keysThatWillNotFollow({
        configured: ['TOKEN', 'DSN'],
        alreadyAtDestination: ['DSN'],
        sharesStore: false,
      }),
    ).toEqual(['TOKEN']);
  });
});

describe('retention keeps the depth a rollback can reach', () => {
  test('the newest N survive, in the order the store gave them', () => {
    const versions = [5, 4, 3, 2, 1].map((n) => ({
      reference: { key: 'item/token', version: String(n) },
      key: 'TOKEN',
      createdAt: new Date(n),
    }));
    expect(reapable(versions, 2).map((v) => v.reference.version)).toEqual([
      '3',
      '2',
      '1',
    ]);
  });
});
