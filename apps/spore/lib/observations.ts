import type { SqliteDatabase } from './db';
import { normalizeMac } from './ipxe';

export type BootOutcome =
  | 'profile'
  | 'default-profile'
  | 'local-boot'
  | 'unknown-allowed'
  | 'unknown-denied'
  | 'missing-profile'
  | 'legacy-import';

export interface Observation {
  readonly macAddress: string;
  readonly firstSeen: string;
  readonly lastSeen: string;
  readonly bootCount: number;
  readonly lastOutcome: BootOutcome;
  readonly lastProfile: string | null;
}

export interface BootAttempt {
  readonly macAddress: string;
  readonly outcome: BootOutcome;
  readonly profileId: string | null;
}

export interface ObservationRepository {
  recordBootAttempt(attempt: BootAttempt): void;
  getObservation(macAddress: string): Observation | null;
  listObservations(): readonly Observation[];
}

interface ObservationRow {
  mac_address: string;
  first_seen: string;
  last_seen: string;
  boot_count: number;
  last_outcome: BootOutcome;
  last_profile: string | null;
}

function mapObservation(row: ObservationRow): Observation {
  return {
    macAddress: row.mac_address,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    bootCount: row.boot_count,
    lastOutcome: row.last_outcome,
    lastProfile: row.last_profile,
  };
}

export function createObservationRepository(
  database: SqliteDatabase,
  clock: () => Date = () => new Date(),
): ObservationRepository {
  const upsert = database.prepare(`
    INSERT INTO host_observations (
      mac_address, first_seen, last_seen, boot_count, last_outcome, last_profile
    ) VALUES (?, ?, ?, 1, ?, ?)
    ON CONFLICT(mac_address) DO UPDATE SET
      last_seen = excluded.last_seen,
      boot_count = host_observations.boot_count + 1,
      last_outcome = excluded.last_outcome,
      last_profile = excluded.last_profile
  `);
  const get = database.prepare(
    'SELECT * FROM host_observations WHERE mac_address = ?',
  );
  const list = database.prepare(
    'SELECT * FROM host_observations ORDER BY last_seen DESC, mac_address',
  );

  return Object.freeze({
    recordBootAttempt(attempt: BootAttempt): void {
      const macAddress = normalizeMac(attempt.macAddress);
      const observedAt = clock().toISOString();
      upsert.run(
        macAddress,
        observedAt,
        observedAt,
        attempt.outcome,
        attempt.profileId,
      );
    },
    getObservation(macAddress: string): Observation | null {
      const row = get.get(normalizeMac(macAddress)) as
        | ObservationRow
        | undefined;
      return row ? mapObservation(row) : null;
    },
    listObservations(): readonly Observation[] {
      return (list.all() as ObservationRow[]).map(mapObservation);
    },
  });
}
