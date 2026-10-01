/**
 * Every chart's restic producer meets the same contract: the staging repository,
 * the `restic` Secret's keys, and the snapshot's host and tag.
 */
import { describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const CHARTS = dirname(import.meta.dir);
const REPOSITORY = 'rest:http://staging.example.test:8000/offsite/';

interface Rendered {
  kind: string;
  metadata: {
    name: string;
    namespace?: string;
    labels?: Record<string, string>;
  };
  spec?: any;
}

interface Case {
  chart: string;
  namespace: string;
  database: string;
  dump: string;
  values: Record<string, unknown>;
}

const CASES: Case[] = [
  {
    chart: 'kthx',
    namespace: 'kthx',
    database: 'kthx-db',
    dump: 'pg_dumpall',
    values: {
      image: 'registry.example.test/kthx@sha256:feed',
      bucket: 'example-bucket',
      envFromSecret: 'kthx-env',
    },
  },
  {
    chart: 'spindrift',
    namespace: 'spindrift',
    database: 'spindrift-db',
    dump: 'pg_dump -Fc',
    values: {
      image: 'registry.example.test/spindrift@sha256:feed',
      database: { enabled: true },
    },
  },
  {
    chart: 'prowler',
    namespace: 'prowler',
    database: 'prowler-db',
    dump: 'pg_dump -Fc',
    values: {
      fullnameOverride: 'prowler',
      hostname: 'prowler.example.test',
      envFromSecret: 'prowler-env',
    },
  },
  {
    chart: 'app',
    namespace: 'hub',
    database: 'hub-db',
    dump: 'pg_dump -Fc',
    values: {
      fullnameOverride: 'hub',
      image: 'registry.example.test/hub@sha256:feed',
      database: { enabled: true },
    },
  },
];

async function render(
  chart: string,
  namespace: string,
  values: Record<string, unknown>,
): Promise<Rendered[]> {
  const file = join(tmpdir(), `${chart}-restic-${crypto.randomUUID()}.json`);
  await Bun.write(file, JSON.stringify(values));
  try {
    const helm = Bun.spawn(
      [
        'helm',
        'template',
        namespace,
        join(CHARTS, chart),
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
    if (code !== 0)
      throw new Error(`helm template failed (${code}): ${stderr}`);
    const documents = Bun.YAML.parse(stdout) as unknown;
    return (Array.isArray(documents) ? documents : [documents]).filter(
      (d): d is Rendered =>
        typeof d === 'object' &&
        d !== null &&
        typeof (d as any).kind === 'string',
    );
  } finally {
    await Bun.file(file)
      .delete()
      .catch(() => {});
  }
}

const restic = (restic: Record<string, unknown>) => ({
  repository: REPOSITORY,
  cluster: 'offsite',
  ...restic,
});

describe.each(CASES)('the $chart restic producer', (c) => {
  const withRestic = (extra: Record<string, unknown> = {}) =>
    render(c.chart, c.namespace, { ...c.values, restic: restic(extra) });

  test('renders nothing without a repository', async () => {
    const objects = await render(c.chart, c.namespace, c.values);
    expect(
      objects.filter(
        (o) =>
          o.kind === 'ExternalSecret' ||
          o.metadata.name === `${c.database}-restic`,
      ),
    ).toEqual([]);
  });

  test('dumps the database and backs the file up to the staging repository', async () => {
    const objects = await withRestic();
    const cronJob = objects.find(
      (o) => o.kind === 'CronJob' && o.metadata.name === `${c.database}-restic`,
    ) as Rendered;
    expect(cronJob.metadata.namespace).toBe(c.namespace);
    expect(cronJob.metadata.labels?.['lolwtf.ca/backup']).toBe('true');
    expect(cronJob.spec.timeZone).toBe('America/Halifax');
    expect(cronJob.spec.concurrencyPolicy).toBe('Forbid');
    const hour = Number(cronJob.spec.schedule.split(' ')[1]);
    expect(hour).toBeGreaterThanOrEqual(1);
    expect(hour).toBeLessThan(4);

    const pod = cronJob.spec.jobTemplate.spec.template.spec;
    expect(pod.restartPolicy).toBe('Never');
    const dump = pod.initContainers[0];
    expect(dump.command.at(-1)).toContain(c.dump);
    expect(dump.env).toContainEqual({
      name: 'DATABASE_URL',
      valueFrom: { secretKeyRef: { name: `${c.database}-app`, key: 'uri' } },
    });

    const container = pod.containers[0];
    const script: string = container.command.at(-1);
    expect(script).toContain(
      `restic backup --host "offsite/${c.namespace}/${c.database}" --tag kind=pg /dump`,
    );
    expect(container.env).toContainEqual({
      name: 'RESTIC_REPOSITORY',
      value: REPOSITORY,
    });
    expect(container.envFrom).toEqual([{ secretRef: { name: 'restic' } }]);
    // The dump is read, never written, by the container holding the credentials.
    expect(
      container.volumeMounts.find((m: any) => m.mountPath === '/dump').readOnly,
    ).toBe(true);
  });

  test('keeps the backup pod out of every Service', async () => {
    const objects = await withRestic();
    const labels: Record<string, string> = (
      objects.find(
        (o) =>
          o.kind === 'CronJob' && o.metadata.name === `${c.database}-restic`,
      ) as Rendered
    ).spec.jobTemplate.spec.template.metadata.labels;
    for (const service of objects.filter((o) => o.kind === 'Service')) {
      const selector: Record<string, string> = service.spec.selector ?? {};
      const matched =
        Object.keys(selector).length > 0 &&
        Object.entries(selector).every(([k, v]) => labels[k] === v);
      expect(matched).toBe(false);
    }
  });

  test('reads the restic Secret from 1Password unless told not to', async () => {
    const secret = (await withRestic()).find(
      (o) => o.kind === 'ExternalSecret' && o.metadata.name === 'restic',
    ) as Rendered;
    expect(secret.metadata.namespace).toBe(c.namespace);
    expect(secret.spec.secretStoreRef).toEqual({
      kind: 'ClusterSecretStore',
      name: 'onepassword-connect',
    });
    expect(secret.spec.target.name).toBe('restic');
    expect(
      secret.spec.data.map((d: any) => [
        d.secretKey,
        d.remoteRef.key,
        d.remoteRef.property,
      ]),
    ).toEqual([
      ['RESTIC_PASSWORD', 'restic-repository', 'password'],
      ['RESTIC_REST_USERNAME', 'restic-rest-server', 'username'],
      ['RESTIC_REST_PASSWORD', 'restic-rest-server', 'password'],
    ]);

    const without = await withRestic({ externalSecret: false });
    expect(without.some((o) => o.kind === 'ExternalSecret')).toBe(false);
    expect(
      without.some((o) => o.metadata.name === `${c.database}-restic`),
    ).toBe(true);
  });

  test('refuses a repository with no cluster to name the snapshot', async () => {
    await expect(withRestic({ cluster: '' })).rejects.toThrow('restic.cluster');
  });
});
