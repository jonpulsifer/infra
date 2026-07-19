import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type DatabaseFactory,
  openObservationDatabase,
  parseDatabaseUrl,
} from '../lib/db/index';
import { migrateDatabase } from '../lib/db/migrate';
import { createObservationRepository } from '../lib/observations';

const temporaryDirectories: string[] = [];
const openDatabase: DatabaseFactory = (path, options) =>
  new Database(path, options);

function createRepository(clockValues: string[]) {
  const directory = mkdtempSync(join(tmpdir(), 'spore-observations-test-'));
  temporaryDirectories.push(directory);
  const databaseUrl = `file:${join(directory, 'spore.db')}`;
  migrateDatabase({
    databaseUrl,
    migrationsDir: fileURLToPath(new URL('../migrations', import.meta.url)),
    openDatabase,
  });
  const database = openObservationDatabase(databaseUrl, openDatabase);
  const values = [...clockValues];
  const repository = createObservationRepository(database, () => {
    const next = values.shift();
    if (!next) throw new Error('test clock exhausted');
    return new Date(next);
  });
  return { database, repository };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('database URL parsing', () => {
  test('accepts deliberate file URLs and rejects other database URLs', () => {
    expect(parseDatabaseUrl('file:/var/lib/spore/observations.db')).toBe(
      '/var/lib/spore/observations.db',
    );
    expect(parseDatabaseUrl('file:relative.db')).toBe('relative.db');
    expect(() => parseDatabaseUrl('/raw/path.db')).toThrow(/file:/);
    expect(() => parseDatabaseUrl('postgres://localhost/spore')).toThrow(
      /file:/,
    );
    expect(() => parseDatabaseUrl('file:')).toThrow(/path/);
    expect(() => parseDatabaseUrl('file:test.db?mode=ro')).toThrow(/query/);
  });
});

describe('observation repository', () => {
  test('normalizes and upserts boot timestamps, counts, and outcomes', () => {
    const { database, repository } = createRepository([
      '2026-07-19T12:00:00.000Z',
      '2026-07-19T12:05:00.000Z',
    ]);

    repository.recordBootAttempt({
      macAddress: 'AA-BB-CC-DD-EE-FF',
      outcome: 'profile',
      profileId: 'k8s',
    });
    repository.recordBootAttempt({
      macAddress: 'aabbccddeeff',
      outcome: 'unknown-denied',
      profileId: null,
    });

    expect(repository.getObservation('aa:bb:cc:dd:ee:ff')).toEqual({
      macAddress: 'aa:bb:cc:dd:ee:ff',
      firstSeen: '2026-07-19T12:00:00.000Z',
      lastSeen: '2026-07-19T12:05:00.000Z',
      bootCount: 2,
      lastOutcome: 'unknown-denied',
      lastProfile: null,
    });
    database.close();
  });

  test('lists newest observations first and validates lookup MACs', () => {
    const { database, repository } = createRepository([
      '2026-07-19T12:00:00.000Z',
      '2026-07-19T13:00:00.000Z',
    ]);
    repository.recordBootAttempt({
      macAddress: '00:00:00:00:00:01',
      outcome: 'profile',
      profileId: 'one',
    });
    repository.recordBootAttempt({
      macAddress: '00:00:00:00:00:02',
      outcome: 'local-boot',
      profileId: null,
    });

    expect(
      repository.listObservations().map((item) => item.macAddress),
    ).toEqual(['00:00:00:00:00:02', '00:00:00:00:00:01']);
    expect(repository.getObservation('00-00-00-00-00-03')).toBeNull();
    expect(() => repository.getObservation('not-a-mac')).toThrow(/Invalid MAC/);
    database.close();
  });
});
