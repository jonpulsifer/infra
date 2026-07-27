/**
 * drizzle-kit configuration: reads `src/db/schema.ts`, writes migrations to
 * `src/db/migrations/`. Only `drizzle-kit generate` is expected to run
 * against this file directly — the app itself never imports it.
 */
import { defineConfig } from 'drizzle-kit';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    'DATABASE_URL is not set: drizzle-kit needs it to introspect the target database',
  );
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  dbCredentials: {
    url: databaseUrl,
  },
});
