/**
 * `helm template` over the installer chart, parsed.
 *
 * The installer is infrastructure, so its contract is the rendered Kubernetes
 * objects themselves: one identity, two processes, and credentials only where
 * the process needs them.
 */
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const CHART = dirname(import.meta.dir);

export interface RenderedObject {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string;
    namespace?: string;
  };
  spec?: any;
  [key: string]: unknown;
}

type Values = Record<string, unknown>;

function isRecord(value: unknown): value is Values {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function render(
  overrides: Values = {},
): Promise<RenderedObject[]> {
  const values = {
    image: 'registry.example.test/spindrift@sha256:feed',
    ...overrides,
  };
  const file = join(
    tmpdir(),
    `spindrift-installer-values-${crypto.randomUUID()}.json`,
  );
  await Bun.write(file, JSON.stringify(values));

  try {
    const helm = Bun.spawn(
      [
        'helm',
        'template',
        'spindrift',
        CHART,
        '--namespace',
        'spindrift',
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

export function one(
  objects: RenderedObject[],
  kind: string,
  name?: string,
): RenderedObject {
  const matches = objects.filter(
    (object) =>
      object.kind === kind &&
      (name === undefined || object.metadata.name === name),
  );
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one ${kind}${name === undefined ? '' : ` ${name}`}, ` +
        `got ${matches.length}`,
    );
  }
  return matches[0] as RenderedObject;
}
