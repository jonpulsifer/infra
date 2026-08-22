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
    // §7: the selector is immutable, so a per-deploy value in one would brick
    // every upgrade after the first.
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
  // What the declared version *is* is asserted in Spindrift's own suite, where
  // the number has something to be checked against. A literal here was a hand-
  // maintained copy of a constant in another package, and it went stale.
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

  test('the port it probes is the port it tells the process about', async () => {
    // A zero-config build listens on `PORT`. The cloud runtime sets it, which
    // is why the same image serves there and why nothing here noticed; on a
    // cluster nobody does, so the image falls back to its own default and the
    // probe knocks on 8080 until the release times out — with a container that
    // started perfectly well.
    const container = one(await render(), 'Deployment').spec.template.spec
      .containers[0];
    const port = container.env.find(
      (variable: { name: string }) => variable.name === 'PORT',
    );
    expect(port?.value).toBe(String(container.readinessProbe.tcpSocket.port));
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

  test('a routed Component admits the gateway’s identity, not its namespace', async () => {
    // The regression this exists for: a gateway's data plane is host-networked
    // and reaches the pod carrying Cilium's `ingress` identity, which no
    // `namespaceSelector` matches — so naming the gateway's namespace in
    // `allowedNamespaces` never admitted a route, and the listener answered 503
    // with the backend healthy. Asserted here because every other signal in the
    // cluster reads correct while this one is wrong.
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
    // Same condition as the route itself: `reach: none` has no gateway in front
    // of it, so admitting one would widen a boundary nothing asked to cross.
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
    // The blanket exclude is gone: publishing the address is the mechanism now
    // rather than a leak, and the bypass concern moved to the NetworkPolicy.
    expect(
      route.metadata.annotations?.['external-dns.alpha.kubernetes.io/exclude'],
    ).toBeUndefined();
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
    // Nothing routes to it, so there is no name to publish and no filter to
    // hang. The Service is still there — a workload boundary is not an absence.
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
            // Exactly one, and the exactness is the point. `allowedHeaders`
            // permits a header through to oauth2-proxy; it does not create one.
            // `cookie` carries the session, which is all the check reads.
            //
            // No `x-forwarded-*` is listed, and this list is the only thing
            // that keeps the family out of the check — it applies whichever
            // backend `platform.externalAuth` names. oauth2-proxy's own gate
            // (`CanTrustForwardedHeaders`, false while `reverse-proxy` is
            // unset) lives in `clusters/base/apps/oauth2-proxy/helm-release.yaml`
            // and is one flag from opening. Past it, `x-forwarded-host` naming
            // a sibling host flips `IsForwardedRequest`, `x-forwarded-uri`
            // picks the path on it through `GetRequestURI` with no such
            // comparison, and `x-forwarded-proto` is what makes the pair a
            // valid absolute URL rather than a rejected `://host/path`.
            // `authorization` is read by no provider this deployment
            // configures. The template comment carries the measurement, this
            // carries the assertion.
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
    // `getXAuthRequestRedirect` (oauth2-proxy `pkg/app/redirect/getters.go`)
    // reads `X-Auth-Request-Redirect` with no trusted-proxy gate at all, so
    // whoever puts that header on the check request decides where a sign-in
    // returns to. The value the flow uses is composed inside the auth pod, by
    // the shim `platform.externalAuth` points at; the only thing keeping a
    // *browser* from composing one instead is that Envoy is never told to
    // forward it. That absence is the guard, so it is asserted rather than
    // left to the list above happening not to mention it.
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
    // Whether a Target *may* serve this cell is placement's question, not the
    // chart's. The chart's job is that the cell is renderable at all — which is
    // what makes `{public, proxy}` expressible-and-unmet rather than absent.
    const route = one(
      await render({ app: { reach: 'public', auth: 'proxy' } }),
      'HTTPRoute',
    );
    expect(route.spec.rules[0].filters?.[0]?.type).toBe('ExternalAuth');
  });

  test('the route is held out of DNS, so only one source publishes', async () => {
    // Without this the `gateway-httproute` source emits its own endpoint for
    // these hostnames, targeting the parent Gateway's status address: the same
    // name claimed twice, at two record types, by two sources. The value only
    // has to differ from `dns-controller` for the source to skip the object.
    for (const reach of ['private', 'public'] as const) {
      const route = one(await render({ app: { reach } }), 'HTTPRoute');
      const controller =
        route.metadata.annotations?.[
          'external-dns.alpha.kubernetes.io/controller'
        ];
      expect(controller).toBeDefined();
      expect(controller).not.toBe('dns-controller');
    }
  });

  test('a route with no gateway to attach to fails to render', async () => {
    // The Deploy that goes green with `parentRefs` naming the empty string is
    // the failure this refuses: a route attached to nothing, and a URL that
    // answers nothing. Placement refuses it first; this is the backstop.
    expect(
      render({ platform: { gateway: { name: '', namespace: '' } } }),
    ).rejects.toThrow(/gateway/);
  });
});

