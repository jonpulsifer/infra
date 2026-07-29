import { describe, expect, test } from 'bun:test';
import { one, render } from './render.ts';

describe('process topology', () => {
  test('renders the reconciler as an opt-in second process from the same image', async () => {
    const defaultDeployments = (await render())
      .filter((object) => object.kind === 'Deployment')
      .map((object) => object.metadata.name);
    expect(defaultDeployments).toEqual(['spindrift-web']);

    const objects = await render({ reconciler: { enabled: true } });
    const web = one(objects, 'Deployment', 'spindrift-web').spec.template.spec
      .containers[0];
    const reconciler = one(objects, 'Deployment', 'spindrift-reconciler').spec
      .template.spec.containers[0];

    expect(reconciler.image).toBe(web.image);
    expect(web.command).toEqual(['sh', '-c', 'bun run src/web/server.ts']);
    expect(reconciler.command).toEqual([
      'sh',
      '-c',
      'bun run src/reconciler/main.ts',
    ]);
  });
});

describe('declarative schema ordering', () => {
  test('renders the database, migration Job, and both gated healthy processes', async () => {
    const objects = await render({
      database: { enabled: true },
      reconciler: { enabled: true },
    });
    one(objects, 'Cluster', 'spindrift-db');
    const migration = one(objects, 'Job');
    expect(migration.metadata.labels?.['app.kubernetes.io/component']).toBe(
      'migration',
    );
    expect(migration.spec.backoffLimit).toBe(2147483647);
    expect(migration.spec.ttlSecondsAfterFinished).toBeUndefined();
    expect(migration.spec.template.spec.containers[0].command).toEqual([
      'sh',
      '-c',
      expect.stringContaining('applyMigrations'),
    ]);

    for (const name of ['spindrift-web', 'spindrift-reconciler']) {
      const deployment = one(objects, 'Deployment', name);
      const waitCommand =
        deployment.spec.template.spec.initContainers[0].command;
      expect(waitCommand.slice(0, 2)).toEqual(['sh', '-c']);
      expect(waitCommand[2]).toContain('wait-for-schema.ts');
      expect(waitCommand[2]).toContain('drizzle.__drizzle_migrations');
      expect(
        deployment.spec.template.spec.initContainers[0].env,
      ).toContainEqual({
        name: 'DATABASE_URL',
        valueFrom: {
          secretKeyRef: { name: 'spindrift-db-app', key: 'uri' },
        },
      });
    }
    const web = one(objects, 'Deployment', 'spindrift-web');
    expect(
      web.spec.template.spec.containers[0].readinessProbe.httpGet.path,
    ).toBe('/healthz');
  });
});

describe('workload identity', () => {
  test('both processes receive the identities their adapter reads require', async () => {
    const objects = await render({
      reconciler: { enabled: true },
      serviceAccount: {
        token: {
          gcpAudience:
            '//iam.googleapis.com/projects/629296473058/locations/global/workloadIdentityPools/fml-pool/providers/offsite',
        },
      },
    });
    const account = one(objects, 'ServiceAccount', 'spindrift');
    expect(account.automountServiceAccountToken).toBe(false);

    const web = one(objects, 'Deployment', 'spindrift-web').spec.template.spec;
    const reconciler = one(objects, 'Deployment', 'spindrift-reconciler').spec
      .template.spec;

    expect(web.serviceAccountName).toBe('spindrift');
    expect(reconciler.serviceAccountName).toBe('spindrift');
    for (const process of [web, reconciler]) {
      expect(process.automountServiceAccountToken).toBe(false);
      expect(process.volumes).toContainEqual({
        name: 'federated-identity',
        projected: {
          sources: [
            {
              serviceAccountToken: {
                audience: 'api',
                expirationSeconds: 3600,
                path: 'token',
              },
            },
            {
              configMap: {
                name: 'kube-root-ca.crt',
                items: [{ key: 'ca.crt', path: 'ca.crt' }],
              },
            },
            {
              serviceAccountToken: {
                audience:
                  '//iam.googleapis.com/projects/629296473058/locations/global/workloadIdentityPools/fml-pool/providers/offsite',
                expirationSeconds: 3600,
                path: 'gcp-token',
              },
            },
            {
              configMap: {
                name: 'spindrift-federated-identity',
                items: [
                  {
                    key: 'gcp-credentials.json',
                    path: 'gcp-credentials.json',
                  },
                ],
              },
            },
          ],
        },
      });
      expect(process.containers[0].volumeMounts).toContainEqual({
        name: 'federated-identity',
        mountPath: '/var/run/secrets/spindrift',
        readOnly: true,
      });
      expect(process.containers[0].env).toContainEqual({
        name: 'GOOGLE_APPLICATION_CREDENTIALS',
        value: '/var/run/secrets/spindrift/gcp-credentials.json',
      });
      expect(process.containers[0].env).toContainEqual({
        name: 'NODE_EXTRA_CA_CERTS',
        value: '/var/run/secrets/spindrift/ca.crt',
      });
    }
  });
});

describe('Secret-backed authentication configuration', () => {
  test('rotating the enrolment token rolls every process reading the Secret', async () => {
    const deployments = (
      await render({ envFromSecret: 'spindrift-env' })
    ).filter((object) => object.kind === 'Deployment');
    expect(deployments).not.toHaveLength(0);
    for (const deployment of deployments) {
      expect(
        deployment.metadata.annotations?.[
          'secret.reloader.stakater.com/reload'
        ],
      ).toBe('spindrift-env');
    }
  });
});

