/**
 * `probeCluster`: read a cluster's namespaces, chart sources and gateways
 * before connecting it. Writes nothing; an unreachable cluster still connects.
 */
import { z } from 'zod';
import type { ClusterProbe } from '../../adapters/deploy/contract.ts';
import { connectionProposal } from '../../domain/target-onboarding.ts';
import { type Command, failed, ok } from '../types.ts';
import type { TargetConnectionProposal } from '../views.ts';

export const probeClusterInput = z
  .object({
    apiServer: z.url(),
  })
  .strict();

export type ProbeClusterInput = z.infer<typeof probeClusterInput>;

export interface ProbeClusterResult {
  readonly probe: ClusterProbe;
  /** Values lent by an existing Target, kept apart from what the cluster said. */
  readonly proposal: TargetConnectionProposal;
}

export const probeCluster: Command<
  ProbeClusterInput,
  ProbeClusterResult
> = async (input, context) => {
  // The probe presents the controller's own token to `apiServer`.
  if (context.principal.kind !== 'human') {
    return failed(
      'FORBIDDEN',
      'an agent token cannot probe a cluster — sign in and connect it from Targets',
    );
  }

  const adapter = context.adapters.deploy('kubernetes');
  if (adapter?.probe === undefined) {
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
