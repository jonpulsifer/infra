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

describe('workload identity', () => {
  test('only the reconciler receives audience-scoped cluster and GCP tokens', async () => {
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
    expect(web.volumes).toEqual([{ name: 'tmp', emptyDir: {} }]);

    expect(reconciler.serviceAccountName).toBe('spindrift');
    expect(reconciler.automountServiceAccountToken).toBe(false);
    expect(reconciler.volumes).toContainEqual({
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
    expect(reconciler.containers[0].volumeMounts).toContainEqual({
      name: 'federated-identity',
      mountPath: '/var/run/secrets/spindrift',
      readOnly: true,
    });
    expect(reconciler.containers[0].env).toContainEqual({
      name: 'GOOGLE_APPLICATION_CREDENTIALS',
      value: '/var/run/secrets/spindrift/gcp-credentials.json',
    });
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

describe('installation manifest bootstrap', () => {
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
