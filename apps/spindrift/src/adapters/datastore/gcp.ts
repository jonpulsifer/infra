/**
 * Datastores in a cloud vessel — Cloud SQL and Memorystore (§11, §14).
 *
 * **This adapter refuses every verb, deliberately, and the refusal is the
 * finding.** It exists because the contract had to be tried against a second
 * backend before the first one's shape became a rule, and the two things it
 * turned up are worth more than an implementation that could not be reached
 * from here anyway:
 *
 * 1. **The contract survives.** Both products are one create call returning a
 *    long-running operation, then an instance with a readable `state` — which is
 *    `provision` returning a ref and core polling `observe`, unchanged. Neither
 *    needs a stream, a watch, or a fourth verb. `connection` is a `secret://`
 *    reference into the vessel's Secret Manager, the same shape the cluster
 *    adapter reports for CloudNativePG.
 * 2. **The Target is the wrong noun to hang this on.** A Datastore is placed on
 *    a Target (§11: "delivery follows the Datastore's placement"), but what a
 *    Cloud SQL instance actually lives in is the **vessel** — the project and its
 *    VPC — not the Cloud Run surface on it. Two Cloud Run Targets in one project
 *    would each provision into the same place, and a `static` Target has no
 *    runtime at all, so a Datastore placed on one is a Datastore nothing can
 *    reach. On a cluster the two nouns coincide and the distinction stayed
 *    invisible.
 *
 * The fact this file used to be short of exists now: a `gcp-project` vessel
 * carries its `network` on `GcpProjectLocation` (`domain/vessel.ts`), seeded
 * from the installation manifest like every other boundary fact (§20), and
 * Terraform's two service connection policies authorize each producer to
 * create its endpoint in it. Both products are reached over Private Service
 * Connect:
 *
 * - **Cloud SQL** — `sqladmin.googleapis.com`, `POST /v1/projects/{project}/
 *   instances` with `settings.ipConfiguration.pscConfig.pscEnabled` and no
 *   public IP. The instance answers with a `pscServiceAttachmentLink`, and the
 *   endpoint in front of it is a second, separate create against Compute.
 * - **Memorystore for Valkey** — `memorystore.googleapis.com`,
 *   `POST /v1/projects/{project}/locations/{location}/instances` with
 *   `pscAutoConnections` naming the consumer network. PSC-native: the producer
 *   creates the endpoint, so this half is one call rather than two.
 *
 * What remains missing is this file's own implementation: `provision`,
 * `observe` and `destroy` written against those two APIs — a separate decision
 * about whether the capability is wanted, which this file is not making. Until
 * it is, every verb answers with one sentence rather than half-provisioning an
 * instance nothing on the VPC could dial. §13's grammar for a Target that
 * cannot do a thing: a stated reason, never a silent failure.
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

/**
 * The managed product behind each engine, and the API it is created through.
 *
 * Here rather than in a comment because it is the half of this adapter that is
 * settled: whoever finishes it writes against these two roots, and the choice
 * between Memorystore for Valkey and Memorystore for Redis Cluster is already
 * made — the cluster adapter runs Valkey too, and a Datastore that
 * changed engine implementation when it moved backends would break §11's
 * promise that the two provenances differ "only in who authors the URL".
 */
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

/**
 * The gap this adapter refuses over, as the sentence an operator reads.
 *
 * A constant so the three verbs cannot drift into three different explanations
 * of the same gap — and so a test can assert that the refusal names what is
 * missing rather than merely refusing.
 */
export const UNIMPLEMENTED =
  'a cloud Datastore is reached over a Private Service Connect endpoint in the ' +
  "vessel's network, and provisioning one against Cloud SQL or Memorystore is " +
  'not written yet';

/** Raised by every verb, with {@link UNIMPLEMENTED} as its message. */
export class CloudDatastoreUnavailableError extends Error {
  override readonly name = 'CloudDatastoreUnavailableError';

  constructor(target: string) {
    super(`${target}: ${UNIMPLEMENTED}`);
  }
}

export class CloudDatastoreAdapter implements DatastoreAdapter {
  readonly adapter: TargetAdapter = 'cloudrun';
  /**
   * Both, and stated honestly rather than emptied to make the refusal quieter.
   *
   * Placement reads this to answer "could this backend ever host that engine",
   * and the answer is yes — what it cannot do is host one *today*. An empty list
   * would make a Datastore on a cloud Target look like a modelling error rather
   * than an unfinished path, which is the wrong thing to teach a reader.
   */
  readonly engines: readonly DatastoreEngine[] = ['postgres', 'valkey'];

  async provision(
    target: DeployTarget,
    _request: DatastoreRequest,
  ): Promise<DatastoreRef> {
    throw new CloudDatastoreUnavailableError(targetLabel(target));
  }

  /**
   * `null`, not a throw.
   *
   * The contract's `null` means "nothing is there", which is the literally true
   * answer: nothing was ever provisioned. Throwing here would make a reconciler
   * sweep over every Datastore fail on a cloud one it should simply skip.
   */
  async observe(
    _target: DeployTarget,
    _ref: DatastoreRef,
  ): Promise<DatastoreState | null> {
    return null;
  }

  /** Idempotent by vacuum: there is nothing to destroy. */
  async destroy(_target: DeployTarget, _ref: DatastoreRef): Promise<void> {}
}
