/**
 * Renders the App chart with only the values blob the adapter wrote onto the
 * delivery object, over no baseline, so a value that core stops writing falls
 * back to the chart's `values.yaml` default.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHART = join(
  import.meta.dir,
  '../../../../packages/charts/spindrift-app',
);

export interface RenderedObject {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string;
    namespace?: string;
    annotations?: Record<string, string>;
  };
  spec?: any;
}

export async function renderAppChart(
  values: unknown,
  namespace = 'spindrift-apps',
): Promise<RenderedObject[]> {
  const file = join(tmpdir(), `spindrift-values-${crypto.randomUUID()}.json`);
  await Bun.write(file, JSON.stringify(values));
  try {
    const helm = Bun.spawn(
      [
        'helm',
        'template',
        'release',
        CHART,
        '--namespace',
        namespace,
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
        typeof document === 'object' &&
        document !== null &&
        typeof (document as RenderedObject).kind === 'string',
    );
  } finally {
    await Bun.file(file)
      .delete()
      .catch(() => {});
  }
}
