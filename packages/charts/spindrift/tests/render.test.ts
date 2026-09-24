import { describe, expect, test } from 'bun:test';
import { one, type RenderedObject, render } from './render.ts';

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
    expect(web.command).toEqual(['bun', 'run', 'src/web/server.ts']);
    expect(reconciler.command).toEqual([
      'bun',
      'run',
      'src/reconciler/main.ts',
    ]);
  });
});

describe('the database keep policy', () => {
  test('keeps the Cluster on uninstall by default, because the PVC dies with it', async () => {
    const objects = await render({ database: { enabled: true } });
    expect(
      one(objects, 'Cluster', 'spindrift-db').metadata.annotations?.[
        'helm.sh/resource-policy'
      ],
    ).toBe('keep');
  });

  test('lets a release opt into a real teardown', async () => {
    const objects = await render({
      database: { enabled: true, keepOnDelete: false },
    });
    expect(
      one(objects, 'Cluster', 'spindrift-db').metadata.annotations?.[
        'helm.sh/resource-policy'
      ],
    ).toBeUndefined();
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
      'bun',
      'run',
      'src/db/migrate.ts',
    ]);

    for (const name of ['spindrift-web', 'spindrift-reconciler']) {
      const deployment = one(objects, 'Deployment', name);
      expect(deployment.spec.template.spec.initContainers[0].command).toEqual([
        'bun',
        'run',
        'src/db/wait-for-schema.ts',
      ]);
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
    ).toBe('/readyz');
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
  const database = { enabled: true, migration: { enabled: true } };

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
      await render({ database, image: 'ghcr.io/jonpulsifer/spindrift:next' }),
      'Job',
    );

    expect(changed.metadata.name).not.toBe(first.metadata.name);
  });
});

