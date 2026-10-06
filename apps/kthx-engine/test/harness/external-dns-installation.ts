/**
 * The external-dns controller each cluster runs, read from `clusters/`. An
 * argument this model does not account for fails the read.
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ANNOTATION_PREFIXES } from '../../src/adapters/dns/cluster.ts';
import type { Controller } from './fakes/external-dns.ts';

const REPO_ROOT = join(import.meta.dir, '../../../..');

const RELEASE = 'clusters/base/networking/external-dns/helm-release.yaml';

const overlayPath = (cluster: string) =>
  `clusters/${cluster}/networking/external-dns/kustomization.yaml`;

/**
 * `--fqdn-template` only names an object with no hostname, and every App chart
 * route has one. It stays inert only while `--combine-fqdn-annotation` is
 * absent.
 */
const INERT_ARGUMENTS = [/^--fqdn-template=/];

/**
 * It renames every annotation key the controller reads, so only a prefix in
 * `ANNOTATION_PREFIXES`, which every object is written under, is accepted.
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

/** Separate from the file reads so tests can hand it manifests it must refuse. */
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

/** The arguments a cluster's JSON patches append to the shared list. */
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
