/**
 * The DNS controller each cluster runs, read off the cluster manifests (§9).
 *
 * Publication is a two-party mechanism and Spindrift owns one party: the App
 * chart states a record in a `DNSEndpoint` and holds its own route out of the
 * route source. Both halves are inert unless the controller is configured to
 * read the first and to be the thing the second is held out of, and that
 * configuration is declared in `clusters/`, not here. So it is read from
 * `clusters/`: a model that hardcodes `--source=crd` keeps agreeing with itself
 * after the sources list loses `crd`, and that installation publishes nothing
 * at all — the routes are still held out, no source claims an App's name, and
 * `--policy=sync` deletes the records that are already there.
 *
 * **What this refuses to model matters as much as what it reads.** An argument
 * outside {@link INERT_ARGUMENTS} fails here rather than being ignored, because
 * the arguments that would change the answer — which namespaces a source reads,
 * what an annotation key is called, which kind the `crd` source reads — are not
 * enumerable, and a model that shrugs at an argument it has not seen is the
 * hardcoded premise again with more steps.
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ANNOTATION_PREFIXES } from '../../src/adapters/dns/cluster.ts';
import type { Controller } from './fakes/external-dns.ts';

const REPO_ROOT = join(import.meta.dir, '../../../..');

/** The one declaration of what the controller runs, shared by every cluster. */
const RELEASE = 'clusters/base/networking/external-dns/helm-release.yaml';

/** Where a cluster builds on it. */
const overlayPath = (cluster: string) =>
  `clusters/${cluster}/networking/external-dns/kustomization.yaml`;

/**
 * Arguments that change nothing this model reads.
 *
 * `--fqdn-template` only names a hostname for an object that has none
 * (`source/gateway.go`, `hosts()`), and every route the App chart renders
 * carries its own. That holds only while `--combine-fqdn-annotation` is absent
 * — which is itself an argument, so this list is what keeps it absent.
 */
const INERT_ARGUMENTS = [/^--fqdn-template=/];

/**
 * The one argument that is read, and only where it says what Spindrift writes.
 *
 * `--annotation-prefix` renames every annotation key the controller looks for —
 * the `cloudflare-proxied` that decides whether a record is proxied, and the
 * hold-out that keeps a route from claiming its own name — so a foreign value
 * is still refused, exactly as it was before this argument was read at all.
 *
 * What is accepted is any prefix Spindrift's two writers actually write —
 * `ANNOTATION_PREFIXES` in `src/adapters/dns/cluster.ts`, every one of them, on
 * every object. A pin exists at all because external-dns v0.22.0 changed the
 * default with no fallback for the old spelling: an unpinned controller on the
 * new default stops finding `cloudflare-proxied` and publishes every record
 * unproxied. Accepting the whole set rather than one member is what makes
 * moving the pin a one-line change to a flag instead of a flag day — and it
 * still refuses a prefix nothing writes, which is the failure this guards.
 */
const ANNOTATION_PREFIX_ARGUMENT = /^--annotation-prefix=(.+)$/;

export interface ExternalDnsRelease {
  spec?: { values?: { sources?: unknown; extraArgs?: unknown } };
}

export interface ExternalDnsOverlay {
  resources?: unknown;
  patches?: unknown;
}

interface Patch {
  target?: { kind?: string; name?: string };
  patch?: string;
}

interface PatchOperation {
  op?: string;
  path?: string;
  value?: unknown;
}

/** Every cluster that builds on {@link RELEASE}, as it configures it. */
export async function installedControllers(): Promise<Controller[]> {
  const release = (await parse(RELEASE)) as ExternalDnsRelease;
  const controllers: Controller[] = [];
  for (const entry of await readdir(join(REPO_ROOT, 'clusters'), {
    withFileTypes: true,
  })) {
    if (!entry.isDirectory() || entry.name === 'base') continue;
    const overlay = overlayPath(entry.name);
    if (!(await Bun.file(join(REPO_ROOT, overlay)).exists())) continue;
    controllers.push(
      controllerFor(
        entry.name,
        release,
        (await parse(overlay)) as ExternalDnsOverlay,
      ),
    );
  }
  if (controllers.length === 0) {
    throw new Error(`no cluster builds on ${RELEASE}: the paths have moved`);
  }
  return controllers;
}

/**
 * One cluster's controller, from the shared release and that cluster's overlay.
 *
 * Kept apart from the reading so the refusals below can be shown failing: a
 * guard only ever handed the manifest it agrees with is a guard nobody has seen
 * work.
 */
export function controllerFor(
  cluster: string,
  release: ExternalDnsRelease,
  overlay: ExternalDnsOverlay,
): Controller {
  const origin = overlayPath(cluster);
  if (!buildsOnRelease(overlay)) {
    throw new Error(`${origin} declares an external-dns of its own`);
  }
  const argued = [
    ...strings(release.spec?.values?.extraArgs, `${RELEASE} extraArgs`),
    ...appendedArguments(overlay, origin),
  ];
  let annotationPrefix: string | null = null;
  for (const argument of argued) {
    if (INERT_ARGUMENTS.some((inert) => inert.test(argument))) continue;
    const prefixed = ANNOTATION_PREFIX_ARGUMENT.exec(argument);
    const value = prefixed?.[1];
    if (value !== undefined && ANNOTATION_PREFIXES.includes(value)) {
      annotationPrefix = value;
      continue;
    }
    throw new Error(
      `${cluster}'s external-dns runs ${argument}, which this model does not ` +
        'account for: model what it changes about a published record, or list ' +
        'it as inert once it is known to change nothing',
    );
  }
  return {
    cluster,
    sources: strings(release.spec?.values?.sources, `${RELEASE} sources`),
    annotationPrefix,
  };
}

/** Arguments a cluster appends to the shared list, as a JSON patch does. */
function appendedArguments(
  overlay: ExternalDnsOverlay,
  origin: string,
): string[] {
  const appended: string[] = [];
  for (const patch of asArray<Patch>(overlay.patches)) {
    if (patch.target?.kind !== 'HelmRelease') continue;
    if (patch.target?.name !== 'external-dns') continue;
    const operations = Bun.YAML.parse(patch.patch ?? '');
    if (!Array.isArray(operations)) {
      throw new Error(`${origin} patches external-dns by merge, not by op`);
    }
    for (const operation of operations as PatchOperation[]) {
      const path = operation.path ?? '';
      if (operation.op === 'add' && path === '/spec/values/extraArgs/-') {
        appended.push(String(operation.value));
        continue;
      }
      if (
        path.startsWith('/spec/values/extraArgs') ||
        path.startsWith('/spec/values/sources')
      ) {
        throw new Error(`${origin} ${operation.op}s ${path}, which is unread`);
      }
    }
  }
  return appended;
}

function buildsOnRelease(overlay: ExternalDnsOverlay): boolean {
  return asArray<unknown>(overlay.resources).some(
    (resource) =>
      typeof resource === 'string' &&
      resource.replace(/\/+$/, '').endsWith('base/networking/external-dns'),
  );
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function strings(value: unknown, what: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== 'string')
  ) {
    throw new Error(`${what} is not a list of strings`);
  }
  return value;
}

async function parse(path: string): Promise<unknown> {
  return Bun.YAML.parse(await Bun.file(join(REPO_ROOT, path)).text());
}
