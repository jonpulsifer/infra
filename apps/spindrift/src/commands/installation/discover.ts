/**
 * `discoverInstallationFacts` — ask the cloud for what an operator types (§20).
 *
 * §20 makes the manifest the one place a value naming this installation lives,
 * and a good half of those values are facts the pod's own federated identity
 * can simply be asked for. This command asks, and answers as **proposals
 * against manifest paths** rather than as a shaped result object.
 *
 * **Paths, not field names, and that is load-bearing.** The settings surface
 * names no manifest key on purpose — `web/views/auth/installation.tsx` says why:
 * the schema is losing keys to the chart and gaining others, and a hand-listed
 * form absorbs neither. A discovery result that carried named fields would put
 * the list back, one layer down. So each answer carries `path` — the segments
 * `forms/document.ts` already edits a document by — and the screen applies a
 * chosen value with `withValueAt` without knowing what it just set.
 *
 * **Every answer has two arms, and a refusal is never an empty list.** That is
 * `adapters/cloud-discovery.ts`'s rule, carried through unchanged: a project
 * with no buckets is `found` with no candidates, and a project whose Storage API
 * is switched off is `unavailable` with a sentence saying so. Flattening those
 * would put a blank on a confirmation screen that reads exactly like a
 * confirmed answer, which is the failure this whole path exists to remove.
 *
 * **Staged, because the calls are not all free.** With no project named, only
 * the project list is fetched and everything below it says so — a stated fact,
 * not an empty answer. With a project, its buckets and its key locations are
 * fetched in parallel, each folded on its own so one refused API cannot turn two
 * good answers into three refusals. The signer needs a location as well, because
 * Cloud KMS lists key rings per concrete location and fanning out over every
 * location a project offers is forty calls behind one button.
 *
 * Server-only imports are deliberately absent, for the reason
 * `installation/get.ts` names: the browser bundle reaches this layer's types,
 * and a command that pulls in a database module breaks the client build.
 */
import { z } from 'zod';
import type {
  Discovered,
  GcpDiscovery,
} from '../../adapters/cloud-discovery.ts';
import type { FederationConfig } from '../../adapters/deploy/cloud/federation.ts';
import { type Command, failed, ok } from '../types.ts';

export const discoverInstallationFactsInput = z
  .object({
    /**
     * Which project to look inside. Absent on the first pass, when the answer
     * to "which project" is itself one of the things being discovered.
     */
    project: z.string().trim().min(1).optional(),
    /** Which key location to list signing keys from. See the note above. */
    kmsLocation: z.string().trim().min(1).optional(),
  })
  .strict();

export type DiscoverInstallationFactsInput = z.infer<
  typeof discoverInstallationFactsInput
>;

/** One value an operator may confirm: what they read, and what gets written. */
export interface DiscoveredCandidate {
  /** What the operator reads. */
  readonly label: string;
  /**
   * What is written at the fact's path when this candidate is chosen, verbatim.
   *
   * Carried rather than derived because the two are not always the same shape:
   * `sources.buckets` is a list and takes `[name]`, while `sources.defaultBucket`
   * takes the same name bare. A screen deriving that would be a screen with an
   * opinion about the schema, which is exactly what it must not have.
   */
  readonly value: unknown;
}

/** One manifest path, and what discovery could say about it. */
export type DiscoveredFact = {
  /** Where the chosen value belongs, as `forms/document.ts` addresses it. */
  readonly path: readonly string[];
} & Discovered<DiscoveredCandidate>;

export interface DiscoverInstallationFactsResult {
  /** In display order. Empty is not a state this command can produce. */
  readonly facts: readonly DiscoveredFact[];
}

/**
 * The project in an impersonated service account's own address.
 *
 * ponytail: a heuristic, and marked as one. It reads
 * `…@<project>.iam.gserviceaccount.com` out of the impersonation URL the
 * deployment's credential already carries, which costs no API call and is right
 * for every installation whose controller identity lives in its own home
 * vessel. An installation that impersonates an identity from somewhere else gets
 * a wrong suggestion — which is why it is only ever `suggested`, never asserted
 * as the answer. A URL that does not match at all yields nothing rather than a
 * fragment of one.
 */
