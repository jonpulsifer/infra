/**
 * The installation a test runs as.
 *
 * §20's extraction contract puts every installation-naming value in the
 * manifest, and `CommandContext` carries one so no command has to read a
 * module-level singleton. That makes "which installation" a per-test choice, and
 * this is where tests make it: the fixture manifest, parsed through the real
 * loader so a schema change that the fixture does not satisfy fails here rather
 * than only in production.
 *
 * `targetValues` exists for the same reason in the other direction. A Target row
 * has required columns a test does not care about — a connection, a health — and
 * restating them at every insert would mean a test asserting something about
 * ranks silently deciding what a healthy Target looks like.
 */
import { join } from 'node:path';
import type { ConnectTargetInput } from '../../src/commands/targets/connect.ts';
import type { TargetAdapter } from '../../src/config/manifest.schema.ts';
import {
  type InstallationManifest,
  parseManifest,
} from '../../src/config/manifest.ts';
import type { NewTarget } from '../../src/db/schema.ts';
import type { TargetConnection } from '../../src/domain/target.ts';

const FIXTURE = join(import.meta.dir, '../fixtures/installation.example.yaml');

let cached: InstallationManifest | null = null;

/** The fixture installation, parsed through the real loader. */
export async function fixtureManifest(): Promise<InstallationManifest> {
  if (cached === null) {
    cached = parseManifest(await Bun.file(FIXTURE).text(), FIXTURE);
  }
  return cached;
}

/**
 * The connect input a cluster takes, with anything a test cares about
 * overridden.
 *
 * A Kubernetes Target carries more than an endpoint — §6 makes the delivery
 * flavour a Target's own declaration, and the App chart's source is a
 * prerequisite until the OCI swap — and none of it has a default (§20). So the
 * shape lives here once rather than in every test that connects a cluster and
 * does not care which operator it runs.
 */
export function clusterInput(
  overrides: Partial<KubernetesConnectInput> = {},
): KubernetesConnectInput {
  return {
    kind: 'kubernetes',
    name: 'cluster',
    apiServer: 'https://cluster.example.test',
    namespace: 'apps',
    delivery: {
      flavour: 'flux-helmrelease',
      namespace: 'apps',
      sourceRef: { name: 'charts', namespace: 'delivery' },
    },
    ...overrides,
  };
}

/** The kubernetes arm of `connectTargetInput`. */
export type KubernetesConnectInput = Extract<
  ConnectTargetInput,
  { kind: 'kubernetes' }
>;

/** A connection of the shape one adapter type needs. */
export function connectionFor(adapter: TargetAdapter): TargetConnection {
  switch (adapter) {
    case 'kubernetes': {
      const input = clusterInput();
      return {
        adapter,
        apiServer: input.apiServer,
        namespace: input.namespace,
        delivery: input.delivery,
      };
    }
    case 'cloudrun':
      return { adapter, project: 'example-vessel', region: 'somewhere' };
    case 'static':
      return { adapter, project: 'example-vessel' };
  }
}

/** A complete, healthy Target row, with anything a test cares about overridden. */
export function targetValues(overrides: Partial<NewTarget> = {}): NewTarget {
  const adapter = overrides.adapter ?? 'kubernetes';
  return {
    name: `target-${crypto.randomUUID()}`,
    adapter,
    rank: 0,
    connection: connectionFor(adapter),
    health: 'healthy',
    ...overrides,
  };
}
