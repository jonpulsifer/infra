import { describe, expect, test } from 'bun:test';
import { one, render } from './render.ts';

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
