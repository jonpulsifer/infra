/**
 * The App chart's rendering goldens (§7).
 *
 * § Not a seam: "Chart correctness is asserted where the chart lives, as
 * `helm template` goldens over representative value sets... This is a rendering
 * assertion, not a Spindrift test, and it must not be reached through the
 * command layer." Nothing in this file imports Spindrift.
 *
 * Each `describe` below is one of the claims §7 makes about the chart, and each
 * is a claim a wrong rendering would silently satisfy in a cluster — a missing
 * NetworkPolicy, a Job that cannot be upgraded, a per-deploy label in an
 * immutable selector — which is why they are asserted here rather than trusted.
 */
import { describe, expect, test } from 'bun:test';
import { chartMetadata, kinds, one, render } from './render.ts';

describe('kind branches', () => {
  test('a service renders a Deployment, a Service, and a route', async () => {
    const objects = await render();
    expect(kinds(objects).sort()).toEqual([
      'Deployment',
      'HTTPRoute',
      'NetworkPolicy',
      'Service',
    ]);
    const deployment = one(objects, 'Deployment');
    expect(deployment.spec.template.spec.containers[0].image).toBe(
      'registry.example.test/blog/web@sha256:feed',
    );
  });

  test('an unexposed service is a queue worker: no Service, no route', async () => {
    // §2: "`expose` is a field on a service; an unexposed service is a queue
    // worker." Nothing routes to it and nothing needs to.
    const objects = await render({ app: { expose: false } });
    expect(kinds(objects).sort()).toEqual(['Deployment', 'NetworkPolicy']);
  });

  test('a job always renders a CronJob and never a Deployment', async () => {
    const objects = await render({ app: { kind: 'job' } });
    expect(kinds(objects).sort()).toEqual(['CronJob', 'NetworkPolicy']);
  });
});

describe('website is not a branch', () => {
  test('it renders a Deployment and a Service, exactly like a service', async () => {
    const website = await render({ app: { kind: 'website' } });
    expect(kinds(website).sort()).toEqual([
      'Deployment',
      'HTTPRoute',
      'NetworkPolicy',
      'Service',
    ]);
  });

  test('expose is forced: `expose: false` does not un-expose a website', async () => {
    // §7: a website is "a service with `expose` forced and a fixed port, every
    // difference a value rather than a template". A value that could turn a
    // website into a queue worker would make it a branch after all.
    const objects = await render({
      app: { kind: 'website', expose: false },
    });
    expect(kinds(objects)).toContain('Service');
  });

  test('the port is the fixed one, not the service port', async () => {
    const objects = await render({
      app: { kind: 'website', port: 9999, websitePort: 3000 },
    });
    expect(one(objects, 'Service').spec.ports[0].port).toBe(3000);
    const container = one(objects, 'Deployment').spec.template.spec
      .containers[0];
    expect(container.ports[0].containerPort).toBe(3000);
  });
});

describe('the suspended CronJob', () => {
  test('an unscheduled job is suspended, on a date that never occurs', async () => {
    const cronJob = one(await render({ app: { kind: 'job' } }), 'CronJob');
    expect(cronJob.spec.suspend).toBe(true);
    // 31 February: the schedule field is required, so the belt is a date the
    // clock cannot reach even if something un-suspends the object.
    expect(cronJob.spec.schedule).toBe('0 0 31 2 *');
  });

  test('a scheduled job carries its schedule and is not suspended', async () => {
    const cronJob = one(
      await render({ app: { kind: 'job', schedule: '17 4 * * *' } }),
      'CronJob',
    );
    expect(cronJob.spec.suspend).toBe(false);
    expect(cronJob.spec.schedule).toBe('17 4 * * *');
  });

  test('it keeps an execution history a Job could not', async () => {
    // The reason a job is a CronJob at all: Helm prunes the old Job on upgrade,
    // which would cut an N-deep history to one, silently (§7).
    const cronJob = one(await render({ app: { kind: 'job' } }), 'CronJob');
    expect(cronJob.spec.successfulJobsHistoryLimit).toBeGreaterThan(1);
    expect(cronJob.spec.failedJobsHistoryLimit).toBeGreaterThan(1);
  });
});