const SERVICE_ACCOUNT_PROJECT =
  /@([a-z][a-z0-9-]{4,28})\.iam\.gserviceaccount\.com/;

export const discoverInstallationFacts: Command<
  DiscoverInstallationFactsInput,
  DiscoverInstallationFactsResult
> = async (input, context) => {
  // Refused before anything is asked, and asserted by the test that no request
  // was made: an installation with no federation has no cloud identity at all,
  // which is a fact about the installation rather than a failed probe. Mirrors
  // `storage/test-bucket.ts`, and `NOT_DEPLOYABLE` is the code for exactly this
  // — the caller is told about the world, not asked to fix a field.
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
  // Three independent reads, each folded into its own answer. Never one
  // `try` and never one rejection path: `GcpDiscovery` returns its failures,
  // so a single catch here would silently turn two good answers into refusals.
  const [projects, buckets, signers] = await Promise.all([
    discovery.projects(),
    project === undefined
      ? needsProject('buckets')
      : discovery.buckets(project),
    project === undefined
      ? needsProject('signing keys')
      : signingKeysIn(discovery, project, kmsLocation),
  ]);

  const suggestedVessel = homeVesselOf(context.manifest.cloud.federation);

  return ok({
    facts: [
      withSuggestion(
        mapped(['cloud', 'homeVesselProject'], projects, plain),
        suggestedVessel,
      ),
      mapped(['cloud', 'artifactsProject'], projects, plain),
      // The same one read, answered against both keys: a bucket chosen for one
      // and not the other leaves a manifest whose default is not among its
      // buckets, which validates and then stages nowhere.
      mapped(['sources', 'buckets'], buckets, (name) => ({
        label: name,
        value: [name],
      })),
      mapped(['sources', 'defaultBucket'], buckets, plain),
      mapped(['supplyChain', 'signer'], signers, plain),
    ],
  });
};

/** A candidate whose written value is the string the operator read. */
function plain(value: string): DiscoveredCandidate {
  return { label: value, value };
}

/**
 * A fact that was not asked about because the question needs a project first.
 *
 * Stated rather than probed, which is the posture `listSourceBuckets.canVerify`
 * already takes: an answer nobody asked for is not the same as an answer that
 * came back empty, and saying which is which is the whole job here.
 */
function needsProject(what: string): Promise<Discovered<string>> {
  return Promise.resolve({
    kind: 'unavailable',
    reason: `name a project and run discovery again to list its ${what}`,
  });
}

/**
 * Signing keys, or the sentence naming what is missing before they can be read.
 *
 * The extra call in the second arm earns its place twice: it tells the operator
 * which locations they may name, and its own refusal is the honest reason the
 * signer could not be read — a Cloud KMS that answers nothing here would
 * otherwise be reported as "name a location", sending them to supply an input
 * that was never the problem.
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

/** One read, against one manifest path, in whichever arm it came back in. */
function mapped(
  path: readonly string[],
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
 * Fold the credential's own answer in ahead of whatever the listing said.
 *
 * A suggestion this installation carries is worth more than a list it may not
 * have permission to read, and it is the likely live case: an identity granted
 * on one bucket and one key is not usually granted `projects.list`. So a
 * suggestion turns a refusal into an answer, and joins a listing it is already
 * part of without being repeated.
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
    candidates: listed.some((candidate) => candidate.value === suggested.value)
      ? listed
      : [suggested, ...listed],
    suggested,
  };
}

/** The home vessel this installation's own identity lives in, if it says. */
function homeVesselOf(
  federation: FederationConfig,
): DiscoveredCandidate | null {
  const url = federation.impersonationUrl;
  if (url === null) return null;
  const project = SERVICE_ACCOUNT_PROJECT.exec(url)?.[1];
  return project === undefined ? null : plain(project);
}
