import { fileURLToPath } from 'node:url';
import { migrateDatabase } from '../lib/db/migrate';

const migrationsDir =
  process.env.SPORE_MIGRATIONS_DIR ??
  fileURLToPath(new URL('../migrations', import.meta.url));

try {
  const result = migrateDatabase({ migrationsDir });
  const applied =
    result.applied.length > 0 ? result.applied.join(', ') : 'none (current)';
  console.log(`Spore database migrations applied: ${applied}`);
  if (result.legacyBackup) {
    console.log(`Legacy Spore database backed up to ${result.legacyBackup}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
