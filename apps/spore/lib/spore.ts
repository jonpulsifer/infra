import {
  type BootDecisionService,
  createBootDecisionService,
} from './boot-decision';
import { type BootCatalog, loadBootCatalog } from './catalog';
import { openObservationDatabase } from './db';
import {
  createObservationRepository,
  type ObservationRepository,
} from './observations';

export interface Spore {
  readonly catalog: BootCatalog;
  readonly observations: ObservationRepository;
  readonly boot: BootDecisionService;
  health(): void;
}

export interface SporeOptions {
  loadCatalog?: () => BootCatalog;
  createObservations?: () => ObservationRepository;
  onObservationError?: (error: unknown) => void;
}

let spore: Spore | undefined;

function openObservations(): ObservationRepository {
  const database = openObservationDatabase();
  return createObservationRepository(database);
}

const unavailableObservations: ObservationRepository = Object.freeze({
  recordBootAttempt(): void {},
  getObservation(): null {
    return null;
  },
  listObservations(): readonly [] {
    return [];
  },
});

export function createSpore({
  loadCatalog: catalogLoader = loadBootCatalog,
  createObservations: observationFactory = openObservations,
  onObservationError = (error) =>
    console.error('Spore observation database is unavailable', error),
}: SporeOptions = {}): Spore {
  const catalog = catalogLoader();
  let observationError: unknown;
  let observations: ObservationRepository;
  try {
    observations = observationFactory();
  } catch (error) {
    observationError = error;
    onObservationError(error);
    observations = unavailableObservations;
  }
  const boot = createBootDecisionService({ catalog, observations });

  return Object.freeze({
    catalog,
    observations,
    boot,
    health(): void {
      if (observationError !== undefined) {
        throw new Error('Spore observation database is unavailable', {
          cause: observationError,
        });
      }
      // A real read verifies that the migrated observations table is usable.
      observations.listObservations();
    },
  });
}

export function getSpore(): Spore {
  if (spore) return spore;

  spore = createSpore();
  return spore;
}
