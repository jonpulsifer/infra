/**
 * What is left to connect, and what to propose for it (§13).
 *
 * The manifest seeds Target **identities**: a name, an adapter, and a rank,
 * with connection facts optional. A seed with no connection produces a row
 * whose checklist reads "Target connection has not been configured" and whose
 * `connection` column is null — a real, visible, half-ready state, exactly as
 * §13 intends. What did not exist was any way to finish it from the product:
 * `connectTarget` has always been a command with no screen.
 *
 * This module is the small amount of domain reasoning that screen needs, and
 * it is here rather than in the view for the usual reason — the browser would
 * otherwise be deriving it from connection blobs it has no business holding.
 *
 * Two jobs:
 *
 * 1. **Group Targets back into acts.** Connecting a cloud project registers
 *    both of its Targets (§13), so two unconfigured rows named
 *    `<project>-cloudrun` and `<project>-static` are *one* thing to do, named
 *    `<project>`. A screen listing two cards would reintroduce the second noun
 *    §13 removed.
 * 2. **Propose what can honestly be proposed.** See
 *    {@link TargetConnectionProposal} — carried from a working Target of the
 *    same adapter, never from a literal, and never for a value that is
 *    per-instance.
 */
import type { TargetAdapter } from '../config/manifest.schema.ts';
import type {
  PendingTargetConnection,
  TargetConnectionProposal,
} from '../web/model.ts';
import { CLOUD_ADAPTERS, type TargetConnection } from './target.ts';

/** The columns this reasoning reads, without importing the table. */
export interface OnboardingTargetRow {
  readonly name: string;
  readonly adapter: TargetAdapter;
  readonly connection: TargetConnection | null;
  readonly health: 'healthy' | 'unhealthy';
}

/** The project name behind one of a cloud project's two derived Target names. */
function cloudProjectOf(name: string, adapter: TargetAdapter): string | null {
  const suffix = `-${adapter}`;
  return name.endsWith(suffix) ? name.slice(0, -suffix.length) : null;
}

/**
 * The Target a proposal is carried from.
 *
 * Prefers a healthy one. A configured-but-unhealthy Target's connection facts
 * are the facts of something that does not work, and copying them forward is
 * the fastest way to make one broken Target into two.
 */
function donor(
  rows: readonly OnboardingTargetRow[],
  adapter: TargetAdapter,
): OnboardingTargetRow | undefined {
  const configured = rows.filter(
    (row) => row.adapter === adapter && row.connection !== null,
  );
  return configured.find((row) => row.health === 'healthy') ?? configured[0];
}

function kubernetesProposal(
  rows: readonly OnboardingTargetRow[],
): TargetConnectionProposal {
  const from = donor(rows, 'kubernetes');
  const connection = from?.connection;
  if (connection === undefined || connection?.adapter !== 'kubernetes') {
    return { carriedFrom: null };
  }
  // `apiServer` is deliberately absent. It is the one field here that names a
  // particular cluster, and a second cluster prefilled with the first one's
  // address — `https://kubernetes.default.svc` on an in-cluster install —
  // would read as correct and deploy somewhere else.
  return {
    carriedFrom: from?.name ?? null,
    namespace: connection.namespace,
    deliveryFlavour: connection.delivery.flavour,
    ...(connection.delivery.flavour === 'flux-helmrelease'
      ? { sourceRef: connection.delivery.sourceRef }
      : {}),
    ...(connection.chartContract === undefined
      ? {}
      : { chartContract: connection.chartContract }),
  };
}

function cloudProposal(
  rows: readonly OnboardingTargetRow[],
): TargetConnectionProposal {
  const run = donor(rows, 'cloudrun');
  const runConnection =
    run?.connection?.adapter === 'cloudrun' ? run.connection : null;
  const hosting = donor(rows, 'static');
  const hostingConnection =
    hosting?.connection?.adapter === 'static' ? hosting.connection : null;

  if (runConnection === null && hostingConnection === null) {
    return { carriedFrom: null };
  }
  // `project` is absent for the same reason `apiServer` is: connecting a second
  // cloud project and being handed the first project's id is the one mistake
  // this screen could make that nobody would catch by reading.
  return {
    carriedFrom: run?.name ?? hosting?.name ?? null,
    ...(runConnection === null
      ? {}
      : {
          region: runConnection.region,
          runEndpoint: runConnection.endpoint,
          ...(runConnection.policyEndpoint === undefined
            ? {}
            : { policyEndpoint: runConnection.policyEndpoint }),
        }),
    ...(hostingConnection === null
      ? {}
      : { hostingEndpoint: hostingConnection.endpoint }),
  };
}

/** What a screen would propose for a fresh connect of this shape. */
export function connectionProposal(
  rows: readonly OnboardingTargetRow[],
  kind: 'kubernetes' | 'cloud',
): TargetConnectionProposal {
  return kind === 'kubernetes' ? kubernetesProposal(rows) : cloudProposal(rows);
}

/**
 * Every connect act this installation is waiting on.
 *
 * A Target with a connection is not here however unhealthy it is — an unmet
 * checklist item is something to fix on the Target, not a connection to
 * supply, and §13 keeps those apart on purpose. Only `connection === null`,
 * the state nothing but a manifest seed produces, is an act that is still
 * owed.
 */
export function pendingConnections(
  rows: readonly OnboardingTargetRow[],
): readonly PendingTargetConnection[] {
  const unconfigured = rows.filter((row) => row.connection === null);
  const pending: PendingTargetConnection[] = [];
  const cloudProjects = new Set<string>();

  for (const row of unconfigured) {
    if (row.adapter === 'kubernetes') {
      pending.push({
        kind: 'kubernetes',
        name: row.name,
        targets: [row.name],
        proposal: connectionProposal(rows, 'kubernetes'),
      });
      continue;
    }
    // A cloud Target whose name does not carry its adapter's suffix cannot be
    // reached by `connectTarget`, which derives both names from one project
    // name. Listing it as connectable would offer a button that registers two
    // Targets neither of which is this row.
    const project = cloudProjectOf(row.name, row.adapter);
    if (project === null) continue;
    cloudProjects.add(project);
  }

  for (const project of cloudProjects) {
    pending.push({
      kind: 'cloud',
      name: project,
      // Both names the act will write, whether or not both are unconfigured
      // today: connecting re-registers the pair, and saying so is what stops
      // the confirmation from under-reporting what it is about to touch.
      targets: CLOUD_ADAPTERS.map((adapter) => `${project}-${adapter}`),
      proposal: connectionProposal(rows, 'cloud'),
    });
  }

  return pending;
}
