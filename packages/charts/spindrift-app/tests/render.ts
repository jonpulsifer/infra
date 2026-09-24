/** `helm template` over the App chart, parsed. Nothing here imports the control plane. */
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const CHART = dirname(import.meta.dir);

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

export type Values = Record<string, unknown>;

/** A Deploy's App, Component and digest-pinned image, and a Target's platform values. */
const BASELINE: Values = {
  app: {
    name: 'blog',
    component: 'web',
    image: 'registry.example.test/blog/web@sha256:feed',
    deployId: 'deploy-1',
    artifactDigest: 'sha256:feed',
    hostnames: ['blog-web.apps.example.test'],
  },
  platform: {
    gateway: { name: 'cluster-gateway', namespace: 'gateway' },
    externalAuth: {
      name: 'oauth2-proxy',
      namespace: 'oauth2-proxy',
      port: 80,
    },
    dns: {
      privateAddress: '10.89.0.67',
      tunnelHostname: 'tunnel.example.test',
    },
    networkPolicy: { allowedNamespaces: ['gateway', 'monitoring'] },
  },
};

/** Merges records recursively; arrays and scalars in `overrides` replace. */
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

/** Values go through a file because `--set` has its own escaping grammar. */
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

export function kinds(objects: RenderedObject[]): string[] {
  return objects.map((object) => object.kind);
}

/** `Chart.yaml`, as `helm show chart` reads it when a Target is pinned. */
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