describe('the published record', () => {
  test('reach decides the record, and the chart states it', async () => {
    // The record type is the boundary. An RFC1918 address is not reachable from
    // the internet whatever policy is or is not attached to it, which is what
    // lets the proxied wildcard be retired without weakening anything.
    const asPrivate = one(
      await render({ app: { reach: 'private', auth: 'proxy' } }),
      'DNSEndpoint',
    );
    expect(asPrivate.spec.endpoints).toEqual([
      {
        dnsName: 'blog-web.apps.example.test',
        recordType: 'A',
        targets: ['10.89.0.67'],
        providerSpecific: [
          {
            name: 'external-dns.alpha.kubernetes.io/cloudflare-proxied',
            value: 'false',
          },
        ],
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
        providerSpecific: [
          {
            name: 'external-dns.alpha.kubernetes.io/cloudflare-proxied',
            value: 'true',
          },
        ],
      },
    ]);
  });

  test("the target is the Target's value, not the gateway it routes onto", async () => {
    // The defect this chart shipped with was invisible for exactly one reason:
    // `platform.dns.privateAddress` happened to equal the parent Gateway's own
    // status address, so a record derived from the gateway and a record derived
    // from the chart agreed. They are independent inputs and this pins them
    // apart — a private address that is nothing else in the render.
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
    // The canonical name and the vanity name are the same Component at the same
    // reach, so a record that covered only the first would leave the second
    // resolving to whatever wildcard still answers for the zone.
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
    // §9's vanity name is a label or the bare zone — `example.test` with no
    // subdomain at all — and the chart never inspects a hostname's shape, so an
    // apex among `app.hostnames` needs no template branch of its own: it is
    // still a CNAME to the tunnel, proxied, alongside the route's own name.
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
      providerSpecific: [
        {
          name: 'external-dns.alpha.kubernetes.io/cloudflare-proxied',
          value: 'true',
        },
      ],
    });
  });

  test("it renders on the route's condition, and never without one", async () => {
    // A record for a name nothing routes is the failure the wildcard already
    // was: it resolves, it authenticates, and it 404s.
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
    // Rendering a record with an empty target publishes a name that resolves to
    // nothing, which is worse than a Deploy that refuses: it is indistinguishable
    // from a working App until someone fetches it.
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
  /** Two variables, as Spindrift renders them from a pinned document (§10). */
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
    // §10: per-key, not per-blob. An `envFrom` here would be the blob.
    const container = one(await render(CONFIGURED), 'Deployment').spec.template
      .spec.containers[0];

    expect(container.envFrom).toBeUndefined();
    const names = container.env.map((entry: { name: string }) => entry.name);
    expect(names).toContain('TOKEN');
    expect(names).toContain('DSN');
    const token = container.env.find(
      (entry: { name: string }) => entry.name === 'TOKEN',
    );
    // The variable's own name is the Secret key: a store's name for an item is
    // not a legal Secret key everywhere, so it is never used as one.
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
    // Pinned means there is nothing to poll for: a change arrives as a new
    // Deploy that re-renders this object (§10).
    expect(external.spec.refreshInterval).toBe('0');
  });

  test('an unconfigured Component renders no ExternalSecret', async () => {
    const kinds = (await render()).map((object) => object.kind);
    expect(kinds).not.toContain('ExternalSecret');
  });

  test('config with no store named on the Target refuses to render', async () => {
    // The alternative is an ExternalSecret that never syncs and a workload
    // waiting forever for a Secret nobody is creating.
    await expect(render({ app: CONFIGURED.app })).rejects.toThrow(
      /platform.secretStore.name/,
    );
  });

  test('no Component-declared volumes beyond the writable /tmp', async () => {
    // §7 deletes PVC lifecycle, orphan tracking, and the silent recreate
    // strategy by having no volume a Component can declare.
    const pod = one(await render(), 'Deployment').spec.template.spec;
    expect(pod.volumes).toEqual([{ name: 'tmp', emptyDir: {} }]);
  });
});

