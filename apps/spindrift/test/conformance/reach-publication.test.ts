/**
 * `reach` decides the record a Component's name answers to (§9).
 *
 * **Why this is not a chart golden.** The chart's goldens assert what a release
 * *asks* for, and they were green throughout the whole life of the defect they
 * now describe: a route asked for a proxied name at the Target's tunnel, the
 * controller published an unproxied address at the shared gateway instead, and
 * every manifest in the cluster was exactly what it should have been. The
 * decision is only observable one step further down, where the objects become
 * records — so that step is modelled (`test/harness/fakes/external-dns.ts`) and
 * the record is what gets asserted.
 *
 * **The whole chain runs, and nothing in it is stubbed on our side.** A
 * `DesiredState` at one reach goes through the real Kubernetes adapter, which
 * writes a real values blob onto a delivery object in the fake cluster; that
 * blob — not a baseline, not a fixture — is what the real chart is rendered
 * with; the rendered objects are what the modelled controller reads. So this
 * fails whether `reach` stops reaching the values, stops deciding the record,
 * or stops being the only thing that does.
 *
 * The last one is the sharp edge, and it is why the gateway's own address is
 * pinned *apart* from the Target's private address here. Live they are equal —
 * the Target publishes the address of the gateway its routes attach to — which
 * is precisely what made a record derived from the gateway indistinguishable
 * from a record the chart stated. They are independent inputs, so the fixture
 * separates them and the assertion names which one the record came from.
 */
import { describe, expect, test } from 'bun:test';
import type {
  DeployEvent,
  DeployTarget,
  DeployVerdict,
} from '../../src/adapters/deploy/contract.ts';
import { KubernetesDeployAdapter } from '../../src/adapters/deploy/kubernetes/index.ts';
import type { DesiredState } from '../../src/domain/desired-state.ts';
import { type RenderedObject, renderAppChart } from '../harness/app-chart.ts';
import {
  CONTROLLER,
  type GatewayStatus,
  publish,
} from '../harness/fakes/external-dns.ts';
import { FakeKubernetes } from '../harness/fakes/kubernetes-api.ts';

/** The Apps gateway every route in the namespace attaches to. */
const GATEWAY: GatewayStatus = {
  name: 'spindrift-apps',
  namespace: 'spindrift-apps',
  // Its own load-balancer address, which is the only thing the route source can
  // ever publish, and deliberately not the address below.
  addresses: ['10.89.0.68'],
};

/** The two addresses `reach` chooses between, per Target. */
const PRIVATE_ADDRESS = '10.89.0.69';
const TUNNEL_HOSTNAME = 'tunnel.example.test';

const CANONICAL = 'blog-web.apps.example.test';
const VANITY = 'blog.vanity.example.test';

/** The operator's class, as a connected Target carries it. */
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

/**
 * What a cluster would hold for this Component, through the real adapter.
 *
 * The values are read back off the applied delivery object rather than composed
 * here, because "what the adapter wrote" and "what the chart is rendered with"
 * being the same document is half of what this suite is asserting.
 */
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

/** Drive a deploy stream to its verdict. */
async function drain(
  stream: AsyncGenerator<DeployEvent, DeployVerdict, void>,
): Promise<DeployVerdict> {
  let step = await stream.next();
  while (!step.done) step = await stream.next();
  return step.value;
}

describe('reach decides the record that is published', () => {
  test('private is an unproxied address record at the Target’s own address', async () => {
    const publication = publish(await renderRelease({ reach: 'private' }), [
      GATEWAY,
    ]);

    // The address is the Target's, not the gateway's — `10.89.0.68` is what a
    // record derived from the parent would have carried, and it appears
    // nowhere. Unproxied because the value is RFC1918: the record type is the
    // boundary, so nothing has to be attached to it to keep it one.
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
    const publication = publish(await renderRelease({ reach: 'public' }), [
      GATEWAY,
    ]);

    // A hostname can only ever be a CNAME, which is the half the route source
    // structurally could not express: it publishes an address, and asking the
    // zone provider to proxy one is the refusal that soft-errored a whole-zone
    // sync every five minutes.
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
    // A Component with no reach has no route, so there is no name to answer
    // for. A record here would be an alternate origin it asked not to have.
    const publication = publish(await renderRelease({ reach: 'none' }), [
      GATEWAY,
    ]);
    expect(publication.records).toEqual([]);
  });

  test('every name the route serves is published at the one reach', async () => {
    // The canonical name and the vanity name are the same Component at the same
    // reach. A record covering only the first leaves the second answered by
    // whatever wildcard the zone still has, which is the failure retiring one
    // was supposed to end.
    const publication = publish(
      await renderRelease({
        reach: 'public',
        hostname: { canonical: CANONICAL, vanity: VANITY },
      }),
      [GATEWAY],
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
});

/**
 * A guard nobody has seen fail is not a guard.
 *
 * Each mutation below is applied to what the chart actually rendered, so it
 * stands in for the publication mechanism regressing rather than for a fixture
 * someone typed. The assertions are the ones above, run against the damage.
 */
describe('publication that stops honouring reach fails here', () => {
  /** The route stops holding itself out of the route source. */
  function unheldOut(objects: readonly RenderedObject[]): RenderedObject[] {
    return objects.map((object) => {
      if (object.kind !== 'HTTPRoute') return object;
      const { [CONTROLLER]: _held, ...annotations } =
        object.metadata.annotations ?? {};
      return { ...object, metadata: { ...object.metadata, annotations } };
    });
  }

  /** The chart stops stating the record. */
  function unstated(objects: readonly RenderedObject[]): RenderedObject[] {
    return objects.filter((object) => object.kind !== 'DNSEndpoint');
  }

  test('a route that stops holding itself out claims its own name a second time', async () => {
    const rendered = await renderRelease({ reach: 'public' });
    const publication = publish(unheldOut(rendered), [GATEWAY]);

    // Two sources, one name, two record types — the state that fails a
    // whole-zone sync rather than one record.
    expect(publication.contended).toEqual([CANONICAL]);
    expect(publication.records).toHaveLength(2);
  });

  test('a Component whose record is no longer stated answers off the gateway', async () => {
    const rendered = await renderRelease({ reach: 'public' });
    const publication = publish(unheldOut(unstated(rendered)), [GATEWAY]);

    // Nothing is contended and nothing errors: one source, one record, and a
    // `public` Component answering an RFC1918 address on the public internet.
    // Reach was ignored and the zone is perfectly healthy about it, which is
    // the shape of failure this suite exists for.
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
    // The hold-out on its own is not a fix: with the DNSEndpoint gone it is
    // just a name that resolves nowhere. Both halves are the mechanism.
    const rendered = await renderRelease({ reach: 'public' });
    expect(publish(unstated(rendered), [GATEWAY]).records).toEqual([]);
  });
});
