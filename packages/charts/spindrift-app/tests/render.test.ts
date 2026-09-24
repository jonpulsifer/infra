/**
 * Rendering assertions for the App chart. Nothing here imports the control plane.
 */
import { describe, expect, test } from 'bun:test';
import { chartMetadata, kinds, one, render } from './render.ts';

/** external-dns v0.22.0 moved the default annotation prefix, and a controller reads only one. */
const PREFIXES = [
  'external-dns.alpha.kubernetes.io/',
  'external-dns.kubernetes.io/',
];

function proxiedSpec(value: string) {
  return PREFIXES.map((prefix) => ({
    name: `${prefix}cloudflare-proxied`,
    value,
  }));
}

describe('kind branches', () => {
  test('a service renders a Deployment, a Service, and a route', async () => {
    const objects = await render();
    expect(kinds(objects).sort()).toEqual([
      'CiliumNetworkPolicy',
      'DNSEndpoint',
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
    const website = await render({
      app: { kind: 'website', expose: true, port: 8080 },
    });
    expect(kinds(website).sort()).toEqual([
      'CiliumNetworkPolicy',
      'DNSEndpoint',
      'Deployment',
      'HTTPRoute',
      'NetworkPolicy',
      'Service',
    ]);
  });

  test('the fixed website port arrives as the ordinary service value', async () => {
    const objects = await render({
      app: { kind: 'website', expose: true, port: 8080 },
    });
    expect(one(objects, 'Service').spec.ports[0].port).toBe(8080);
    const container = one(objects, 'Deployment').spec.template.spec
      .containers[0];
    expect(container.ports[0].containerPort).toBe(8080);
  });
});

describe('the suspended CronJob', () => {
  test('an unscheduled job is suspended, on a date that never occurs', async () => {
    const cronJob = one(await render({ app: { kind: 'job' } }), 'CronJob');
    expect(cronJob.spec.suspend).toBe(true);
    // 31 February: `schedule` is required, so it names a date that never occurs.
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
    // Helm would prune a plain Job on upgrade, leaving one run of history.
    const cronJob = one(await render({ app: { kind: 'job' } }), 'CronJob');
    expect(cronJob.spec.successfulJobsHistoryLimit).toBeGreaterThan(1);
    expect(cronJob.spec.failedJobsHistoryLimit).toBeGreaterThan(1);
  });
});

describe('the three exclusions', () => {
  const excluded = ['Cluster', 'Gateway', 'Certificate', 'Namespace'];

  test('no Datastore, no Gateway or certificate, no Namespace', async () => {
    // These belong to the vessel: a release-scoped datastore dies with the release, and a
    // release-scoped gateway takes every other App's routes with it.
    for (const values of [
      {},
      { app: { kind: 'job' } },
      { app: { kind: 'website' } },
      { app: { reach: 'public', auth: 'none' } },
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
      deployment.spec.template.metadata.labels['spindrift.dev/deploy'],
    ).toBe('deploy-1');
  });

  test('it is never in a selector', async () => {
    // Selectors are immutable, so a per-deploy value would break every later upgrade.
    const objects = await render();
    const deployment = one(objects, 'Deployment');
    const service = one(objects, 'Service');
    const policy = one(objects, 'NetworkPolicy');

    expect(Object.keys(deployment.spec.selector.matchLabels)).not.toContain(
      'spindrift.dev/deploy',
    );
    expect(Object.keys(service.spec.selector)).not.toContain(
      'spindrift.dev/deploy',
    );
    expect(Object.keys(policy.spec.podSelector.matchLabels)).not.toContain(
      'spindrift.dev/deploy',
    );
  });

  test('a job carries it on the pod template too', async () => {
    const cronJob = one(await render({ app: { kind: 'job' } }), 'CronJob');
    expect(
      cronJob.spec.jobTemplate.spec.template.metadata.labels[
        'spindrift.dev/deploy'
      ],
    ).toBe('deploy-1');
  });

  test('two deploys of the same Component keep one selector', async () => {
    const first = one(
      await render({ app: { deployId: 'deploy-1' } }),
      'Deployment',
    );
    const second = one(
      await render({ app: { deployId: 'deploy-2' } }),
      'Deployment',
    );
    expect(second.spec.selector).toEqual(first.spec.selector);
    expect(second.spec.template.metadata.labels).not.toEqual(
      first.spec.template.metadata.labels,
    );
  });
});

describe('the value contract', () => {
  // The number itself is checked in `apps/spindrift`'s suite.
  test('every rendered object carries the version it was rendered under', async () => {
    // Helm ignores unknown values, so each object records the contract it was rendered under.
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

  test('the port it probes is the port it tells the process about', async () => {
    // A zero-config image listens on `PORT`, which nothing else sets on a cluster.
    const container = one(await render(), 'Deployment').spec.template.spec
      .containers[0];
    const port = container.env.find(
      (variable: { name: string }) => variable.name === 'PORT',
    );
    expect(port?.value).toBe(String(container.readinessProbe.tcpSocket.port));
  });

  test('hardening has no per-App opt-out', async () => {
    // The zero-config base image must run non-root on a read-only root filesystem.
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
    // `minAvailable: 1` at one replica would block the node drain of every auto-upgrade reboot.
    for (const values of [{}, { app: { kind: 'job' } }]) {
      const rendered = kinds(await render(values));
      expect(rendered).toContain('NetworkPolicy');
      expect(rendered).not.toContain('PodDisruptionBudget');
    }
  });

  test('ingress is default-deny with the operator’s named exceptions', async () => {
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

  test('a routed Component admits the gateway’s identity, not its namespace', async () => {
    // Cilium's host-networked gateway Envoy carries the `ingress` identity, which no
    // `namespaceSelector` matches; without this the listener answers 503.
    const objects = await render();
    const admission = one(objects, 'CiliumNetworkPolicy');
    expect(admission.apiVersion).toBe('cilium.io/v2');
    expect(admission.spec.endpointSelector.matchLabels).toEqual(
      one(objects, 'NetworkPolicy').spec.podSelector.matchLabels,
    );
    expect(admission.spec.ingress).toEqual([
      {
        fromEntities: ['ingress'],
        // A string: Cilium's port is not the integer a NetworkPolicy takes.
        toPorts: [{ ports: [{ port: '8080', protocol: 'TCP' }] }],
      },
    ]);
  });

  test('it renders for either routed reach, and never without a route', async () => {
    // Same condition as the route: `reach: none` has no gateway to admit.
    for (const reach of ['private', 'public'] as const) {
      expect(kinds(await render({ app: { reach } }))).toContain(
        'CiliumNetworkPolicy',
      );
    }
    for (const values of [
      { app: { reach: 'none', auth: 'none' } },
      { app: { kind: 'job' } },
      { app: { expose: false } },
    ]) {
      expect(kinds(await render(values))).not.toContain('CiliumNetworkPolicy');
    }
  });
});

describe('the route', () => {
  test('it attaches to the shared gateway, and renders neither', async () => {
    const route = one(await render(), 'HTTPRoute');
    expect(route.spec.parentRefs).toEqual([
      { name: 'cluster-gateway', namespace: 'gateway' },
    ]);
    expect(route.spec.hostnames).toEqual(['blog-web.apps.example.test']);
    // Routes publish their address; the NetworkPolicy blocks the bypass.
    for (const prefix of PREFIXES) {
      expect(route.metadata.annotations?.[`${prefix}exclude`]).toBeUndefined();
    }
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

  test('a Component with no reach has no route at all', async () => {
    const objects = await render({ app: { reach: 'none', auth: 'none' } });
    expect(kinds(objects)).not.toContain('HTTPRoute');
    expect(kinds(objects)).toContain('Service');
  });

  test('auth: proxy renders the filter, at either reach', async () => {
    const asPrivate = one(
      await render({ app: { reach: 'private', auth: 'proxy' } }),
      'HTTPRoute',
    );
    expect(asPrivate.spec.rules[0].filters).toEqual([
      {
        type: 'ExternalAuth',
        externalAuth: {
          protocol: 'HTTP',
          backendRef: {
            name: 'oauth2-proxy',
            namespace: 'oauth2-proxy',
            port: 80,
          },
          http: {
            // Only `cookie`, which carries the session. This list alone keeps a client's
            // `x-forwarded-*` headers, which can redirect a sign-in, out of the check.
            allowedHeaders: ['cookie'],
            allowedResponseHeaders: [
              'set-cookie',
              'x-auth-request-email',
              'x-auth-request-user',
            ],
          },
        },
      },
    ]);
  });

  test('the filter never forwards the header that names the return target', async () => {
    // oauth2-proxy trusts `X-Auth-Request-Redirect` from any caller, so forwarding a
    // browser's copy would let it choose where a sign-in returns.
    const route = one(
      await render({ app: { reach: 'private', auth: 'proxy' } }),
      'HTTPRoute',
    );
    const { allowedHeaders } = route.spec.rules[0].filters[0].externalAuth.http;
    expect(
      (allowedHeaders as string[]).map((header) => header.toLowerCase()),
    ).not.toContain('x-auth-request-redirect');
  });

  test('auth: none renders no filter, at either reach', async () => {
    for (const reach of ['private', 'public'] as const) {
      const route = one(
        await render({ app: { reach, auth: 'none' } }),
        'HTTPRoute',
      );
      expect(route.spec.rules[0].filters).toBeUndefined();
    }
  });

  test('the filter renders on a public route too, unmet audience aside', async () => {
    // Placement decides whether a Target may serve `{public, proxy}`; the chart renders it.
    const route = one(
      await render({ app: { reach: 'public', auth: 'proxy' } }),
      'HTTPRoute',
    );
    expect(route.spec.rules[0].filters?.[0]?.type).toBe('ExternalAuth');
  });

  test('the route is held out of DNS, so only one source publishes', async () => {
    // Otherwise external-dns's `gateway-httproute` source also publishes these names. Any
    // value other than `dns-controller` makes it skip the route.
    for (const reach of ['private', 'public'] as const) {
      const route = one(await render({ app: { reach } }), 'HTTPRoute');
      for (const prefix of PREFIXES) {
        const controller = route.metadata.annotations?.[`${prefix}controller`];
        expect(controller).toBeDefined();
        expect(controller).not.toBe('dns-controller');
      }
    }
  });

  test('a route with no gateway to attach to fails to render', async () => {
    // Placement refuses this first; the chart is the backstop.
    expect(
      render({ platform: { gateway: { name: '', namespace: '' } } }),
    ).rejects.toThrow(/gateway/);
  });
});

describe('the published record', () => {
  test('reach decides the record, and the chart states it', async () => {
    // A private A record points at an RFC1918 address, which the internet cannot reach.
    const asPrivate = one(
      await render({ app: { reach: 'private', auth: 'proxy' } }),
      'DNSEndpoint',
    );
    expect(asPrivate.spec.endpoints).toEqual([
      {
        dnsName: 'blog-web.apps.example.test',
        recordType: 'A',
        targets: ['10.89.0.67'],
        providerSpecific: proxiedSpec('false'),
      },
    ]);

    const asPublic = one(
      await render({ app: { reach: 'public', auth: 'none' } }),
      'DNSEndpoint',
    );
    expect(asPublic.spec.endpoints).toEqual([
      {
        dnsName: 'blog-web.apps.example.test',
        recordType: 'CNAME',
        targets: ['tunnel.example.test'],
        providerSpecific: proxiedSpec('true'),
      },
    ]);
  });

  test("the target is the Target's value, not the gateway it routes onto", async () => {
    // An address that appears nowhere else in the render, so the record cannot come from the gateway.
    const endpoint = one(
      await render({
        platform: {
          gateway: { name: 'cluster-gateway', namespace: 'gateway' },
          dns: { privateAddress: '10.99.99.99' },
        },
      }),
      'DNSEndpoint',
    );
    expect(endpoint.spec.endpoints[0].targets).toEqual(['10.99.99.99']);
  });

  test('every hostname on the route is published', async () => {
    // A vanity name with no record would resolve to whatever wildcard still answers.
    const endpoint = one(
      await render({
        app: {
          reach: 'public',
          hostnames: ['blog-web.apps.example.test', 'blog.vanity.example.test'],
        },
      }),
      'DNSEndpoint',
    );
    expect(
      endpoint.spec.endpoints.map((e: { dnsName: string }) => e.dnsName),
    ).toEqual(['blog-web.apps.example.test', 'blog.vanity.example.test']);
    for (const e of endpoint.spec.endpoints) {
      expect(e.recordType).toBe('CNAME');
      expect(e.targets).toEqual(['tunnel.example.test']);
    }
  });

  test('an apex hostname publishes exactly like any other name (ticket 137)', async () => {
    // The chart never inspects a hostname's shape, so an apex is a proxied CNAME like any name.
    const objects = await render({
      app: {
        reach: 'public',
        hostnames: ['blog-web.apps.example.test', 'apps.example.test'],
      },
    });
    const route = one(objects, 'HTTPRoute');
    expect(route.spec.hostnames).toContain('apps.example.test');

    const endpoint = one(objects, 'DNSEndpoint');
    const apex = endpoint.spec.endpoints.find(
      (e: { dnsName: string }) => e.dnsName === 'apps.example.test',
    );
    expect(apex).toEqual({
      dnsName: 'apps.example.test',
      recordType: 'CNAME',
      targets: ['tunnel.example.test'],
      providerSpecific: proxiedSpec('true'),
    });
  });

  test("it renders on the route's condition, and never without one", async () => {
    // A record for a name nothing routes resolves and then 404s.
    for (const reach of ['private', 'public'] as const) {
      expect(kinds(await render({ app: { reach } }))).toContain('DNSEndpoint');
    }
    for (const values of [
      { app: { reach: 'none', auth: 'none' } },
      { app: { kind: 'job' } },
      { app: { expose: false } },
    ]) {
      const objects = await render(values);
      expect(kinds(objects)).not.toContain('DNSEndpoint');
      expect(kinds(objects)).not.toContain('HTTPRoute');
    }
  });

  test('a reach with nowhere to point fails to render', async () => {
    // An empty target would publish a name that resolves to nothing.
    await expect(
      render({
        app: { reach: 'private' },
        platform: { dns: { privateAddress: '' } },
      }),
    ).rejects.toThrow(/platform\.dns\.privateAddress/);

    await expect(
      render({
        app: { reach: 'public' },
        platform: { dns: { tunnelHostname: '' } },
      }),
    ).rejects.toThrow(/platform\.dns\.tunnelHostname/);
  });
});

describe('config delivery', () => {
  /** Two variables, as the control plane renders them from a pinned document. */
  const CONFIGURED = {
    app: {
      secretEnv: [
        {
          name: 'TOKEN',
          secretName: 'blog-web',
          remote: { key: 'blog--web--metal--TOKEN', version: '7' },
        },
        {
          name: 'DSN',
          secretName: 'blog-web',
          remote: { key: 'blog--web--metal--DSN', version: '2' },
        },
      ],
    },
    platform: { secretStore: { kind: 'ClusterSecretStore', name: 'vault' } },
  };

  test('one secret per variable, never a blob', async () => {
    // An `envFrom` would deliver the config as one blob.
    const container = one(await render(CONFIGURED), 'Deployment').spec.template
      .spec.containers[0];

    expect(container.envFrom).toBeUndefined();
    const names = container.env.map((entry: { name: string }) => entry.name);
    expect(names).toContain('TOKEN');
    expect(names).toContain('DSN');
    const token = container.env.find(
      (entry: { name: string }) => entry.name === 'TOKEN',
    );
    // The variable name is the Secret key, because a store's item name is not always a legal key.
    expect(token.valueFrom.secretKeyRef).toEqual({
      name: 'blog-web',
      key: 'TOKEN',
    });
  });

  test('the pinned references are fetched, and no value is rendered', async () => {
    const external = one(await render(CONFIGURED), 'ExternalSecret');
    expect(external.spec.secretStoreRef).toEqual({
      kind: 'ClusterSecretStore',
      name: 'vault',
    });
    expect(external.spec.target.name).toBe('blog-web');
    expect(external.spec.data).toEqual([
      {
        secretKey: 'TOKEN',
        remoteRef: { key: 'blog--web--metal--TOKEN', version: '7' },
      },
      {
        secretKey: 'DSN',
        remoteRef: { key: 'blog--web--metal--DSN', version: '2' },
      },
    ]);
    // Pinned references leave nothing to poll for.
    expect(external.spec.refreshInterval).toBe('0');
  });

  test('an unconfigured Component renders no ExternalSecret', async () => {
    const kinds = (await render()).map((object) => object.kind);
    expect(kinds).not.toContain('ExternalSecret');
  });

  test('config with no store named on the Target refuses to render', async () => {
    // Otherwise the ExternalSecret never syncs and the workload waits forever.
    await expect(render({ app: CONFIGURED.app })).rejects.toThrow(
      /platform.secretStore.name/,
    );
  });

  test('no Component-declared volumes beyond the writable /tmp', async () => {
    // A Component cannot declare volumes, so there is no PVC lifecycle to manage.
    const pod = one(await render(), 'Deployment').spec.template.spec;
    expect(pod.volumes).toEqual([{ name: 'tmp', emptyDir: {} }]);
  });
});

describe('datastore delivery', () => {
  /** A CloudNativePG credential in its Secret, and a Valkey address with no credential. */
  const ATTACHED = {
    app: {
      datastores: [
        { name: 'DATABASE_URL', secretName: 'orders-app', secretKey: 'uri' },
        {
          name: 'REDIS_URL',
          value: 'redis://cache.spindrift-apps.svc.cluster.local:6379',
        },
      ],
    },
  };

  /** The container's env, keyed by variable, from whichever workload rendered. */
  function env(object: {
    spec?: any;
  }): Record<string, { value?: string; valueFrom?: any }> {
    const containers =
      object.spec.template?.spec.containers ??
      object.spec.jobTemplate.spec.template.spec.containers;
    return Object.fromEntries(
      containers[0].env.map((entry: { name: string }) => [entry.name, entry]),
    );
  }

  test('a generated credential is read straight from the operator-owned Secret', async () => {
    const variables = env(one(await render(ATTACHED), 'Deployment'));

    // CloudNativePG's `<cluster>-app` Secret holds the connection string under `uri`.
    expect(variables.DATABASE_URL?.valueFrom.secretKeyRef).toEqual({
      name: 'orders-app',
      key: 'uri',
    });
    expect(variables.DATABASE_URL?.value).toBeUndefined();
  });

  test('an address with no credential in it is rendered as a value', async () => {
    const variables = env(one(await render(ATTACHED), 'Deployment'));

    expect(variables.REDIS_URL?.value).toBe(
      'redis://cache.spindrift-apps.svc.cluster.local:6379',
    );
    expect(variables.REDIS_URL?.valueFrom).toBeUndefined();
  });

  test('the credential never travels the pinned-store path', async () => {
    // A same-namespace credential is referenced, never copied through the config store.
    const objects = await render(ATTACHED);
    expect(kinds(objects)).not.toContain('ExternalSecret');
  });

  /** A Datastore in `spindrift-datastores` and a release in `app-<name>`, which a `secretKeyRef` cannot cross. */
  const ACROSS = {
    app: {
      datastores: [
        {
          name: 'DATABASE_URL',
          remoteSecretName: 'orders-app',
          secretKey: 'uri',
        },
      ],
    },
    platform: {
      datastoreSecretStore: {
        kind: 'ClusterSecretStore',
        name: 'spindrift-datastores',
        refreshInterval: '1h',
      },
    },
  };

  test('a credential in another namespace is mirrored in, not reached across', async () => {
    const objects = await render(ACROSS);

    // The datastore store; this fixture leaves the config store unset.
    const mirror = objects.find(
      (object: any) =>
        object.kind === 'ExternalSecret' &&
        object.metadata.name.endsWith('-datastores'),
    ) as any;
    expect(mirror.spec.secretStoreRef.name).toBe('spindrift-datastores');
    expect(mirror.spec.dataFrom).toEqual([{ extract: { key: 'orders-app' } }]);
    // Polls, because the datastore operator rotates the credential without a Deploy.
    expect(mirror.spec.refreshInterval).toBe('1h');

    // The container reads the mirror under the operator's own key.
    const variables = env(one(objects, 'Deployment'));
    expect(variables.DATABASE_URL?.valueFrom.secretKeyRef).toEqual({
      name: `${mirror.metadata.name}`,
      key: 'uri',
    });
  });

  test('a same-namespace credential still grows no mirror', async () => {
    // Where the namespaces coincide, the direct reference needs no mirror.
    expect(kinds(await render(ATTACHED))).not.toContain('ExternalSecret');
  });

  test('a job gets its connections too', async () => {
    // Both workloads build the container through `spindrift-app.podSpec`.
    const variables = env(
      one(
        await render({ ...ATTACHED, app: { ...ATTACHED.app, kind: 'job' } }),
        'CronJob',
      ),
    );

    expect(variables.DATABASE_URL?.valueFrom.secretKeyRef.name).toBe(
      'orders-app',
    );
    expect(variables.REDIS_URL?.value).toBe(
      'redis://cache.spindrift-apps.svc.cluster.local:6379',
    );
  });
});

describe('shared pod annotations reach the pod template', () => {
  // A restart changes `shared.podAnnotations`, which rolls the pods and nothing else.
  const STAMP = { 'spindrift.dev/restarted-at': '2026-08-23T12:00:00.000Z' };

  test('on a Deployment, beside the contract annotation', async () => {
    const deployment = one(
      await render({ shared: { podAnnotations: STAMP } }),
      'Deployment',
    );
    const annotations = deployment.spec.template.metadata.annotations;
    expect(annotations).toMatchObject(STAMP);
    expect(annotations['spindrift.dev/values-contract']).toBeDefined();
    // On the Deployment's own metadata it would roll nothing.
    expect(deployment.metadata.annotations).not.toHaveProperty(
      'spindrift.dev/restarted-at',
    );
  });

  test('on a CronJob’s pod template, where the next run reads it', async () => {
    const cronJob = one(
      await render({ app: { kind: 'job' }, shared: { podAnnotations: STAMP } }),
      'CronJob',
    );
    expect(
      cronJob.spec.jobTemplate.spec.template.metadata.annotations,
    ).toMatchObject(STAMP);
  });
});
