import { randomUUID } from 'node:crypto';
import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { normalizeMac } from '../ipxe';
import {
  betterSqliteDatabase,
  type DatabaseFactory,
  parseDatabaseUrl,
  type SqliteDatabase,
} from './index';

interface Migration {
  version: number;
  name: string;
  sql: string;
}

export interface MigrationOptions {
  databaseUrl?: string;
  migrationsDir: string;
  now?: () => Date;
  openDatabase?: DatabaseFactory;
}

export interface MigrationResult {
  applied: number[];
  legacyBackup: string | null;
}

function migrationsAt(directory: string): Migration[] {
  return readdirSync(directory)
    .filter((name) => /^\d{4}_[a-z0-9_-]+\.sql$/.test(name))
    .sort()
    .map((name) => ({
      version: Number.parseInt(name.slice(0, 4), 10),
      name,
      sql: readFileSync(join(directory, name), 'utf8'),
    }));
}

function tableExists(database: SqliteDatabase, name: string): boolean {
  return (
    database
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name) != null
  );
}

function applyMigrations(
  database: SqliteDatabase,
  directory: string,
  now: () => Date,
): number[] {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);
  const appliedVersions = new Set(
    (
      database.prepare('SELECT version FROM schema_migrations').all() as Array<{
        version: number;
      }>
    ).map(({ version }) => version),
  );
  const applied: number[] = [];

  for (const migration of migrationsAt(directory)) {
    if (appliedVersions.has(migration.version)) continue;

    database.exec('BEGIN IMMEDIATE');
    try {
      database.exec(migration.sql);
      database
        .prepare(
          'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
        )
        .run(migration.version, migration.name, now().toISOString());
      database.exec('COMMIT');
      applied.push(migration.version);
    } catch (error) {
      database.exec('ROLLBACK');
      throw new Error(`Failed to apply migration ${migration.name}`, {
        cause: error,
      });
    }
  }
  return applied;
}

function legacyBackupName(path: string, now: Date): string {
  const timestamp = now.toISOString().replace(/[-:.]/g, '');
  return `${path}.legacy-${timestamp}.db`;
}

function migrateLegacyDatabase(
  databasePath: string,
  directory: string,
  now: () => Date,
  openDatabase: DatabaseFactory,
): MigrationResult {
  const backupPath = legacyBackupName(databasePath, now());
  const legacy = openDatabase(databasePath);
  try {
    legacy.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    legacy.prepare('VACUUM INTO ?').run(backupPath);
  } finally {
    legacy.close();
  }

  const temporaryPath = `${databasePath}.migrating-${randomUUID()}`;
  let replacement: SqliteDatabase | null = null;
  let backup: SqliteDatabase | null = null;
  try {
    replacement = openDatabase(temporaryPath);
    const applied = applyMigrations(replacement, directory, now);
    backup = openDatabase(backupPath, { readonly: true });
    const legacyRows = backup
      .prepare('SELECT mac_address, last_seen FROM hosts')
      .all() as Array<{ mac_address: string; last_seen: string | null }>;
    const insert = replacement.prepare(`
      INSERT INTO host_observations (
        mac_address, first_seen, last_seen, boot_count, last_outcome, last_profile
      ) VALUES (?, ?, ?, ?, 'legacy-import', NULL)
    `);
    replacement.exec('BEGIN IMMEDIATE');
    try {
      for (const row of legacyRows) {
        const observedAt = row.last_seen ?? now().toISOString();
        insert.run(
          normalizeMac(row.mac_address),
          observedAt,
          observedAt,
          row.last_seen ? 1 : 0,
        );
      }
      replacement.exec('COMMIT');
    } catch (error) {
      replacement.exec('ROLLBACK');
      throw error;
    }
    backup.close();
    backup = null;
    replacement.close();
    replacement = null;
    renameSync(temporaryPath, databasePath);
    return { applied, legacyBackup: backupPath };
  } catch (error) {
    backup?.close();
    replacement?.close();
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    throw new Error(
      `Failed to convert legacy Spore database; original remains at ${databasePath} and backup remains at ${backupPath}`,
      { cause: error },
    );
  }
}

export function migrateDatabase(options: MigrationOptions): MigrationResult {
  const databaseUrl =
    options.databaseUrl ?? process.env.DATABASE_URL ?? 'file:spore.db';
  const databasePath = parseDatabaseUrl(databaseUrl);
  const now = options.now ?? (() => new Date());
  const openDatabase = options.openDatabase ?? betterSqliteDatabase;

  if (existsSync(databasePath)) {
    const current = openDatabase(databasePath, { readonly: true });
    let isLegacy: boolean;
    try {
      isLegacy =
        tableExists(current, 'hosts') &&
        !tableExists(current, 'host_observations');
    } finally {
      current.close();
    }
    if (isLegacy) {
      return migrateLegacyDatabase(
        databasePath,
        options.migrationsDir,
        now,
        openDatabase,
      );
    }
  }

  const database = openDatabase(databasePath);
  try {
    database.exec('PRAGMA busy_timeout = 5000');
    const applied = applyMigrations(database, options.migrationsDir, now);
    return { applied, legacyBackup: null };
  } finally {
    database.close();
  }
}