describe('the three exclusions', () => {
  const excluded = ['Cluster', 'Gateway', 'Certificate', 'Namespace'];

  test('no Datastore, no Gateway or certificate, no Namespace', async () => {
    // All three are vessel (§7). A release-scoped datastore would be destroyed
    // by `destroy()`; a release-scoped gateway would take every other App's
    // routes with it.
    for (const values of [
      {},
      { app: { kind: 'job' } },
      { app: { kind: 'website' } },
      { app: { exposure: 'public' } },
    ]) {
      const rendered = kinds(await render(values));
      for (const kind of excluded) expect(rendered).not.toContain(kind);
    }
  });

  test('objects land in the release namespace without declaring it', async () => {
    const objects = await render();
    for (const object of objects) {
      expect(object.metadata.namespace).toBe('apps');
    }
  });
});

describe('the deploy label', () => {
  test('it is on the pod template', async () => {
    const deployment = one(await render(), 'Deployment');
    expect(
      deployment.spec.template.metadata.labels['spindrift.dev/artifact'],
    ).toBe('sha256:feed');
  });

  test('it is never in a selector', async () => {
    // §7: the selector is immutable, so a per-deploy value in one would brick
    // every upgrade after the first.
    const objects = await render();
    const deployment = one(objects, 'Deployment');
    const service = one(objects, 'Service');
    const policy = one(objects, 'NetworkPolicy');

    expect(Object.keys(deployment.spec.selector.matchLabels)).not.toContain(
      'spindrift.dev/artifact',
    );
    expect(Object.keys(service.spec.selector)).not.toContain(
      'spindrift.dev/artifact',
    );
    expect(Object.keys(policy.spec.podSelector.matchLabels)).not.toContain(
      'spindrift.dev/artifact',
    );
  });

  test('a job carries it on the pod template too', async () => {
    const cronJob = one(await render({ app: { kind: 'job' } }), 'CronJob');
    expect(
      cronJob.spec.jobTemplate.spec.template.metadata.labels[
        'spindrift.dev/artifact'
      ],
    ).toBe('sha256:feed');
  });

  test('two deploys of the same Component keep one selector', async () => {
    const first = one(
      await render({ app: { artifactDigest: 'sha256:feed' } }),
      'Deployment',
    );
    const second = one(
      await render({ app: { artifactDigest: 'sha256:two' } }),
      'Deployment',
    );
    expect(second.spec.selector).toEqual(first.spec.selector);
    expect(second.spec.template.metadata.labels).not.toEqual(
      first.spec.template.metadata.labels,
    );
  });
});

describe('the value contract', () => {
  test('the chart declares its version where pin time reads it', async () => {
    const chart = await chartMetadata();
    expect(chart.name).toBe('spindrift-app');
    expect(chart.annotations?.['spindrift.dev/values-contract']).toBe('1');
  });

  test('every rendered object carries the version it was rendered under', async () => {
    // Helm ignores unknown values silently (§7), so a cluster object has to be
    // traceable to the contract that produced it without holding the chart.
    const chart = await chartMetadata();
    const declared = chart.annotations?.['spindrift.dev/values-contract'];
    for (const values of [{}, { app: { kind: 'job' } }]) {
      for (const object of await render(values)) {
        expect(
          object.metadata.annotations?.['spindrift.dev/values-contract'],
        ).toBe(declared);
      }
    }
  });
});

