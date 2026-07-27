/**
 * `helm template` over the App chart, parsed.
 *
 * Chart correctness is asserted **where the chart lives**, as a rendering
 * assertion — never through Spindrift's command layer (Spindrift spec, § Not a
 * seam). So this helper knows about Helm and YAML and nothing else: no adapter,
 * no `DesiredState`, no database. What it renders is what a cluster would get.
 */
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** The chart under test — this file's own parent, not a configured path. */
const CHART = dirname(import.meta.dir);

/** One rendered Kubernetes object, as loosely typed as YAML actually is. */
export interface RenderedObject {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string;
    namespace?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  spec?: any;
  [key: string]: unknown;
}

/** The values a test sets. Everything else comes from `values.yaml`. */
export type Values = Record<string, unknown>;

/**
 * The minimum a Deploy always carries: Spindrift never renders a release
 * without an App, a Component, and a digest-pinned image.
 */
const BASELINE: Values = {
  app: {
    name: 'blog',
    component: 'web',
    image: 'registry.example.test/blog/web@sha256:feed',
    artifactDigest: 'sha256:feed',
    hostnames: ['blog-web.apps.example.test'],
  },
  platform: {
    gateway: { name: 'cluster-gateway', namespace: 'gateway' },
    networkPolicy: { allowedNamespaces: ['gateway', 'monitoring'] },
  },
};

/** Merge one level deeper than `{...a, ...b}`, which is all these values nest. */
function merge(base: Values, overrides: Values): Values {
  const merged: Values = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    const existing = merged[key];
    merged[key] =
      isRecord(existing) && isRecord(value)
        ? merge(existing, value)
        : (value as unknown);
  }
  return merged;
}

function isRecord(value: unknown): value is Values {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Render the chart with `overrides` on top of a realistic baseline.
 *
 * Values go through a file rather than `--set` because `--set` has its own
 * escaping grammar, and a test that fails on a comma inside a hostname would be
 * testing Helm's argument parser instead of the chart.
 */
export async function render(
  overrides: Values = {},
): Promise<RenderedObject[]> {
  const values = merge(BASELINE, overrides);
  const file = join(
    tmpdir(),
    `spindrift-app-values-${crypto.randomUUID()}.json`,
  );
  await Bun.write(file, JSON.stringify(values));

  try {
    const helm = Bun.spawn(
      [
        'helm',
        'template',
        'release',
        CHART,
        '--namespace',
        'apps',
        '--values',
        file,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(helm.stdout).text(),
      new Response(helm.stderr).text(),
      helm.exited,
    ]);
    if (code !== 0) {
      throw new Error(`helm template failed (${code}): ${stderr}`);
    }
    const documents = Bun.YAML.parse(stdout) as unknown;
    const list = Array.isArray(documents) ? documents : [documents];
    return list.filter(
      (document): document is RenderedObject =>
        isRecord(document) && typeof document.kind === 'string',
    );
  } finally {
    await Bun.file(file)
      .delete()
      .catch(() => {});
  }
}

/** The one object of a kind, or a failure naming what was rendered instead. */
export function one(objects: RenderedObject[], kind: string): RenderedObject {
  const matches = objects.filter((object) => object.kind === kind);
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one ${kind}, got ${matches.length} ` +
        `(rendered: ${objects.map((o) => o.kind).join(', ') || 'nothing'})`,
    );
  }
  return matches[0] as RenderedObject;
}

/** Every kind rendered, for the assertions about what is *absent*. */
export function kinds(objects: RenderedObject[]): string[] {
  return objects.map((object) => object.kind);
}

/** The chart's own metadata, as `helm show chart` reads it at pin time. */
export async function chartMetadata(): Promise<{
  name: string;
  version: string;
  annotations?: Record<string, string>;
}> {
  const text = await Bun.file(join(CHART, 'Chart.yaml')).text();
  return Bun.YAML.parse(text) as {
    name: string;
    version: string;
    annotations?: Record<string, string>;
  };
}
