/**
 * Every chart's database backup meets the same contract: the Garage ObjectStore,
 * the `garage-cnpg` Secret's keys, the barman-cloud plugin on the Cluster and the
 * ScheduledBackup that takes the base backups.
 */
import { describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const CHARTS = dirname(import.meta.dir);
const ENDPOINT = 'http://garage.example.test:3900';

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
  values: Record<string, unknown>;
}

const CASES: Case[] = [
  {
    chart: 'kthx',
    namespace: 'kthx',
    database: 'kthx-db',
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
    values: {
      image: 'registry.example.test/spindrift@sha256:feed',
      database: { enabled: true },
    },
  },
  {
    chart: 'prowler',
    namespace: 'prowler',
    database: 'prowler-db',
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
  const file = join(tmpdir(), `${chart}-backup-${crypto.randomUUID()}.json`);
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

const backup = (extra: Record<string, unknown> = {}) => ({
  endpointURL: ENDPOINT,
  item: 'garage-offsite',
  ...extra,
});

describe.each(CASES)('the $chart database backup', (c) => {
  const withBackup = (extra: Record<string, unknown> = {}) =>
    render(c.chart, c.namespace, { ...c.values, backup: backup(extra) });
  const kinds = (objects: Rendered[]) => objects.map((o) => o.kind);

  test('renders nothing without an endpoint', async () => {
    const objects = await render(c.chart, c.namespace, c.values);
    expect(kinds(objects)).not.toContain('ExternalSecret');
    expect(kinds(objects)).not.toContain('ObjectStore');
    expect(kinds(objects)).not.toContain('ScheduledBackup');
    const cluster = objects.find((o) => o.kind === 'Cluster') as Rendered;
    expect(cluster.spec.plugins).toBeUndefined();
  });

  test('archives WAL through the barman-cloud plugin on the Cluster', async () => {
    const cluster = (await withBackup()).find(
      (o) => o.kind === 'Cluster' && o.metadata.name === c.database,
    ) as Rendered;
    expect(cluster.spec.plugins).toEqual([
      {
        name: 'barman-cloud.cloudnative-pg.io',
        isWALArchiver: true,
        parameters: { barmanObjectName: 'garage' },
      },
    ]);
  });

  test('stores backups in the namespace prefix of the Garage bucket', async () => {
    const store = (await withBackup()).find(
      (o) => o.kind === 'ObjectStore',
    ) as Rendered;
    expect(store.metadata.name).toBe('garage');
    expect(store.metadata.namespace).toBe(c.namespace);
    expect(store.spec.retentionPolicy).toBe('30d');
    expect(store.spec.configuration).toEqual({
      destinationPath: `s3://cnpg/${c.namespace}/`,
      endpointURL: ENDPOINT,
      s3Credentials: {
        accessKeyId: { name: 'garage-cnpg', key: 'ACCESS_KEY_ID' },
        secretAccessKey: { name: 'garage-cnpg', key: 'ACCESS_SECRET_KEY' },
        region: { name: 'garage-cnpg', key: 'REGION' },
      },
      wal: { compression: 'gzip' },
      data: { compression: 'gzip' },
    });
  });

  test('takes a daily base backup of the Cluster through the plugin', async () => {
    const backupObject = (await withBackup()).find(
      (o) => o.kind === 'ScheduledBackup',
    ) as Rendered;
    expect(backupObject.metadata.namespace).toBe(c.namespace);
    expect(backupObject.spec.cluster.name).toBe(c.database);
    expect(backupObject.spec.method).toBe('plugin');
    expect(backupObject.spec.pluginConfiguration.name).toBe(
      'barman-cloud.cloudnative-pg.io',
    );
    expect(backupObject.spec.backupOwnerReference).toBe('self');
    expect(backupObject.spec.immediate).toBe(true);
    const fields = backupObject.spec.schedule.split(' ');
    expect(fields).toHaveLength(6);
    const hour = Number(fields[2]);
    // UTC; 01:00-04:00 in Halifax.
    expect(hour).toBeGreaterThanOrEqual(5);
    expect(hour).toBeLessThan(7);
  });

  test('reads the garage-cnpg Secret from 1Password unless told not to', async () => {
    const secret = (await withBackup()).find(
      (o) => o.kind === 'ExternalSecret' && o.metadata.name === 'garage-cnpg',
    ) as Rendered;
    expect(secret.metadata.namespace).toBe(c.namespace);
    expect(secret.spec.secretStoreRef).toEqual({
      kind: 'ClusterSecretStore',
      name: 'onepassword-connect',
    });
    expect(secret.spec.target.name).toBe('garage-cnpg');
    expect(Object.keys(secret.spec.target.template.data)).toEqual([
      'ACCESS_KEY_ID',
      'ACCESS_SECRET_KEY',
      'REGION',
    ]);
    expect(secret.spec.target.template.data.REGION).toBe('garage');
    expect(
      secret.spec.data.map((d: any) => [d.remoteRef.key, d.remoteRef.property]),
    ).toEqual([
      ['garage-offsite', 'cnpg-access-key-id'],
      ['garage-offsite', 'cnpg-secret-access-key'],
    ]);

    const without = await withBackup({ externalSecret: false });
    expect(kinds(without)).not.toContain('ExternalSecret');
    expect(kinds(without)).toContain('ObjectStore');
  });

  test('refuses an ExternalSecret with no 1Password item', async () => {
    await expect(withBackup({ item: '' })).rejects.toThrow('backup.item');
  });
});
