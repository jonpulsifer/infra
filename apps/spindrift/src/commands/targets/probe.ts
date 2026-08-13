/**
 * `probeCluster` — read a cluster before it is a Target (§13).
 *
 * The repository screen settled this shape already: "press Connect, read what
 * it found, confirm." Connecting a repository stopped being a form about how
 * deployment works the moment detection did the reading, and a Target's connect
 * form has the same problem in the same place — an operator was being asked to
 * type a namespace, a `GitRepository` name, a gateway, and a load-balancer
 * address, every one of which the cluster can be asked for.
 *
 * So this is the Target-side `inspectRepository`: **it writes nothing**, it
 * answers with lists rather than with a verdict, and what comes back is what a
 * screen offers as choices. The act that follows it is `connectTarget`, exactly
 * as `connectRepository` follows the repository scan.
 *
 * Two things it deliberately is not:
 *
 * - **Not a reachability gate.** §13's connect always succeeds and its health
 *   is a standing checklist; a probe that could refuse would be the second
 *   opinion §13 does not have. A cluster that answers nothing still connects,
 *   and the checklist afterwards says why it is unhealthy.
 * - **Not a source of defaults.** Everything here was read off *this* cluster.
 *   What is carried from another Target arrives beside it as a
 *   {@link TargetConnectionProposal}, kept separate so a screen can say which
 *   of the two a value came from — §3's grammar, applied to a form field.
 */
import { z } from 'zod';
import type { ClusterProbe } from '../../adapters/deploy/contract.ts';
import { connectionProposal } from '../../domain/target-onboarding.ts';
import { type Command, failed, ok } from '../types.ts';
import type { TargetConnectionProposal } from '../views.ts';

export const probeClusterInput = z
  .object({
    /** The only fact a probe needs. No Target row exists yet to read one from. */
    apiServer: z.url(),
  })
  .strict();

export type ProbeClusterInput = z.infer<typeof probeClusterInput>;

export interface ProbeClusterResult {
  /** What this cluster said about itself. */
  readonly probe: ClusterProbe;
  /** What a Target this installation already has would lend (§13). */
  readonly proposal: TargetConnectionProposal;
}

export const probeCluster: Command<
  ProbeClusterInput,
  ProbeClusterResult
> = async (input, context) => {
  const adapter = context.adapters.deploy('kubernetes');
  if (adapter?.probe === undefined) {
    // §3's disabled-with-reasons grammar rather than a new failure code: an
    // installation without the cluster adapter cannot deploy to a cluster, and
    // that is the fact the operator is being told.
    return failed(
      'NOT_DEPLOYABLE',
      'this installation has no Kubernetes adapter to read a cluster with',
    );
  }

  const rows = await context.db.query.targets.findMany({
    with: { vessel: true },
  });
  return ok({
    probe: await adapter.probe(input.apiServer),
    proposal: connectionProposal(rows, 'cluster'),
  });
};
