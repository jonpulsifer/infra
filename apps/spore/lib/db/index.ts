import Database from 'better-sqlite3';

export interface SqliteStatement {
  run(...parameters: unknown[]): unknown;
  get(...parameters: unknown[]): unknown;
  all(...parameters: unknown[]): unknown[];
}

export interface SqliteDatabase {
  readonly open?: boolean;
  exec(sql: string): unknown;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

export type DatabaseFactory = (
  path: string,
  options?: { readonly?: boolean },
) => SqliteDatabase;

export const betterSqliteDatabase: DatabaseFactory = (path, options) =>
  new Database(path, options);

export function parseDatabaseUrl(databaseUrl: string): string {
  if (!databaseUrl.startsWith('file:')) {
    throw new Error('DATABASE_URL must use the file: scheme');
  }
  const path = databaseUrl.slice('file:'.length);
  if (!path) {
    throw new Error('DATABASE_URL file: scheme must include a path');
  }
  if (path.includes('?') || path.includes('#')) {
    throw new Error('DATABASE_URL must not include a query or fragment');
  }
  return path;
}

export function openObservationDatabase(
  databaseUrl = process.env.DATABASE_URL ?? 'file:spore.db',
  openDatabase: DatabaseFactory = betterSqliteDatabase,
): SqliteDatabase {
  const database = openDatabase(parseDatabaseUrl(databaseUrl));
  database.exec('PRAGMA journal_mode = WAL');
  database.exec('PRAGMA busy_timeout = 5000');
  database.exec('PRAGMA foreign_keys = ON');
  return database;
}