describe('ui-driven installation configuration', () => {
  test('renders deployments with no installation manifest to read at all', async () => {
    // The installation manifest lives in the database; no chart key can declare one.
    const objects = await render({
      reconciler: { enabled: true },
      envFromSecret: 'spindrift-env',
      manifest: { installation: 'declared' },
    });
    expect(
      objects.some((object) => object.metadata.name === 'spindrift-manifest'),
    ).toBe(false);

    const deployments = objects.filter(
      (object) => object.kind === 'Deployment',
    );
    expect(deployments).toHaveLength(2);
    for (const deployment of deployments) {
      const pod = deployment.spec.template.spec;
      for (const name of ['SPINDRIFT_MANIFEST_PATH', 'SPINDRIFT_MANIFEST']) {
        expect(
          pod.containers[0].env.some(
            (item: { name: string }) => item.name === name,
          ),
        ).toBe(false);
      }
      expect(
        pod.volumes.some(
          (volume: { name: string }) => volume.name === 'manifest',
        ),
      ).toBe(false);
      expect(
        pod.containers[0].volumeMounts.some(
          (mount: { name: string }) => mount.name === 'manifest',
        ),
      ).toBe(false);
    }
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

describe('the credential is the only copy of the federation', () => {
  const audience =
    '//iam.example.test/projects/1/locations/global/workloadIdentityPools/example/providers/cluster';
  const impersonation =
    'https://iamcredentials.example.test/v1/projects/-/serviceAccounts/spindrift@example-home.example.test:generateAccessToken';

  test('renders a complete external_account document the process reads back', async () => {
    const objects = await render({
      serviceAccount: {
        token: { gcpAudience: audience, gcpImpersonationUrl: impersonation },
      },
    });
    const credential = one(
      objects,
      'ConfigMap',
      'spindrift-federated-identity',
    );
    // Rendered from release values alone, so no second copy can disagree.
    expect(JSON.parse(credential.data?.['gcp-credentials.json'] ?? '')).toEqual(
      {
        type: 'external_account',
        audience,
        subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
        token_url: 'https://sts.googleapis.com/v1/token',
        service_account_impersonation_url: impersonation,
        credential_source: { file: '/var/run/secrets/spindrift/gcp-token' },
      },
    );

    // ADC finds the credential through this path.
    const web = one(objects, 'Deployment', 'spindrift-web');
    expect(web.spec.template.spec.containers[0].env).toContainEqual({
      name: 'GOOGLE_APPLICATION_CREDENTIALS',
      value: '/var/run/secrets/spindrift/gcp-credentials.json',
    });
  });

  test('omits impersonation when the identity holds its own grants', async () => {
    const objects = await render({
      serviceAccount: { token: { gcpAudience: audience } },
    });
    const credential = JSON.parse(
      one(objects, 'ConfigMap', 'spindrift-federated-identity').data?.[
        'gcp-credentials.json'
      ] ?? '',
    );
    expect(credential).not.toHaveProperty('service_account_impersonation_url');
  });
});

const envOf = (objects: RenderedObject[], name: string) =>
  one(objects, 'Deployment', name).spec.template.spec.containers[0].env as {
    name: string;
    value?: string;
  }[];

describe('the relying party is the front door', () => {
  test('is the hostname this release serves, not a manifest key', async () => {
    const objects = await render({ hostname: 'spindrift.example.test' });
    // The relying party and the HTTPRoute both come from `hostname`.
    expect(
      envOf(objects, 'spindrift-web').find(
        (item) => item.name === 'SPINDRIFT_HOSTNAME',
      )?.value,
    ).toBe('spindrift.example.test');
    expect(
      one(objects, 'HTTPRoute', 'spindrift-http-route').spec.hostnames,
    ).toEqual(['spindrift.example.test']);
  });

  test('is unset for a release that serves no origin', async () => {
    // An empty `hostname` is a valid installation with no origin, which enrols nobody.
    const objects = await render();
    expect(objects.some((object) => object.kind === 'HTTPRoute')).toBe(false);
    expect(
      envOf(objects, 'spindrift-web').some(
        (item) => item.name === 'SPINDRIFT_HOSTNAME',
      ),
    ).toBe(false);
  });
});

describe('the machine routes answer on the Service', () => {
  test('the web process is told the Service in front of it', async () => {
    const objects = await render({
      reconciler: { enabled: true },
      fullnameOverride: 'kthx',
      namespaceOverride: 'platform',
    });
    const service = one(objects, 'Service', 'kthx');
    const web = envOf(objects, 'kthx-web');
    expect(web).toContainEqual({
      name: 'SPINDRIFT_SERVICE_NAME',
      value: service.metadata.name,
    });
    expect(web).toContainEqual({
      name: 'SPINDRIFT_SERVICE_NAMESPACE',
      value: service.metadata.namespace,
    });
    expect(
      envOf(objects, 'kthx-reconciler').some((item) =>
        item.name.startsWith('SPINDRIFT_SERVICE_'),
      ),
    ).toBe(false);
  });
});

describe('the trust store', () => {
  const federated = (caConfigMap?: string) => ({
    reconciler: { enabled: true },
    serviceAccount: {
      token: {
        gcpAudience:
          '//iam.googleapis.com/projects/629296473058/locations/global/workloadIdentityPools/fml-pool/providers/offsite',
        ...(caConfigMap === undefined ? {} : { caConfigMap }),
      },
    },
  });

  const trustSource = (objects: RenderedObject[], name: string) =>
    objects
      .filter((object) => object.kind === 'Deployment')
      .find((object) => object.metadata.name === name)
      ?.spec.template.spec.volumes.find(
        (volume: { name: string }) => volume.name === 'federated-identity',
      ).projected.sources;

  test('the projected ca.crt follows the configured ConfigMap', async () => {
    // `NODE_EXTRA_CA_CERTS` names one file, and a projected volume cannot merge two sources
    // onto one path, so the configured ConfigMap replaces the default.
    const objects = await render(federated('spindrift-ca-bundle'));
    for (const name of ['spindrift-web', 'spindrift-reconciler']) {
      expect(trustSource(objects, name)).toContainEqual({
        configMap: {
          name: 'spindrift-ca-bundle',
          items: [{ key: 'ca.crt', path: 'ca.crt' }],
        },
      });
    }
  });

  // Read from the rendered pod spec: the guarded failure is the Reloader annotation
  // disagreeing with the projected ConfigMap.
  const projectedBundle = (objects: RenderedObject[], name: string) =>
    trustSource(objects, name)?.find(
      (source: { configMap?: { items?: { path: string }[] } }) =>
        source.configMap?.items?.some((item) => item.path === 'ca.crt'),
    )?.configMap.name;

  const reloadsFor = (objects: RenderedObject[], name: string) =>
    objects
      .filter((object) => object.kind === 'Deployment')
      .find((object) => object.metadata.name === name)?.metadata.annotations?.[
      'configmap.reloader.stakater.com/reload'
    ];

  test('both processes roll when the bundle they project changes', async () => {
    // `NODE_EXTRA_CA_CERTS` is read once at start, so only a restart applies a changed bundle,
    // including `kube-root-ca.crt` after a cluster CA rotation.
    for (const values of [federated(), federated('spindrift-ca-bundle')]) {
      const objects = await render(values);
      // `toBeString` keeps an unrendered pod spec from passing as undefined on both sides.
      for (const name of ['spindrift-web', 'spindrift-reconciler']) {
        expect(projectedBundle(objects, name)).toBeString();
        expect(reloadsFor(objects, name)).toBe(projectedBundle(objects, name));
      }
    }
  });

  test('it defaults to the cluster’s own published root', async () => {
    // Enough for in-cluster Targets when the cluster's root is self-signed.
    expect(
      trustSource(await render(federated()), 'spindrift-web'),
    ).toContainEqual({
      configMap: {
        name: 'kube-root-ca.crt',
        items: [{ key: 'ca.crt', path: 'ca.crt' }],
      },
    });
  });
});
