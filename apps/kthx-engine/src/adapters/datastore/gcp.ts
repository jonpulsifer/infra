/**
 * Datastores in a cloud vessel, over Private Service Connect. Provisioning is
 * not written: `provision` refuses with a stated reason instead of creating an
 * instance nothing on the network could dial.
 */
import type { TargetAdapter } from '../../config/manifest.schema.ts';
import { targetLabel } from '../../domain/target.ts';
import type { DeployTarget } from '../deploy/contract.ts';
import type {
  DatastoreAdapter,
  DatastoreEngine,
  DatastoreRef,
  DatastoreRequest,
  DatastoreState,
} from './contract.ts';

/** Valkey on both backends, so a Datastore keeps its engine when it moves. */
export const GCP_DATASTORE_PRODUCTS = {
  postgres: {
    product: 'Cloud SQL for PostgreSQL',
    endpoint: 'https://sqladmin.googleapis.com',
    collection: 'instances',
  },
  valkey: {
    product: 'Memorystore for Valkey',
    endpoint: 'https://memorystore.googleapis.com',
    collection: 'instances',
  },
} as const satisfies Record<
  DatastoreEngine,
  { product: string; endpoint: string; collection: string }
>;

export const UNIMPLEMENTED =
  'a cloud Datastore is reached over a Private Service Connect endpoint in the ' +
  "vessel's network, and provisioning one against Cloud SQL or Memorystore is " +
  'not written yet';

export class CloudDatastoreUnavailableError extends Error {
  override readonly name = 'CloudDatastoreUnavailableError';

  constructor(target: string) {
    super(`${target}: ${UNIMPLEMENTED}`);
  }
}

export class CloudDatastoreAdapter implements DatastoreAdapter {
  readonly adapter: TargetAdapter = 'cloudrun';
  /** Both: the backend can host them; only provisioning is unwritten. */
  readonly engines: readonly DatastoreEngine[] = ['postgres', 'valkey'];

  async provision(
    target: DeployTarget,
    _request: DatastoreRequest,
  ): Promise<DatastoreRef> {
    throw new CloudDatastoreUnavailableError(targetLabel(target));
  }

  async observe(
    _target: DeployTarget,
    _ref: DatastoreRef,
  ): Promise<DatastoreState | null> {
    return null;
  }

  async destroy(_target: DeployTarget, _ref: DatastoreRef): Promise<void> {}
}