describe('fixed defaults', () => {
  test('readiness on the port, and no liveness probe', async () => {
    const container = one(await render(), 'Deployment').spec.template.spec
      .containers[0];
    expect(container.readinessProbe.tcpSocket.port).toBe(8080);
    expect(container.livenessProbe).toBeUndefined();
  });

  test('hardening has no per-App opt-out', async () => {
    // §7 fixes these, which is what constrains the zero-config base image to a
    // non-root, read-only-rootfs shape. A value that could relax one would make
    // the constraint advisory.
    const pod = one(
      await render({ app: { securityContext: { runAsUser: 0 } } }),
      'Deployment',
    ).spec.template.spec;
    expect(pod.automountServiceAccountToken).toBe(false);
    expect(pod.securityContext.runAsNonRoot).toBe(true);
    const security = pod.containers[0].securityContext;
    expect(security.runAsNonRoot).toBe(true);
    expect(security.readOnlyRootFilesystem).toBe(true);
    expect(security.allowPrivilegeEscalation).toBe(false);
    expect(security.capabilities.drop).toEqual(['ALL']);
    expect(security.seccompProfile.type).toBe('RuntimeDefault');
  });

  test('the sandbox runtime class is an operator value, unset by default', async () => {
    const bare = one(await render(), 'Deployment');
    expect(bare.spec.template.spec.runtimeClassName).toBeUndefined();
    const sandboxed = one(
      await render({ platform: { runtimeClassName: 'gvisor' } }),
      'Deployment',
    );
    expect(sandboxed.spec.template.spec.runtimeClassName).toBe('gvisor');
  });

  test('NetworkPolicy is on and PodDisruptionBudget is off', async () => {
    // §7: `minAvailable: 1` at one replica blocks node drain forever on hosts
    // that reboot to auto-upgrade, so there is no PDB to render.
    for (const values of [{}, { app: { kind: 'job' } }]) {
      const rendered = kinds(await render(values));
      expect(rendered).toContain('NetworkPolicy');
      expect(rendered).not.toContain('PodDisruptionBudget');
    }
  });

  test('ingress is default-deny with the operator’s named exceptions', async () => {
    // §8: "the shape is fixed while the names are Target configuration".
    const policy = one(await render(), 'NetworkPolicy');
    expect(policy.spec.policyTypes).toEqual(['Ingress']);
    const from = policy.spec.ingress[0].from;
    expect(from[0]).toEqual({ podSelector: {} });
    expect(from.slice(1)).toEqual([
      {
        namespaceSelector: {
          matchLabels: { 'kubernetes.io/metadata.name': 'gateway' },
        },
      },
      {
        namespaceSelector: {
          matchLabels: { 'kubernetes.io/metadata.name': 'monitoring' },
        },
      },
    ]);
  });
});

describe('the route', () => {
  test('it attaches to the shared gateway, and renders neither', async () => {
    const route = one(await render(), 'HTTPRoute');
    expect(route.spec.parentRefs).toEqual([
      { name: 'cluster-gateway', namespace: 'gateway' },
    ]);
    expect(route.spec.hostnames).toEqual(['blog-web.apps.example.test']);
  });

  test('the vanity name rides the same route as the canonical one', async () => {
    const route = one(
      await render({
        app: {
          hostnames: ['blog-web.apps.example.test', 'blog.vanity.example.test'],
        },
      }),
      'HTTPRoute',
    );
    expect(route.spec.hostnames).toHaveLength(2);
  });

  test('an internal Component has no route at all', async () => {
    // §9: no non-public state may leave a bypassable origin, and a route onto
    // the shared gateway is exactly that for a Target-private workload.
    const objects = await render({ app: { exposure: 'internal' } });
    expect(kinds(objects)).not.toContain('HTTPRoute');
    expect(kinds(objects)).toContain('Service');
  });

  test('public and private route identically — the edge is the difference', async () => {
    const asPrivate = one(
      await render({ app: { exposure: 'private' } }),
      'HTTPRoute',
    );
    const asPublic = one(
      await render({ app: { exposure: 'public' } }),
      'HTTPRoute',
    );
    expect(asPublic.spec).toEqual(asPrivate.spec);
  });
});

describe('config delivery', () => {
  test('one secret per variable, never a blob', async () => {
    // §10: per-key, not per-blob. An `envFrom` here would be the blob.
    const container = one(
      await render({
        app: {
          secretEnv: [
            { name: 'TOKEN', secretName: 'blog-web-token', key: 'value' },
            { name: 'DSN', secretName: 'blog-web-dsn', key: 'value' },
          ],
        },
      }),
      'Deployment',
    ).spec.template.spec.containers[0];

    expect(container.envFrom).toBeUndefined();
    const names = container.env.map((entry: { name: string }) => entry.name);
    expect(names).toContain('TOKEN');
    expect(names).toContain('DSN');
    const token = container.env.find(
      (entry: { name: string }) => entry.name === 'TOKEN',
    );
    expect(token.valueFrom.secretKeyRef).toEqual({
      name: 'blog-web-token',
      key: 'value',
    });
  });

  test('no Component-declared volumes beyond the writable /tmp', async () => {
    // §7 deletes PVC lifecycle, orphan tracking, and the silent recreate
    // strategy by having no volume a Component can declare.
    const pod = one(await render(), 'Deployment').spec.template.spec;
    expect(pod.volumes).toEqual([{ name: 'tmp', emptyDir: {} }]);
  });
});
