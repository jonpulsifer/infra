/**
 * `reach` decides the DNS record a Component's name answers to. The real
 * adapter writes values, the real chart renders them, and a model of each
 * cluster's declared external-dns controller turns the objects into records.
 */
import { describe, expect, test } from 'bun:test';
import type {
  DeployEvent,
  DeployTarget,
  DeployVerdict,
} from '../../src/adapters/deploy/contract.ts';
import { KubernetesDeployAdapter } from '../../src/adapters/deploy/kubernetes/index.ts';
import { ANNOTATION_PREFIXES } from '../../src/adapters/dns/cluster.ts';
import type { DesiredState } from '../../src/domain/desired-state.ts';
import { type RenderedObject, renderAppChart } from '../harness/app-chart.ts';
import {
  controllerFor,
  installedControllers,
} from '../harness/external-dns-installation.ts';
import {
  CONTROLLER_KEYS,
  type GatewayStatus,
  publish,
} from '../harness/fakes/external-dns.ts';
import { FakeKubernetes } from '../harness/fakes/kubernetes-api.ts';

const CONTROLLERS = await installedControllers();

const GATEWAY: GatewayStatus = {
  name: 'spindrift-apps',
  namespace: 'spindrift-apps',
  // Differs from PRIVATE_ADDRESS so a record shows which input it came from.
  addresses: ['10.89.0.68'],
};

const PRIVATE_ADDRESS = '10.89.0.69';
const TUNNEL_HOSTNAME = 'tunnel.example.test';

const CANONICAL = 'blog-web.apps.example.test';
const VANITY = 'blog.vanity.example.test';

const CHART_VALUES = {
  platform: {
    gateway: { name: GATEWAY.name, namespace: GATEWAY.namespace },
    externalAuth: {
      name: 'oauth2-proxy-authz',
      namespace: 'oauth2-proxy',
      port: 4181,
    },
    dns: {
      privateAddress: PRIVATE_ADDRESS,
      tunnelHostname: TUNNEL_HOSTNAME,
    },
    networkPolicy: { allowedNamespaces: ['oauth2-proxy'] },
  },
};

const TARGET: DeployTarget = {
  vessel: 'cluster',
  adapter: 'kubernetes',
  connection: {
    adapter: 'kubernetes',
    apiServer: 'https://cluster.example.test',
    namespace: GATEWAY.namespace,
    delivery: {
      flavour: 'flux-helmrelease',
      namespace: GATEWAY.namespace,
      sourceRef: { name: 'spindrift-app', namespace: GATEWAY.namespace },
    },
    chartValues: CHART_VALUES,
  },
};

function desiredState(overrides: Partial<DesiredState> = {}): DesiredState {
  return {
    deploy: 'deploy-1',
    app: 'blog',
    component: 'web',
    target: 'cluster',
    kind: 'service',
    artifact: {
      type: 'image',
      digest: 'sha256:feed',
      refs: ['registry.example.test/blog/web@sha256:feed'],
    },
    expose: true,
    reach: 'private',
    auth: 'none',
    config: [],
    requirements: {
      platform: { os: 'linux', arch: 'amd64' },
      resources: {},
    },
    hostname: { canonical: CANONICAL },
    ...overrides,
  };
}

/** Renders the chart with the values the adapter wrote onto the HelmRelease. */
async function renderRelease(
  overrides: Partial<DesiredState> = {},
): Promise<RenderedObject[]> {
  const cluster = new FakeKubernetes({
    servedKinds: { 'helm.toolkit.fluxcd.io/v2': ['HelmRelease'] },
  });
  const adapter = new KubernetesDeployAdapter({
    chart: 'oci://registry.example.test/charts/spindrift-app',
    token: cluster.token,
    fetch: cluster.fetch,
    pollIntervalMs: 1,
    sleep: async () => {},
  });
  const verdict = await drain(adapter.apply(TARGET, desiredState(overrides)));
  expect(verdict.phase).toBe('LIVE');

  const release = cluster.get(`helmreleases/${GATEWAY.namespace}/blog-web`)
    ?.spec as { values?: unknown } | undefined;
  if (release?.values === undefined) {
    throw new Error('expected the HelmRelease to carry inline values');
  }
  return renderAppChart(release.values, GATEWAY.namespace);
}

async function drain(
  stream: AsyncGenerator<DeployEvent, DeployVerdict, void>,
): Promise<DeployVerdict> {
  let step = await stream.next();
  while (!step.done) step = await stream.next();
  return step.value;
}

const PER_CLUSTER = CONTROLLERS.map(
  (controller) => [controller.cluster, controller] as const,
);

