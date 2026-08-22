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
  test('renders deployments without requiring a file-based installation manifest', async () => {
    const objects = await render({
      reconciler: { enabled: true },
      envFromSecret: 'spindrift-env',
    });
    const deployments = objects.filter(
      (object) => object.kind === 'Deployment',
    );
    expect(deployments).toHaveLength(2);
    for (const deployment of deployments) {
      const pod = deployment.spec.template.spec;
      expect(
        pod.containers[0].env.some(
          (item: { name: string }) => item.name === 'SPINDRIFT_MANIFEST_PATH',
        ),
      ).toBe(false);
      expect(
        pod.containers[0].env.some(
          (item: { name: string }) => item.name === 'SPINDRIFT_MANIFEST',
        ),
      ).toBe(false);
    }
  });

  test('renders no manifest ConfigMap when the release declares none', async () => {
    const objects = await render({ reconciler: { enabled: true } });
    expect(
      objects.some((object) => object.metadata.name === 'spindrift-manifest'),
    ).toBe(false);
    for (const deployment of objects.filter(
      (object) => object.kind === 'Deployment',
    )) {
      const pod = deployment.spec.template.spec;
      expect(
        pod.volumes.some(
          (volume: { name: string }) => volume.name === 'manifest',
        ),
      ).toBe(false);
    }
  });

  test('mounts a declared manifest at the path both processes read', async () => {
    const manifest = { installation: 'declared', build: { routes: [] } };
    const objects = await render({ manifest, reconciler: { enabled: true } });

    const configMap = one(objects, 'ConfigMap', 'spindrift-manifest');
    expect(Bun.YAML.parse(configMap.data?.['manifest.yaml'] ?? '')).toEqual(
      manifest,
    );

    const deployments = objects.filter(
      (object) => object.kind === 'Deployment',
    );
    expect(deployments).toHaveLength(2);
    for (const deployment of deployments) {
      const pod = deployment.spec.template.spec;
      // The declaration is named, not left to the default path, so a mount that
      // never lands is fatal rather than a silent fall back to the stored row.
      expect(pod.containers[0].env).toContainEqual({
        name: 'SPINDRIFT_MANIFEST_PATH',
        value: '/etc/spindrift/manifest.yaml',
      });
      expect(pod.containers[0].volumeMounts).toContainEqual({
        name: 'manifest',
        mountPath: '/etc/spindrift',
        readOnly: true,
      });
      expect(pod.volumes).toContainEqual({
        name: 'manifest',
        configMap: { name: 'spindrift-manifest' },
      });
    }
  });

  test('rolls both processes when the declared manifest changes', async () => {
    const checksums = async (manifest: Record<string, unknown>) =>
      (await render({ manifest, reconciler: { enabled: true } }))
        .filter((object) => object.kind === 'Deployment')
        .map(
          (object) =>
            object.spec.template.metadata.annotations?.['checksum/manifest'],
        );

    const before = await checksums({ installation: 'declared' });
    const after = await checksums({ installation: 'retuned' });

    expect(before).toHaveLength(2);
    for (const checksum of before) expect(checksum).toBeString();
    // Both processes read the manifest once at start, so a ConfigMap change
    // that does not restart them is a declaration that does nothing.
    expect(after[0]).not.toBe(before[0]);
    expect(after[1]).not.toBe(before[1]);
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
    // Every fact `cloud.federation` used to ask for by hand, rendered once,
    // from values a release already sets. The manifest has no key for any of
    // them, so nothing is left that could disagree.
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

    // And the deployment points ADC at exactly that file, which is how the
    // process finds it without being told a second time.
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

  test('refuses a declaration that restates the federation', async () => {
    await expect(
      render({
        manifest: {
          installation: 'declared',
          cloud: { federation: { audience: '//iam.stale.test/pools/stale' } },
        },
      }),
    ).rejects.toThrow('manifest.cloud is not a manifest key');
  });

  test('refuses a declaration that states the home vessel’s projects', async () => {
    // The whole `cloud` key, not the federation alone: the artifacts project
    // and the project the home vessel is are properties of the vessel
    // `installation.homeVessel` names, so a document restating them there is
    // two answers to one question and is refused at render time.
    await expect(
      render({
        manifest: {
          installation: 'declared',
          cloud: { artifactsProject: 'stale-artifacts' },
        },
      }),
    ).rejects.toThrow('properties of the vessel installation.homeVessel names');
  });

  test('refuses a declaration that names the chart it was installed from', async () => {
    await expect(
      render({
        manifest: {
          installation: 'declared',
          charts: { app: 'example/spindrift-app', installer: 'example/x' },
        },
      }),
    ).rejects.toThrow('manifest.charts.installer is not a manifest key');
  });
});