describe('datastore delivery', () => {
  /**
   * One Datastore of each engine, as Spindrift renders them (§11).
   *
   * The two shapes are what the engines actually are, not a chart preference:
   * CloudNativePG generates a credential and puts it in a Secret it owns, and
   * Valkey as this platform runs it authenticates nobody, so its connection is
   * an address. The chart tells them apart by which key is present — it is
   * never told which engine either one is.
   */
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

    // The operator's key, not the variable's — the whole connection string is
    // under `uri` in CloudNativePG's `<cluster>-app` Secret, and that Secret is
    // not one this chart materializes.
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
    // The assertion that pins the design: an attached Datastore renders no
    // ExternalSecret, so it demands no `platform.secretStore.name` — which the
    // baseline leaves empty, and which config delivery refuses to render
    // without. If this ever starts failing, the credential has been routed
    // through Spindrift's own store seam and is being copied rather than
    // referenced.
    const objects = await render(ATTACHED);
    expect(kinds(objects)).not.toContain('ExternalSecret');
  });

  /**
   * The ordinary case since Apps got namespaces of their own: the Datastore is
   * in `spindrift-datastores` and the release is in `app-<name>`, which a
   * `secretKeyRef` cannot cross.
   */
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

    // The mirror, against the store scoped to the datastore namespace — a
    // different store from the config one, which this fixture leaves unset.
    const mirror = objects.find(
      (object: any) =>
        object.kind === 'ExternalSecret' &&
        object.metadata.name.endsWith('-datastores'),
    ) as any;
    expect(mirror.spec.secretStoreRef.name).toBe('spindrift-datastores');
    expect(mirror.spec.dataFrom).toEqual([{ extract: { key: 'orders-app' } }]);
    // Not "0", unlike the pinned-config path: this tracks a credential the
    // datastore operator rotates with no Deploy to re-render on, so it polls.
    expect(mirror.spec.refreshInterval).toBe('1h');

    // And the container reads the mirror under the operator's own key. What
    // crossed the boundary is the Secret, not the layout of it.
    const variables = env(one(objects, 'Deployment'));
    expect(variables.DATABASE_URL?.valueFrom.secretKeyRef).toEqual({
      name: `${mirror.metadata.name}`,
      key: 'uri',
    });
  });

  test('a same-namespace credential still grows no mirror', async () => {
    // The direct reference is kept where the two namespaces coincide, which is
    // every Datastore provisioned before per-App namespaces. Rendering an
    // ExternalSecret for those would add a hop they do not need.
    expect(kinds(await render(ATTACHED))).not.toContain('ExternalSecret');
  });

  test('a job gets its connections too', async () => {
    // Both workloads reach the container through `spindrift-app.podSpec`, so
    // this is a claim that nothing branched on kind on the way — a scheduled
    // task that needs a database is the ordinary case, not an exception.
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