describe.each(PER_CLUSTER)(
  'reach decides the record published on %s',
  (_cluster, controller) => {
    test('private is an unproxied address record at the Target’s own address', async () => {
      const publication = publish(
        await renderRelease({ reach: 'private' }),
        [GATEWAY],
        controller,
      );

      // An RFC1918 address is unreachable from the internet and needs no proxy.
      expect(publication.records).toEqual([
        {
          dnsName: CANONICAL,
          recordType: 'A',
          targets: [PRIVATE_ADDRESS],
          proxied: false,
          claimedBy: 'crd/blog-web',
        },
      ]);
      expect(publication.contended).toEqual([]);
    });

    test('public is a proxied CNAME at the Target’s tunnel', async () => {
      const publication = publish(
        await renderRelease({ reach: 'public' }),
        [GATEWAY],
        controller,
      );

      // The route source publishes only addresses, never this CNAME.
      expect(publication.records).toEqual([
        {
          dnsName: CANONICAL,
          recordType: 'CNAME',
          targets: [TUNNEL_HOSTNAME],
          proxied: true,
          claimedBy: 'crd/blog-web',
        },
      ]);
      expect(publication.contended).toEqual([]);
    });

    test('none publishes nothing at all', async () => {
      // A record here would be an origin the Component asked not to have.
      const publication = publish(
        await renderRelease({ reach: 'none' }),
        [GATEWAY],
        controller,
      );
      expect(publication.records).toEqual([]);
    });

    test('every name the route serves is published at the one reach', async () => {
      // An unpublished vanity name would fall to any wildcard in the zone.
      const publication = publish(
        await renderRelease({
          reach: 'public',
          hostname: { canonical: CANONICAL, vanity: VANITY },
        }),
        [GATEWAY],
        controller,
      );
      expect(publication.records.map((record) => record.dnsName)).toEqual([
        CANONICAL,
        VANITY,
      ]);
      for (const record of publication.records) {
        expect(record.recordType).toBe('CNAME');
        expect(record.targets).toEqual([TUNNEL_HOSTNAME]);
        expect(record.proxied).toBe(true);
      }
      expect(publication.contended).toEqual([]);
    });
  },
);

/** Each mutation damages the rendered objects, standing in for a regression. */
describe.each(PER_CLUSTER)(
  'publication on %s that stops honouring reach fails here',
  (_cluster, controller) => {
    /** The route stops holding itself out of the route source. */
    function unheldOut(objects: readonly RenderedObject[]): RenderedObject[] {
      return objects.map((object) => {
        if (object.kind !== 'HTTPRoute') return object;
        // All spellings: removing only one is a supported migration state.
        const annotations = { ...object.metadata.annotations };
        for (const key of CONTROLLER_KEYS) delete annotations[key];
        return { ...object, metadata: { ...object.metadata, annotations } };
      });
    }

    /** The chart stops stating the record. */
    function unstated(objects: readonly RenderedObject[]): RenderedObject[] {
      return objects.filter((object) => object.kind !== 'DNSEndpoint');
    }

    test('a route that stops holding itself out claims its own name a second time', async () => {
      const rendered = await renderRelease({ reach: 'public' });
      const publication = publish(unheldOut(rendered), [GATEWAY], controller);

      // Two sources claiming one name with two record types fail a whole-zone
      // sync. Only a controller running the route source can contend.
      expect(publication.contended).toEqual([CANONICAL]);
      expect(publication.records).toHaveLength(2);
    });

    test('a Component whose record is no longer stated answers off the gateway', async () => {
      const rendered = await renderRelease({ reach: 'public' });
      const publication = publish(
        unheldOut(unstated(rendered)),
        [GATEWAY],
        controller,
      );

      // No error anywhere, and a `public` Component answers an RFC1918 address.
      expect(publication.contended).toEqual([]);
      expect(publication.records).toEqual([
        {
          dnsName: CANONICAL,
          recordType: 'A',
          targets: GATEWAY.addresses,
          proxied: false,
          claimedBy: 'httproute/blog-web',
        },
      ]);
    });

    test('a record nothing states and nothing derives is no record', async () => {
      // Without the DNSEndpoint, the held-out name resolves nowhere.
      const rendered = await renderRelease({ reach: 'public' });
      expect(
        publish(unstated(rendered), [GATEWAY], controller).records,
      ).toEqual([]);
    });

    test('a controller that stops reading stated records publishes nothing', async () => {
      // Without `crd`, no source claims the held-out name, and `--policy=sync`
      // deletes the existing record.
      const rendered = await renderRelease({ reach: 'public' });
      const deaf = {
        ...controller,
        sources: controller.sources.filter((source) => source !== 'crd'),
      };
      expect(publish(rendered, [GATEWAY], deaf).records).toEqual([]);
    });
  },
);

describe('the modelled controller is the declared one', () => {
  test('an argument the model does not account for is refused, not ignored', () => {
    // `--annotation-prefix` renames every annotation key, including the one the
    // route holds itself out with.
    const overlay = {
      resources: ['../../../base/networking/external-dns'],
      patches: [
        {
          target: { kind: 'HelmRelease', name: 'external-dns' },
          patch:
            '- op: add\n' +
            '  path: /spec/values/extraArgs/-\n' +
            '  value: --annotation-prefix=dns.example.test/\n',
        },
      ],
    };
    expect(() =>
      controllerFor(
        'somewhere',
        { spec: { values: { sources: ['crd'], extraArgs: [] } } },
        overlay,
      ),
    ).toThrow(/--annotation-prefix/);
  });

  test('every controller is pinned to a prefix Spindrift actually writes', async () => {
    // external-dns v0.22.0 changed its default prefix with no fallback, so an
    // unpinned controller misses `cloudflare-proxied` and publishes unproxied.
    for (const controller of CONTROLLERS) {
      // A defaulted flag is `null`, which must fail this membership.
      expect(ANNOTATION_PREFIXES).toContain(
        controller.annotationPrefix as string,
      );
    }
  });

  test.each(ANNOTATION_PREFIXES)(
    'the same records publish with the pin moved to %s',
    async (annotationPrefix: string) => {
      // external-dns reads one prefix, so a pin moves safely only while every
      // object carries the key under each prefix.
      for (const controller of CONTROLLERS) {
        const rendered = await renderRelease({
          reach: 'public',
          hostname: { canonical: CANONICAL, vanity: VANITY },
        });
        expect(
          publish(rendered, [GATEWAY], { ...controller, annotationPrefix }),
        ).toEqual(publish(rendered, [GATEWAY], controller));
      }
    },
  );
});