describe('the relying party is the front door', () => {
  const envOf = (objects: RenderedObject[], name: string) =>
    one(objects, 'Deployment', name).spec.template.spec.containers[0].env as {
      name: string;
      value?: string;
    }[];

  test('is the hostname this release serves, not a manifest key', async () => {
    const objects = await render({ hostname: 'spindrift.example.test' });
    // One value, so there is nothing for a second copy to disagree with: the
    // env the process binds its relying party from and the name the HTTPRoute
    // answers on are the same `hostname`.
    expect(
      envOf(objects, 'spindrift-web').find(
        (item) => item.name === 'SPINDRIFT_HOSTNAME',
      )?.value,
    ).toBe('spindrift.example.test');
    expect(
      one(objects, 'HTTPRoute', 'spindrift-http-route').spec.hostnames,
    ).toEqual(['spindrift.example.test']);
  });

  test('refuses a declaration that restates it', async () => {
    await expect(
      render({
        hostname: 'spindrift.example.test',
        manifest: {
          installation: 'declared',
          controlPlane: { hostname: 'spindrift.example.test' },
        },
      }),
    ).rejects.toThrow('manifest.controlPlane is not a manifest key');
  });

  test('is unset for a release that serves no origin', async () => {
    // The chart's `hostname` may be empty — no Gateway, no HTTPRoute, still a
    // valid installation. It has no origin, so it has nothing to scope a
    // ceremony to and enrols nobody; the process falls back to the hostname a
    // browser refuses rather than to an empty string.
    const objects = await render();
    expect(objects.some((object) => object.kind === 'HTTPRoute')).toBe(false);
    expect(
      envOf(objects, 'spindrift-web').some(
        (item) => item.name === 'SPINDRIFT_HOSTNAME',
      ),
    ).toBe(false);
  });
});

describe('the manifest ConfigMap', () => {
  test('is not rendered for a release that declares nothing', async () => {
    // A release with a hostname and no declaration mounts no document at all
    // and still enrols its first operator, because the relying party is the
    // env above rather than something a seeded document has to carry.
    const objects = await render({ hostname: 'spindrift.example.test' });
    expect(
      objects.some((object) => object.metadata.name === 'spindrift-manifest'),
    ).toBe(false);
    const pod = one(objects, 'Deployment', 'spindrift-web').spec.template.spec;
    expect(
      pod.containers[0].env.some(
        (item: { name: string }) => item.name === 'SPINDRIFT_MANIFEST_PATH',
      ),
    ).toBe(false);
    expect(
      pod.volumes.some((v: { name: string }) => v.name === 'manifest'),
    ).toBe(false);
  });

  test('carries a declaration verbatim when the release states one', async () => {
    const objects = await render({
      hostname: 'spindrift.example.test',
      manifest: { installation: 'declared' },
    });
    const configMap = one(objects, 'ConfigMap', 'spindrift-manifest');
    expect(Bun.YAML.parse(configMap.data?.['manifest.yaml'] ?? '')).toEqual({
      installation: 'declared',
    });
    const pod = one(objects, 'Deployment', 'spindrift-web').spec.template.spec;
    expect(
      pod.containers[0].env.some(
        (item: { name: string }) => item.name === 'SPINDRIFT_MANIFEST_PATH',
      ),
    ).toBe(true);
    expect(
      pod.volumes.some((v: { name: string }) => v.name === 'manifest'),
    ).toBe(true);
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
    // `NODE_EXTRA_CA_CERTS` names exactly one file and a projected volume
    // cannot merge two sources onto one path, so an installation holding a
    // Target on another cluster has to replace the source rather than add one.
    // Before this was configurable, `folly` failed all six prerequisites with
    // "unable to verify the first certificate": the in-cluster
    // `kube-root-ca.crt` carries this cluster's root and nothing else.
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

  // The ConfigMap each Deployment actually projects at `ca.crt`, read back out
  // of the rendered pod spec. The Reloader annotation is checked against this
  // rather than against a literal, because the failure being guarded is the two
  // disagreeing — an annotation naming *a* ConfigMap proves nothing.
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
    // The criterion that decides whether the mechanism is real. `NODE_EXTRA_CA_
    // CERTS` is read once at process start, so a kubelet refresh of the mounted
    // file is a correction the running process never sees — and the annotation
    // has to name the ConfigMap the pod actually projects, on *both*
    // Deployments. A bundle somebody else owns counts: `kube-root-ca.crt` is
    // rewritten in place by a cluster CA rotation, and nothing else rolls these
    // pods for it. Offsite's CA adoption is the recorded proof of that — every
    // prerequisite failed "unable to verify the first certificate" against a
    // ConfigMap that was already correct.
    for (const values of [federated(), federated('spindrift-ca-bundle')]) {
      const objects = await render(values);
      // Both names, so the half-fix that leaves a stale reconciler holding the
      // old trust store fails here. `toBeString` so an unrendered pod spec
      // cannot pass this by making both sides undefined.
      for (const name of ['spindrift-web', 'spindrift-reconciler']) {
        expect(projectedBundle(objects, name)).toBeString();
        expect(reloadsFor(objects, name)).toBe(projectedBundle(objects, name));
      }
    }
  });

  test('it defaults to the cluster’s own published root', async () => {
    // Sufficient when that root is self-signed: an installation whose Targets
    // are all in-cluster on such a cluster needs nothing else, and must not
    // be made to declare a bundle to keep working.
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
