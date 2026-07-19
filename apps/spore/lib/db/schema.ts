import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const hostObservations = sqliteTable('host_observations', {
  macAddress: text('mac_address').primaryKey(),
  firstSeen: text('first_seen').notNull(),
  lastSeen: text('last_seen').notNull(),
  bootCount: integer('boot_count').notNull(),
  lastOutcome: text('last_outcome').notNull(),
  lastProfile: text('last_profile'),
});

export const schemaMigrations = sqliteTable('schema_migrations', {
  version: integer('version').primaryKey(),
  name: text('name').notNull(),
  appliedAt: text('applied_at').notNull(),
});
