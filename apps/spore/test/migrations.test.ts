import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseFactory } from '../lib/db';
import { migrateDatabase } from '../lib/db/migrate';

const temporaryDirectories: string[] = [];
const migrationsDir = fileURLToPath(new URL('../migrations', import.meta.url));
const openDatabase: DatabaseFactory = (path, options) =>
  new Database(path, options);

function temporaryDatabase() {
  const directory = mkdtempSync(join(tmpdir(), 'spore-migration-test-'));
  temporaryDirectories.push(directory);
  const path = join(directory, 'spore.db');
  return { directory, path, databaseUrl: `file:${path}` };
}

function tableNames(path: string): string[] {
  const database = new Database(path, { readonly: true });
  try {
    return database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all()
      .map((row) => (row as { name: string }).name);
  } finally {
    database.close();
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('database migrations', () => {
  test('creates only observation and migration state for a fresh database', () => {
    const fixture = temporaryDatabase();
    const result = migrateDatabase({
      databaseUrl: fixture.databaseUrl,
      migrationsDir,
      openDatabase,
    });

    expect(result).toEqual({ applied: [1], legacyBackup: null });
    expect(tableNames(fixture.path)).toEqual([
      'host_observations',
      'schema_migrations',
    ]);
  });

  test('is idempotent', () => {
    const fixture = temporaryDatabase();
    migrateDatabase({
      databaseUrl: fixture.databaseUrl,
      migrationsDir,
      openDatabase,
    });
    const second = migrateDatabase({
      databaseUrl: fixture.databaseUrl,
      migrationsDir,
      openDatabase,
    });

    expect(second).toEqual({ applied: [], legacyBackup: null });
    const database = new Database(fixture.path);
    expect(
      database.prepare('SELECT version FROM schema_migrations').all(),
    ).toEqual([{ version: 1 }]);
    database.close();
  });

  test('backs up legacy desired state and imports host observations only', () => {
    const fixture = temporaryDatabase();
    const legacy = new Database(fixture.path);
    legacy.exec(`
      CREATE TABLE profiles (id INTEGER PRIMARY KEY, name TEXT);
      CREATE TABLE scripts (id INTEGER PRIMARY KEY, path TEXT);
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE hosts (
        mac_address TEXT PRIMARY KEY,
        hostname TEXT,
        profile_id INTEGER,
        last_seen TEXT,
        created_at TEXT,
        updated_at TEXT
      );
      INSERT INTO profiles VALUES (7, 'legacy desired state');
      INSERT INTO hosts VALUES (
        'AA-BB-CC-DD-EE-FF', 'legacy-name', 7,
        '2026-01-02T03:04:05.000Z',
        '2025-01-01T00:00:00.000Z',
        '2026-01-02T03:04:05.000Z'
      );
    `);
    legacy.close();

    const result = migrateDatabase({
      databaseUrl: fixture.databaseUrl,
      migrationsDir,
      now: () => new Date('2026-07-19T12:00:00.000Z'),
      openDatabase,
    });

    expect(result.applied).toEqual([1]);
    expect(result.legacyBackup).toBe(
      `${fixture.path}.legacy-20260719T120000000Z.db`,
    );
    expect(tableNames(fixture.path)).toEqual([
      'host_observations',
      'schema_migrations',
    ]);

    const active = new Database(fixture.path);
    expect(active.prepare('SELECT * FROM host_observations').get()).toEqual({
      mac_address: 'aa:bb:cc:dd:ee:ff',
      first_seen: '2026-01-02T03:04:05.000Z',
      last_seen: '2026-01-02T03:04:05.000Z',
      boot_count: 1,
      last_outcome: 'legacy-import',
      last_profile: null,
    });
    active.close();

    expect(tableNames(result.legacyBackup!)).toContain('profiles');
    const backup = new Database(result.legacyBackup!, { readonly: true });
    expect(backup.prepare('SELECT name FROM profiles').get()).toEqual({
      name: 'legacy desired state',
    });
    backup.close();
  });

  test('rolls back a failed numbered migration without damaging the database', () => {
    const fixture = temporaryDatabase();
    const brokenDir = join(fixture.directory, 'migrations');
    mkdirSync(brokenDir);
    writeFileSync(
      join(brokenDir, '0001_observations.sql'),
      readFileSync(join(migrationsDir, '0001_observations.sql'), 'utf8'),
    );
    writeFileSync(
      join(brokenDir, '0002_broken.sql'),
      'CREATE TABLE should_rollback (id INTEGER); THIS IS NOT SQL;',
    );

    expect(() =>
      migrateDatabase({
        databaseUrl: fixture.databaseUrl,
        migrationsDir: brokenDir,
        openDatabase,
      }),
    ).toThrow(/0002_broken/);

    expect(tableNames(fixture.path)).not.toContain('should_rollback');
    const database = new Database(fixture.path);
    expect(
      database.prepare('SELECT version FROM schema_migrations').all(),
    ).toEqual([{ version: 1 }]);
    database.close();
  });
});
