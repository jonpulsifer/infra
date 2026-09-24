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
    // Reads return rows in any order, and an order-sensitive hash would make
    // every pass of the loop look like a change.
    expect(await configVersionOf([TOKEN, DSN])).toBe(
      await configVersionOf([DSN, TOKEN]),
    );
  });

  test('a new pinned version is a new configVersion', async () => {
    const repinned = { ...TOKEN, secret: { ...TOKEN.secret, version: '4' } };
    expect(await configVersionOf([repinned])).not.toBe(
      await configVersionOf([TOKEN]),
    );
  });

  test('the empty document has a version', async () => {
    // A Deploy can pin no config, and null already means unrecorded.
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
    // No version means the floating latest, which can hand a workload another
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
    // Two Targets with no store of record share nothing.
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
