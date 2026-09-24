/**
 * `discoverInstallationFacts` asks the cloud for manifest values an operator
 * would otherwise type, and proposes each at its manifest path. The browser
 * bundle imports this module, so it takes no server-only import.
 */

import type { FederationConfig } from '@repo/archive/federation';
import { z } from 'zod';
import type {
  Discovered,
  GcpDiscovery,
} from '../../adapters/cloud-discovery.ts';
import { type Command, failed, ok } from '../types.ts';

export const discoverInstallationFactsInput = z
  .object({
    /** Absent on the first pass, while the project is being discovered. */
    project: z.string().trim().min(1).optional(),
    /** Cloud KMS lists key rings per location, so one must be named. */
    kmsLocation: z.string().trim().min(1).optional(),
  })
  .strict();

export type DiscoverInstallationFactsInput = z.infer<
  typeof discoverInstallationFactsInput
>;

/** One value an operator may confirm: what they read, and what gets written. */
export interface DiscoveredCandidate {
  readonly label: string;
  /**
   * Written verbatim at the fact's path: `sources.buckets` takes `[name]`,
   * while `shared.sourceBucket` takes the name bare.
   */
  readonly value: unknown;
}

/**
 * Stands in for the home vessel's index in `vessels`, which can move while the
 * form edits the array. {@link placementOf} resolves it at confirm time.
 */
export const HOME_VESSEL = 'homeVessel';

/** One manifest path, and what discovery could say about it. */
export type DiscoveredFact = {
  /** May hold {@link HOME_VESSEL}, which {@link placementOf} resolves. */
  readonly path: readonly (string | number)[];
} & Discovered<DiscoveredCandidate>;

/** Resolves {@link HOME_VESSEL} in `document`; `null` without a home vessel. */
export function placementOf(
  fact: DiscoveredFact,
  document: unknown,
): readonly (string | number)[] | null {
  const [head, next, ...rest] = fact.path;
  if (head !== 'vessels' || next !== HOME_VESSEL) return fact.path;
  const home = homeVesselIndex(document);
  return home === null ? null : ['vessels', home, ...rest];
}

function homeVesselIndex(document: unknown): number | null {
  const doc = document as {
    installation?: { homeVessel?: unknown };
    vessels?: unknown;
  } | null;
  const name = doc?.installation?.homeVessel;
  const vessels = doc?.vessels;
  if (typeof name !== 'string' || !Array.isArray(vessels)) return null;
  const index = vessels.findIndex(
    (vessel) => (vessel as { name?: unknown })?.name === name,
  );
  return index === -1 ? null : index;
}

export interface DiscoverInstallationFactsResult {
  /** In display order. */
  readonly facts: readonly DiscoveredFact[];
}

/**
 * ponytail: a heuristic, only ever suggested: an identity from another project
 * yields a wrong one. GCP project ids are 6 to 30 characters, letter first.
 */
const SERVICE_ACCOUNT_PROJECT =
  /@([a-z][a-z0-9-]{5,29})\.iam\.gserviceaccount\.com/;

export const discoverInstallationFacts: Command<
  DiscoverInstallationFactsInput,
  DiscoverInstallationFactsResult
> = async (input, context) => {
  if (context.manifest.cloud.federation === null) {
    return failed(
      'NOT_DEPLOYABLE',
      'this installation mounts no cloud federation credential, so nothing about its cloud can be discovered',
    );
  }
  const discovery = context.adapters.discovery?.() ?? null;
  if (discovery === null) {
    return failed(
      'NOT_DEPLOYABLE',
      'this process cannot reach a cloud API, so nothing about this installation can be discovered',
    );
  }

  const { project, kmsLocation } = input;
  // GcpDiscovery returns failures instead of throwing, so each read stands
  // alone.
  const [projects, buckets, signers] = await Promise.all([
    discovery.projects(),
    project === undefined
      ? needsProject('buckets')
      : discovery.buckets(project),
    project === undefined
      ? needsProject('signing keys')
      : signingKeysIn(discovery, project, kmsLocation),
  ]);

  const suggestedVessel = credentialProject(context.manifest.cloud.federation);
  return ok({
    facts: [
      withSuggestion(
        mapped(
          ['vessels', HOME_VESSEL, 'location', 'project'],
          projects,
          plain,
        ),
        suggestedVessel,
      ),
      mapped(
        ['vessels', HOME_VESSEL, 'shared', 'artifactsProject'],
        projects,
        plain,
      ),
      // One read answers both bucket paths: a sourceBucket not among
      // sources.buckets validates and then stages nowhere.
      mapped(['sources', 'buckets'], buckets, (name) => ({
        label: name,
        value: [name],
      })),
      mapped(
        ['vessels', HOME_VESSEL, 'shared', 'sourceBucket'],
        buckets,
        plain,
      ),
      mapped(['supplyChain', 'signer'], signers, plain),
    ],
  });
};

function plain(value: string): DiscoveredCandidate {
  return { label: value, value };
}

function needsProject(what: string): Promise<Discovered<string>> {
  return Promise.resolve({
    kind: 'unavailable',
    reason: `name a project and run discovery again to list its ${what}`,
  });
}

/**
 * Signing keys, or why they cannot be read yet. Without a location, the key
 * locations call lists the choices, and its refusal is the real reason.
 */
async function signingKeysIn(
  discovery: GcpDiscovery,
  project: string,
  location: string | undefined,
): Promise<Discovered<string>> {
  if (location !== undefined) return discovery.signingKeys(project, location);
  const locations = await discovery.keyLocations(project);
  if (locations.kind === 'unavailable') return locations;
  return {
    kind: 'unavailable',
    reason:
      locations.candidates.length === 0
        ? 'this project offers no key locations, so it holds no signing key'
        : `name a key location and run discovery again — this project offers ${locations.candidates.join(', ')}`,
  };
}

function mapped(
  path: readonly (string | number)[],
  discovered: Discovered<string>,
  to: (value: string) => DiscoveredCandidate,
): DiscoveredFact {
  if (discovered.kind === 'unavailable') return { path, ...discovered };
  return {
    path,
    kind: 'found',
    candidates: discovered.candidates.map(to),
    suggested: discovered.suggested === null ? null : to(discovered.suggested),
  };
}

/**
 * Puts the credential's own project first. It can turn a refused listing into
 * an answer, so its label names where it came from.
 */
function withSuggestion(
  fact: DiscoveredFact,
  suggested: DiscoveredCandidate | null,
): DiscoveredFact {
  if (suggested === null) return fact;
  const listed = fact.kind === 'found' ? fact.candidates : [];
  return {
    path: fact.path,
    kind: 'found',
    candidates: [
      suggested,
      ...listed.filter((candidate) => candidate.value !== suggested.value),
    ],
    suggested,
  };
}

/** The project this deployment's own identity lives in, labelled as such. */
function credentialProject(
  federation: FederationConfig,
): DiscoveredCandidate | null {
  const url = federation.impersonationUrl;
  if (url === null) return null;
  const project = SERVICE_ACCOUNT_PROJECT.exec(url)?.[1];
  return project === undefined
    ? null
    : {
        label: `${project} — this deployment’s own credential`,
        value: project,
      };
}