describe('migration Job identity', () => {
  const database = {
    enabled: true,
    migration: {
      enabled: true,
      command: 'bun run migrate',
    },
  };

  test('is stable for the same execution inputs and excludes chart revision labels', async () => {
    const first = one(await render({ database }), 'Job');
    const second = one(await render({ database }), 'Job');

    expect(first.metadata.name).toBe(second.metadata.name);
    expect(first.metadata.name).toMatch(/^spindrift-migrate-[a-f0-9]{20}$/);
    expect(first.spec.template.metadata.labels).toEqual({
      'app.kubernetes.io/name': 'spindrift',
      'app.kubernetes.io/component': 'migration',
    });
  });

  test('changes when an immutable execution input changes', async () => {
    const first = one(await render({ database }), 'Job');
    const changed = one(
      await render({
        database: {
          ...database,
          migration: {
            enabled: true,
            command: 'bun run migrate --strict',
          },
        },
      }),
      'Job',
    );

    expect(changed.metadata.name).not.toBe(first.metadata.name);
  });
});

describe('declared installation manifest', () => {
  test('mounts ordinary configuration from a ConfigMap in every process', async () => {
    const objects = await render({
      installationManifest: { installation: 'example' },
      reconciler: { enabled: true },
      envFromSecret: 'spindrift-env',
    });
    const manifest = one(
      objects,
      'ConfigMap',
      'spindrift-installation-manifest',
    );
    expect(Bun.YAML.parse(manifest.data?.['manifest.yaml'] ?? '')).toEqual({
      installation: 'example',
    });

    const deployments = objects.filter(
      (object) => object.kind === 'Deployment',
    );
    expect(deployments).toHaveLength(2);
    for (const deployment of deployments) {
      const pod = deployment.spec.template.spec;
      expect(
        deployment.spec.template.metadata.annotations?.[
          'checksum/installation-manifest'
        ],
      ).toMatch(/^[a-f0-9]{64}$/);
      expect(pod.volumes).toContainEqual({
        name: 'installation-manifest',
        configMap: { name: 'spindrift-installation-manifest' },
      });
      expect(pod.containers[0].volumeMounts).toContainEqual({
        name: 'installation-manifest',
        mountPath: '/etc/spindrift',
        readOnly: true,
      });
      expect(pod.containers[0].env).toContainEqual({
        name: 'SPINDRIFT_MANIFEST_PATH',
        value: '/etc/spindrift/manifest.yaml',
      });
      expect(
        pod.containers[0].env.some(
          (item: { name: string }) => item.name === 'SPINDRIFT_MANIFEST',
        ),
      ).toBe(false);
    }
  });

  test('rolls every process when declared configuration changes', async () => {
    const first = await render({
      installationManifest: { installation: 'first' },
      reconciler: { enabled: true },
    });
    const second = await render({
      installationManifest: { installation: 'second' },
      reconciler: { enabled: true },
    });

    const checksums = (objects: typeof first) =>
      objects
        .filter((object) => object.kind === 'Deployment')
        .map(
          (deployment) =>
            deployment.spec.template.metadata.annotations[
              'checksum/installation-manifest'
            ],
        );
    expect(new Set(checksums(first))).toHaveLength(1);
    expect(new Set(checksums(second))).toHaveLength(1);
    expect(checksums(first)[0]).not.toBe(checksums(second)[0]);
  });

  test('does not add a manifest checksum without a declaration', async () => {
    const deployment = one(await render(), 'Deployment', 'spindrift-web');
    expect(
      deployment.spec.template.metadata.annotations?.[
        'checksum/installation-manifest'
      ],
    ).toBeUndefined();
  });
});

describe('authenticated Gateway trust', () => {
  test('is disabled without a network boundary', async () => {
    const objects = await render();
    expect(objects.some((object) => object.kind === 'NetworkPolicy')).toBe(
      false,
    );
    const web = one(objects, 'Deployment', 'spindrift-web');
    expect(
      web.spec.template.spec.containers[0].env.some(
        (item: { name: string }) =>
          item.name === 'SPINDRIFT_TRUSTED_GATEWAY_BOUNDARY',
      ),
    ).toBe(false);
  });

  test('renders default-deny ingress and the process attestation together', async () => {
    const objects = await render({
      gatewayAuth: {
        enabled: true,
        from: [
          {
            namespaceSelector: {
              matchLabels: {
                'kubernetes.io/metadata.name': 'gateway',
              },
            },
          },
        ],
      },
    });
    const policy = one(objects, 'NetworkPolicy');
    expect(policy.spec.policyTypes).toEqual(['Ingress']);
    expect(policy.spec.ingress[0].from).toEqual([
      {
        namespaceSelector: {
          matchLabels: { 'kubernetes.io/metadata.name': 'gateway' },
        },
      },
    ]);

    const web = one(objects, 'Deployment', 'spindrift-web');
    expect(web.spec.template.spec.containers[0].env).toContainEqual({
      name: 'SPINDRIFT_TRUSTED_GATEWAY_BOUNDARY',
      value: 'true',
    });
  });

  test('cannot attest the boundary without at least one trusted peer', async () => {
    await expect(
      render({ gatewayAuth: { enabled: true, from: [] } }),
    ).rejects.toThrow('gatewayAuth.from must name at least one');
  });
});
