/**
 * The App chart, rendered with the values a Target was actually applied.
 *
 * The chart's own goldens live where the chart does
 * (`packages/charts/spindrift-app/tests/`) and render over a baseline of
 * representative values. This renders over **no** baseline: what goes in is the
 * inline blob the adapter wrote onto the delivery object and nothing else, so a
 * value core stopped rendering is a chart that falls back to `values.yaml`
 * rather than a merge that hides it.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The chart this installation deploys every Component through. */
const CHART = join(
  import.meta.dir,
  '../../../../packages/charts/spindrift-app',
);

/** One rendered object, as loosely typed as YAML actually is. */
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

/** `helm template` over the chart, parsed, with `values` as the whole input. */
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
