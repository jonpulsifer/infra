/**
 * The Cloud Run deploy adapter against a fake runtime API. The document carries
 * an image and nothing that could build, phases come from the revision, and a
 * tightening reach writes the policy before the Service.
 */
import { describe, expect, test } from 'bun:test';
import { CloudRunDeployAdapter } from '../../src/adapters/deploy/cloudrun/index.ts';
import { cloudRunJob } from '../../src/adapters/deploy/cloudrun/job.ts';
import {
  cloudRunService,
  INGRESS,
  ingressFor,
} from '../../src/adapters/deploy/cloudrun/service.ts';
import { cloudRunStatus } from '../../src/adapters/deploy/cloudrun/status.ts';
import type {
  DeployEvent,
  DeployTarget,
  DeployVerdict,
} from '../../src/adapters/deploy/contract.ts';
import { blameFor, RESTART_STAMP } from '../../src/adapters/deploy/contract.ts';
import {
  deriveHealth,
  deriveVerifiedDeploy,
} from '../../src/domain/capabilities.ts';
import type { DesiredState, Reach } from '../../src/domain/desired-state.ts';
import type { CloudRunAdapterConnection } from '../../src/domain/target.ts';
import {
  FakeCloudRun,
  type FakeCloudRunOptions,
  permissionDenied,
  serviceDisabled,
} from '../harness/fakes/cloudrun-api.ts';
import { CLOUD_ENDPOINTS } from '../harness/installation.ts';

const CONNECTION: CloudRunAdapterConnection = {
  adapter: 'cloudrun',
  project: 'example-vessel',
  region: 'somewhere',
  endpoint: CLOUD_ENDPOINTS.run,
  policyEndpoint: CLOUD_ENDPOINTS.policy,
};

function target(
  overrides: Partial<CloudRunAdapterConnection> = {},
): DeployTarget {
  return {
    vessel: 'cloud',
    adapter: 'cloudrun',
    connection: { ...CONNECTION, ...overrides },
  };
}

function desired(overrides: Partial<DesiredState> = {}): DesiredState {
  return {
    deploy: 'deploy-1',
    app: 'shop',
    component: 'web',
    target: 'cloud',
    kind: 'service',
    artifact: {
      type: 'image',
      digest: 'sha256:abc',
      refs: ['registry.example.test/shop@sha256:abc'],
    },
    reach: 'private',
    auth: 'proxy',
    config: [],
    requirements: { platform: { os: 'linux', arch: 'amd64' }, resources: {} },
    hostname: { canonical: '' },
    ...overrides,
  };
}

function adapterFor(options: FakeCloudRunOptions = {}): {
  api: FakeCloudRun;
  adapter: CloudRunDeployAdapter;
} {
  const api = new FakeCloudRun(options);
  return {
    api,
    adapter: new CloudRunDeployAdapter({
      token: api.token,
      fetch: api.fetch,
      schedulerEndpoint: api.schedulerEndpoint,
      pollIntervalMs: 1,
      sleep: async () => {},
    }),
  };
}

async function drain(
  stream: AsyncGenerator<DeployEvent, DeployVerdict, void>,
): Promise<{ events: DeployEvent[]; verdict: DeployVerdict }> {
  const events: DeployEvent[] = [];
  let step = await stream.next();
  while (!step.done) {
    events.push(step.value);
    step = await stream.next();
  }
  return { events, verdict: step.value };
}

describe('§4: never the build-from-source path', () => {
  test('the applied document carries an image and nothing that builds', async () => {
    const { api, adapter } = adapterFor();
    await drain(adapter.apply(target(), desired()));

    const service = api.service('shop-web') as Record<string, unknown>;
    const template = service.template as {
      containers: { image: string }[];
    };
    expect(template.containers[0]?.image).toBe(
      'registry.example.test/shop@sha256:abc',
    );
    // The runtime would build from either of these.
    expect(service).not.toHaveProperty('buildConfig');
    expect(template).not.toHaveProperty('source');
    expect(JSON.stringify(service)).not.toContain('sourceArchive');
  });

  test('a files artifact is refused as core’s bug, not the developer’s', async () => {
    const { adapter } = adapterFor();
    const { verdict } = await drain(
      adapter.apply(
        target(),
        desired({
          artifact: { type: 'files', digest: 'sha256:f', refs: ['x'] },
        }),
      ),
    );
    expect(verdict.phase).toBe('FAILED');
    if (verdict.phase === 'FAILED') {
      expect(verdict.reason).toBe('INTERNAL');
      expect(blameFor(verdict.reason)).toBe('platform');
    }
  });
});

describe('§9: reach and auth reach the runtime as two mechanisms', () => {
  test('only an absent reach closes ingress', () => {
    expect(ingressFor('none')).toBe(INGRESS.internalOnly);
    expect(ingressFor('private')).toBe(INGRESS.all);
    expect(ingressFor('public')).toBe(INGRESS.all);
  });

  test('only a public reach with no auth disables the invoker check', async () => {
    // The open cell uses `invokerIamDisabled`, since org policy refuses an
    // `allUsers` binding. The empty policy write strips any existing binding.
    for (const [reach, auth] of [
      ['none', 'none'],
      ['private', 'proxy'],
      ['public', 'none'],
    ] as const) {
      const { api, adapter } = adapterFor();
      const { verdict } = await drain(
        adapter.apply(target(), desired({ reach, auth })),
      );
      expect(verdict.phase).toBe('LIVE');

      const document = api.service('shop-web');
      expect(document?.invokerIamDisabled).toBe(
        reach === 'public' && auth === 'none',
      );
      const policy = api.policy('shop-web') as {
        policy: { bindings: { members: string[] }[] };
      };
      expect(policy.policy.bindings).toEqual([]);
    }
  });

  test('tightening writes the policy before the Service, opening after it', async () => {
    // Asserted on the request log, since the end state cannot show the order.
    const tightening = adapterFor();
    await drain(
      tightening.adapter.apply(
        target(),
        desired({ reach: 'private', auth: 'proxy' }),
      ),
    );
    const beforeApply = tightening.api.requests.findIndex((request) =>
      request.path.endsWith(':setIamPolicy'),
    );
    const applyAt = tightening.api.requests.findIndex(
      (request) => request.method === 'PATCH',
    );
    expect(beforeApply).toBeGreaterThan(-1);
    expect(beforeApply).toBeLessThan(applyAt);

    const opening = adapterFor();
    await drain(
      opening.adapter.apply(
        target(),
        desired({ reach: 'public', auth: 'none' }),
      ),
    );
    const grantAt = opening.api.requests.findIndex((request) =>
      request.path.endsWith(':setIamPolicy'),
    );
    const placedAt = opening.api.requests.findIndex(
      (request) => request.method === 'PATCH',
    );
    expect(grantAt).toBeGreaterThan(placedAt);
  });

  test('a deploy whose policy assert fails is red, not quietly open', async () => {
    // On the public cell the empty policy strips any stale `allUsers` binding.
    const { adapter } = adapterFor({ refuseIam: permissionDenied() });
    const { verdict } = await drain(
      adapter.apply(target(), desired({ reach: 'public', auth: 'none' })),
    );
    expect(verdict.phase).toBe('FAILED');
    if (verdict.phase === 'FAILED') {
      expect(verdict.detail).toContain('invoker policy');
    }
  });

  test('a 404 excuses a policy that grants nothing, and only that one', async () => {
    // A resource not there yet has no policy, and a Service's policy never
    // grants, so a `404` on either direction proceeds.
    for (const exposure of [
      { reach: 'public', auth: 'none' },
      { reach: 'private', auth: 'none' },
    ] as const) {
      const { adapter } = adapterFor({
        refuseIam: { status: 404, body: { error: { status: 'NOT_FOUND' } } },
      });
      const { verdict } = await drain(
        adapter.apply(target(), desired(exposure)),
      );
      expect(verdict.phase).toBe('LIVE');
    }

    // A scheduled Job's policy grants the scheduler's identity; without it the
    // cadence could never fire.
    const granting = adapterFor({
      refuseIam: { status: 404, body: { error: { status: 'NOT_FOUND' } } },
    });
    const scheduled = await drain(
      granting.adapter.apply(
        target({
          serviceAccount: 'runtime@example-vessel.iam.gserviceaccount.com',
        }),
        desired({ kind: 'job', reach: 'none', schedule: '0 3 * * *' }),
      ),
    );
    expect(scheduled.verdict.phase).toBe('FAILED');
  });
});

describe('§6: phases come from the revision', () => {
  test('apply polls until the terminal condition succeeds', async () => {
    const { api, adapter } = adapterFor();
    const { events, verdict } = await drain(adapter.apply(target(), desired()));

    expect(verdict.phase).toBe('LIVE');
    // The default fake reports reconciling before ready.
    const phases = events
      .filter((event) => event.type === 'status')
      .map((event) => (event.type === 'status' ? event.phase : ''));
    expect(phases).toContain('WAITING');
    expect(api.pathsOf('GET').length).toBeGreaterThan(1);
  });

  test('the platform names its own, and the name comes back on the verdict', async () => {
    const { adapter } = adapterFor();
    const { verdict } = await drain(adapter.apply(target(), desired()));
    // Core mints no address for this Target, so the verdict must carry one.
    expect(verdict.phase).toBe('LIVE');
    if (verdict.phase === 'LIVE') {
      expect(verdict.url).toBe('https://shop-web.run.example.test');
    }
  });

  test('a pull failure blames the platform, not the developer', () => {
    const status = cloudRunStatus({
      terminalCondition: {
        type: 'Ready',
        state: 'CONDITION_FAILED',
        revisionReason: 'CONTAINER_IMAGE_UNAUTHORIZED',
        message: 'the image could not be pulled',
      },
    });
    expect(status.phase).toBe('FAILED');
    expect(status.reason).toBe('ARTIFACT_UNAVAILABLE');
    expect(blameFor('ARTIFACT_UNAVAILABLE')).toBe('platform');
  });

  test('a failure with no stated reason is a revision that would not start', () => {
    const status = cloudRunStatus({
      terminalCondition: { type: 'Ready', state: 'CONDITION_FAILED' },
    });
    expect(status.reason).toBe('STARTUP_FAILED');
    expect(status.detail).toContain('gave no reason');
  });

  test('a red verdict keeps what the platform said, because it will not', async () => {
    const { adapter } = adapterFor({
      service: () => ({
        terminalCondition: {
          type: 'Ready',
          state: 'CONDITION_FAILED',
          revisionReason: 'HEALTH_CHECK_CONTAINER_ERROR',
          message: 'the container did not become ready',
        },
      }),
    });
    const { verdict } = await drain(adapter.apply(target(), desired()));
    expect(verdict.phase).toBe('FAILED');
    if (verdict.phase === 'FAILED') {
      expect(verdict.reason).toBe('UNHEALTHY');
      expect(verdict.debug).toBeDefined();
    }
  });

  test('a project that refuses the write is REJECTED, an unreachable one is not', async () => {
    const refused = adapterFor({
      refuse: { status: 400, body: { error: { message: 'invalid spec' } } },
    });
    const first = await drain(refused.adapter.apply(target(), desired()));
    expect(first.verdict.phase).toBe('FAILED');
    if (first.verdict.phase === 'FAILED') {
      expect(first.verdict.reason).toBe('REJECTED');
    }

    const denied = adapterFor({ refuse: permissionDenied() });
    const second = await drain(denied.adapter.apply(target(), desired()));
    if (second.verdict.phase === 'FAILED') {
      expect(second.verdict.reason).toBe('TARGET_UNREACHABLE');
      expect(blameFor('TARGET_UNREACHABLE')).toBe('platform');
    }
  });
});

describe('the write is asynchronous, and the document is checked', () => {
  test('apply survives the window in which the Service is not there yet', async () => {
    // The `PATCH` answers with an Operation and creates the Service behind it,
    // so a `GET` right after a first deploy can come back `404`.
    const { api, adapter } = adapterFor({ createLatencyReads: 3 });
    const { events, verdict } = await drain(adapter.apply(target(), desired()));

    expect(verdict.phase).toBe('LIVE');
    // An absent Service reads as still applying, not a failure.
    const phases = events
      .filter((event) => event.type === 'status')
      .map((event) => (event.type === 'status' ? event.phase : ''));
    expect(phases).toEqual(['APPLYING', 'WAITING', 'LIVE']);
    // Three reads that found nothing, then the ones that found it.
    expect(api.pathsOf('GET').length).toBeGreaterThan(3);
  });

  test('a write answers with an Operation, which is what a poll would need', async () => {
    const { api, adapter } = adapterFor();
    await drain(adapter.apply(target(), desired()));

    const write = api.requests.find((request) => request.method === 'PATCH');
    expect(write?.url).toContain('allowMissing=true');
    // An operation is polled by its `name`.
    const operation = api.operations[0];
    expect(operation?.name).toMatch(/\/operations\//);
    expect(operation?.done).toBe(false);
  });

  test('a Service naming a field the schema does not define is refused', async () => {
    // Google's protobuf-JSON parsers refuse an unknown member, and so does the
    // fake.
    const api = new FakeCloudRun();
    const refused = await api.fetch(
      new Request(
        `${api.endpoint}/v2/projects/${api.project}/locations/${api.region}/services/shop-web?allowMissing=true`,
        {
          method: 'PATCH',
          headers: {
            Authorization: 'Bearer federated-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            ingress: 'INGRESS_TRAFFIC_ALL',
            template: {
              containers: [
                { image: 'registry.example.test/shop@sha256:abc', cpu: '1' },
              ],
            },
          }),
        },
      ),
    );

    expect(refused.status).toBe(400);
    const body = (await refused.json()) as { error: { message: string } };
    expect(body.error.message).toContain('template.containers[0].cpu');
  });

  test('a label in a namespace the v2 API reserves is refused', async () => {
    const api = new FakeCloudRun();
    const refused = await api.fetch(
      new Request(
        `${api.endpoint}/v2/projects/${api.project}/locations/${api.region}/services/shop-web?allowMissing=true`,
        {
          method: 'PATCH',
          headers: {
            Authorization: 'Bearer federated-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            labels: { 'run.googleapis.com/launch-stage': 'beta' },
          }),
        },
      ),
    );
    expect(refused.status).toBe(400);
  });
});

describe('observe and destroy', () => {
  test('observe reports the digest the Service still carries', async () => {
    const { adapter } = adapterFor();
    const { verdict } = await drain(adapter.apply(target(), desired()));
    if (verdict.phase !== 'LIVE') throw new Error('nothing was placed');

    const observed = await adapter.observe(target(), verdict.ref);
    expect(observed?.artifactDigest).toBe('sha256:abc');
  });

  test('a ref from another project is not read against this one', async () => {
    const { adapter } = adapterFor();
    await drain(adapter.apply(target(), desired()));
    // A Target can be reconnected to a different project.
    const elsewhere = 'projects/other/locations/somewhere/services/shop-web';
    expect(await adapter.observe(target(), elsewhere)).toBeNull();
  });

  test('destroy removes the Service and is idempotent', async () => {
    const { api, adapter } = adapterFor();
    const { verdict } = await drain(adapter.apply(target(), desired()));
    if (verdict.phase !== 'LIVE') throw new Error('nothing was placed');

    await adapter.destroy(target(), verdict.ref);
    expect(api.service('shop-web')).toBeUndefined();
    await adapter.destroy(target(), verdict.ref);
    expect(await adapter.observe(target(), verdict.ref)).toBeNull();
  });
});

describe('§13: one probe, three answers', () => {
  test('a reachable project meets every item', async () => {
    const { adapter } = adapterFor();
    const { prerequisites } = await adapter.inspect(target());
    expect(prerequisites.every((item) => item.met)).toBe(true);
    expect(deriveHealth(prerequisites, 'cloudrun')).toBe('healthy');
  });

  test('a disabled service is not a permission problem', async () => {
    const { adapter } = adapterFor({ refuseList: serviceDisabled() });
    const { prerequisites } = await adapter.inspect(target());
    const platform = prerequisites.find((item) => item.name === 'PLATFORM_API');
    expect(platform?.met).toBe(false);
    expect(platform?.detail).toContain('not enabled');
    expect(
      prerequisites.find((item) => item.name === 'OIDC_FEDERATION')?.detail,
    ).toContain('not assessed');
  });

  test('a refusal is the federation, and a missing project is the vessel', async () => {
    const denied = adapterFor({ refuseList: permissionDenied() });
    const first = await denied.adapter.inspect(target());
    expect(
      first.prerequisites.find((item) => item.name === 'OIDC_FEDERATION')?.met,
    ).toBe(false);
    expect(
      first.prerequisites.find((item) => item.name === 'PLATFORM_API')?.met,
    ).toBe(true);

    const absent = adapterFor({
      refuseList: { status: 404, body: { error: { message: 'no project' } } },
    });
    const second = await absent.adapter.inspect(target());
    const vessel = second.prerequisites.find((item) => item.name === 'VESSEL');
    expect(vessel?.met).toBe(false);
    expect(vessel?.detail).toContain('never creates a vessel');
  });

  test('and the same probe says whether the project carries this surface', async () => {
    const { adapter } = adapterFor();
    expect((await adapter.inspect(target())).surface).toEqual({
      kind: 'carried',
    });

    // With the service off in this project, no revision can be placed.
    const off = adapterFor({ refuseList: serviceDisabled() });
    const disabled = (await off.adapter.inspect(target())).surface;
    expect(disabled.kind).toBe('absent');
    expect(disabled.kind === 'absent' && disabled.detail).toContain(
      'not enabled',
    );
  });

  test('a switch off in the billing project is named, and settles nothing here', async () => {
    // GCP refuses a call whose consumer project, the one the token bills, has
    // the service off, and its ErrorInfo names that project.
    const { adapter } = adapterFor({
      refuseList: serviceDisabled('example-billing'),
    });
    const inspected = await adapter.inspect(target());

    const platform = inspected.prerequisites.find(
      (item) => item.name === 'PLATFORM_API',
    );
    expect(platform?.met).toBe(false);
    expect(platform?.detail).toContain('example-billing');
    expect(platform?.detail).toContain('not example-vessel');

    expect(inspected.surface.kind).toBe('undetermined');
    expect(
      inspected.surface.kind === 'undetermined' && inspected.surface.detail,
    ).toContain('example-billing');
  });

  test('but a refusal establishes nothing about what is here', async () => {
    // Neither refusal says the runtime is absent, and a cloud API answers `404`
    // for a project this identity cannot see as readily as for a missing one.
    for (const refuseList of [
      permissionDenied(),
      { status: 404, body: { error: { message: 'no project' } } },
    ]) {
      const { adapter } = adapterFor({ refuseList });
      expect((await adapter.inspect(target())).surface.kind).toBe(
        'undetermined',
      );
    }
  });
});

describe('§8 and §32: what this Target is honest about', () => {
  test('no egress filtering is advertised', async () => {
    const { adapter } = adapterFor();
    const { discovery } = await adapter.inspect(target());
    // Egress filtering means a by-name allowlist, which this backend lacks.
    expect(discovery.egressFiltering).toBe(false);
  });

  test('an enforcing policy verifies and a dry-run one does not', async () => {
    const enforcing = adapterFor({
      admissionPolicy: {
        defaultAdmissionRule: {
          evaluationMode: 'REQUIRE_ATTESTATION',
          enforcementMode: 'ENFORCED_BLOCK_AND_AUDIT_LOG',
        },
      },
    });
    const strict = await enforcing.adapter.inspect(target());
    expect(deriveVerifiedDeploy(strict.discovery.policyEngine)).toBe(true);

    const auditing = adapterFor({
      admissionPolicy: {
        defaultAdmissionRule: {
          evaluationMode: 'REQUIRE_ATTESTATION',
          enforcementMode: 'DRYRUN_AUDIT_LOG_ONLY',
        },
      },
    });
    const lax = await auditing.adapter.inspect(target());
    expect(lax.discovery.policyEngine.installed).toBe(true);
    expect(deriveVerifiedDeploy(lax.discovery.policyEngine)).toBe(false);
  });

  test('a policy that admits everything verifies nothing, however it enforces', async () => {
    const { adapter } = adapterFor({
      admissionPolicy: {
        defaultAdmissionRule: {
          evaluationMode: 'ALWAYS_ALLOW',
          enforcementMode: 'ENFORCED_BLOCK_AND_AUDIT_LOG',
        },
      },
    });
    const { discovery } = await adapter.inspect(target());
    expect(deriveVerifiedDeploy(discovery.policyEngine)).toBe(false);
  });

  test('a Target naming no policy endpoint claims no verified deploy', async () => {
    const { adapter } = adapterFor();
    const { discovery } = await adapter.inspect(
      target({ policyEndpoint: undefined }),
    );
    expect(discovery.policyEngine).toEqual({ installed: false, mode: null });
  });
});

describe('§20: the Datastore capability follows the vessel network', () => {
  // Not probed: both engines sit behind PSC endpoints in the vessel network,
  // so the network's presence gates both.
  test('a vessel with no network cannot host a Datastore', async () => {
    const { adapter } = adapterFor();
    const { discovery } = await adapter.inspect(target());
    expect(discovery.postgres).toBe(false);
    expect(discovery.valkey).toBe(false);
  });

  test('a vessel with a network hosts both engines', async () => {
    const { adapter } = adapterFor();
    const { discovery } = await adapter.inspect(
      target({ network: { name: 'spindrift-vessel', region: 'somewhere' } }),
    );
    expect(discovery.postgres).toBe(true);
    expect(discovery.valkey).toBe(true);
  });
});

describe('§10: config crosses as a pinned reference and never as a value', () => {
  test('every variable is a reference into the vessel’s own store', () => {
    const document = cloudRunService(
      desired({
        config: [
          { name: 'TOKEN', secret: { key: 'shop-web-token', version: '3' } },
        ],
      }),
      {
        project: 'example-vessel',
        image: 'registry.example.test/shop@sha256:abc',
        serviceAccount: null,
        useProjectAdmissionPolicy: false,
      },
    );
    const template = document.template as {
      containers: { env: { name: string; valueSource: unknown }[] }[];
    };
    const variable = template.containers[0]?.env[0];
    expect(variable?.name).toBe('TOKEN');
    expect(variable?.valueSource).toEqual({
      secretKeyRef: {
        secret: 'projects/example-vessel/secrets/shop-web-token',
        version: '3',
      },
    });
    expect(JSON.stringify(document)).not.toContain('"value"');
  });
});

describe('the identity a revision runs as', () => {
  test('is the Target’s, on the revision template', () => {
    const document = cloudRunService(desired({}), {
      project: 'example-vessel',
      image: 'registry.example.test/shop@sha256:abc',
      serviceAccount: 'runtime@example-vessel.iam.gserviceaccount.com',
      useProjectAdmissionPolicy: false,
    });
    const template = document.template as { serviceAccount?: string };
    expect(template.serviceAccount).toBe(
      'runtime@example-vessel.iam.gserviceaccount.com',
    );
  });

  test('is absent rather than invented where the Target names none', () => {
    // Left out, the runtime falls back to the project's default compute
    // account and refuses the apply without `iam.serviceAccounts.actAs` on it.
    const document = cloudRunService(desired({}), {
      project: 'example-vessel',
      image: 'registry.example.test/shop@sha256:abc',
      serviceAccount: null,
      useProjectAdmissionPolicy: false,
    });
    expect(document.template as object).not.toHaveProperty('serviceAccount');
  });
});

describe('§16: the Service submits to the project’s own admission policy', () => {
  test('a Target that names a policy endpoint declares useDefault', async () => {
    const { api, adapter } = adapterFor();
    await drain(adapter.apply(target(), desired()));

    // Cloud Run treats a Service naming no policy as having none, which
    // `run.allowedBinaryAuthorizationPolicies` refuses.
    expect(api.service('shop-web')).toHaveProperty('binaryAuthorization', {
      useDefault: true,
    });
  });

  test('a Target that names none says nothing about admission', async () => {
    const { api, adapter } = adapterFor();
    await drain(
      adapter.apply(
        {
          ...target(),
          connection: { ...CONNECTION, policyEndpoint: undefined },
        },
        desired(),
      ),
    );
    expect(api.service('shop-web')).not.toHaveProperty('binaryAuthorization');
  });
});

describe('the reach a Target rejects is a state, not a crash', () => {
  test('every reach produces a document', () => {
    const states: Reach[] = ['none', 'private', 'public'];
    for (const reach of states) {
      const document = cloudRunService(desired({ reach }), {
        project: 'example-vessel',
        image: 'registry.example.test/shop@sha256:abc',
        serviceAccount: null,
        useProjectAdmissionPolicy: false,
      });
      expect(document.ingress).toBe(ingressFor(reach));
    }
  });
});

describe('§3: a job is a Job with no cadence of its own', () => {
  const job = (overrides: Partial<DesiredState> = {}) =>
    desired({
      component: 'nightly',
      kind: 'job',
      reach: 'none',
      auth: 'none',
      ...overrides,
    });

  const RENDER = {
    project: 'example-vessel',
    image: 'registry.example.test/shop@sha256:abc',
    serviceAccount: 'runtime@example-vessel.iam.gserviceaccount.com',
    useProjectAdmissionPolicy: true,
  };

  test('the whole document is the doubled template and nothing else', () => {
    // Asserted whole, since only an exact comparison sees an absence.
    expect(
      cloudRunJob(
        job({
          config: [
            {
              name: 'TOKEN',
              secret: { key: 'shop-nightly-token', version: '3' },
            },
          ],
          requirements: {
            platform: { os: 'linux', arch: 'amd64' },
            resources: { cpu: '1', memory: '512Mi' },
          },
        }),
        RENDER,
      ),
    ).toEqual({
      labels: {
        'spindrift-managed': 'true',
        'spindrift-app': 'shop',
        'spindrift-component': 'nightly',
      },
      binaryAuthorization: { useDefault: true },
      template: {
        labels: {
          'spindrift-managed': 'true',
          'spindrift-app': 'shop',
          'spindrift-component': 'nightly',
          'spindrift-deploy': 'deploy-1',
        },
        // `Job.template` is an ExecutionTemplate whose own `template` is the
        // TaskTemplate; a Service nests once.
        template: {
          serviceAccount: 'runtime@example-vessel.iam.gserviceaccount.com',
          containers: [
            {
              image: 'registry.example.test/shop@sha256:abc',
              env: [
                {
                  name: 'TOKEN',
                  valueSource: {
                    secretKeyRef: {
                      secret:
                        'projects/example-vessel/secrets/shop-nightly-token',
                      version: '3',
                    },
                  },
                },
              ],
              resources: { limits: { cpu: '1', memory: '512Mi' } },
            },
          ],
          // Matches the chart CronJob's `backoffLimit: 0`; the runtime's
          // default is 3.
          maxRetries: 0,
        },
      },
    });
  });

  test('nothing that answers "who may route to this" is rendered', async () => {
    // The Job resource has no `ingress` member, and nothing routes to a Job.
    const document = cloudRunJob(job(), RENDER);
    expect(document).not.toHaveProperty('ingress');
    expect(JSON.stringify(document)).not.toContain('containerPort');

    const { adapter } = adapterFor();
    const { verdict } = await drain(adapter.apply(target(), job()));
    expect(verdict.phase).toBe('LIVE');
  });

  test('the runtime accepts it, and reports no address for it', async () => {
    const { api, adapter } = adapterFor();
    const { verdict } = await drain(adapter.apply(target(), job()));

    expect(api.job('shop-nightly')).toBeDefined();
    expect(api.service('shop-nightly')).toBeUndefined();
    expect(verdict.phase).toBe('LIVE');
    // A Job has no `uri` member.
    if (verdict.phase === 'LIVE') expect(verdict.url).toBeUndefined();
  });

  test('the Service nesting would be refused by the API, not silently taken', async () => {
    // Google's protobuf-JSON parsers reject an unknown member, so a Job nested
    // like a Service fails with a message about a field name.
    const { api } = adapterFor();
    const response = await api.fetch(
      new Request(
        `${api.endpoint}/v2/projects/example-vessel/locations/somewhere/jobs/shop-nightly?allowMissing=true`,
        {
          method: 'PATCH',
          headers: { authorization: `Bearer ${api.token()}` },
          body: JSON.stringify({ template: { containers: [{ image: 'x' }] } }),
        },
      ),
    );
    expect(response.status).toBe(400);
    const refusal = (await response.json()) as { error: { message: string } };
    expect(refusal.error.message).toContain(
      'Unknown name "template.containers"',
    );
  });

  test('an unscheduled job is invokable by nobody, and nothing fires it', async () => {
    const { api, adapter } = adapterFor();
    const { verdict } = await drain(adapter.apply(target(), job()));
    expect(verdict.phase).toBe('LIVE');

    // The empty policy is written, so removing a schedule removes the grant.
    expect(api.scheduled()).toEqual([]);
    expect(api.jobPolicy('shop-nightly')).toEqual({ policy: { bindings: [] } });
    expect(await api.tick()).toEqual([]);
  });
});

describe('§7: a schedule on this backend is a second service in front of the Job', () => {
  const RUNTIME = 'runtime@example-vessel.iam.gserviceaccount.com';

  const scheduling = () => target({ serviceAccount: RUNTIME });

  const nightly = (overrides: Partial<DesiredState> = {}) =>
    desired({
      component: 'nightly',
      kind: 'job',
      reach: 'none',
      auth: 'none',
      schedule: '0 3 * * *',
      ...overrides,
    });

  test('the scheduler job calls jobs.run as the runtime account', async () => {
    const { api, adapter } = adapterFor();
    const { verdict } = await drain(adapter.apply(scheduling(), nightly()));
    expect(verdict.phase).toBe('LIVE');

    // Asserted whole, since only an exact comparison sees an absence.
    expect(api.schedule('shop-nightly')).toEqual({
      name: 'projects/example-vessel/locations/somewhere/jobs/shop-nightly',
      schedule: '0 3 * * *',
      timeZone: 'UTC',
      httpTarget: {
        uri: `${CLOUD_ENDPOINTS.run}/v2/projects/example-vessel/locations/somewhere/jobs/shop-nightly:run`,
        httpMethod: 'POST',
        oauthToken: {
          serviceAccountEmail: RUNTIME,
          scope: 'https://www.googleapis.com/auth/cloud-platform',
        },
      },
    });
  });

  test('an execution appears that nobody asked for', async () => {
    // The fire authenticates as the runtime account and is admitted only by
    // the Job's own policy.
    const { api, adapter } = adapterFor();
    const { verdict } = await drain(adapter.apply(scheduling(), nightly()));

    expect(api.jobPolicy('shop-nightly')).toEqual({
      policy: {
        bindings: [
          { role: 'roles/run.invoker', members: [`serviceAccount:${RUNTIME}`] },
        ],
      },
    });

    const before = await adapter.executions(
      scheduling(),
      verdict.ref as string,
    );
    expect(before).toEqual({ kind: 'executions', executions: [] });

    expect(await api.tick()).toEqual([200]);

    const after = await adapter.executions(scheduling(), verdict.ref as string);
    expect(after.kind).toBe('executions');
    if (after.kind === 'executions') {
      expect(after.executions).toHaveLength(1);
      expect(after.executions[0]?.name).toBe('shop-nightly-1');
    }
  });

  test('the grant is on the Job, so it cannot run another Component', async () => {
    // Every workload in the vessel shares the runtime account, so a
    // project-level grant would let one App's schedule fire another's job.
    const { api, adapter } = adapterFor();
    await drain(adapter.apply(scheduling(), nightly()));
    await drain(
      adapter.apply(
        scheduling(),
        nightly({ component: 'other', schedule: undefined }),
      ),
    );

    expect(api.jobPolicy('shop-other')).toEqual({ policy: { bindings: [] } });
    const ran = await api.fetch(
      new Request(
        `${api.endpoint}/v2/projects/example-vessel/locations/somewhere/jobs/shop-other:run`,
        { method: 'POST', headers: { authorization: `Bearer sa:${RUNTIME}` } },
      ),
    );
    expect(ran.status).toBe(403);
  });

  test('dropping the schedule stops the firing, and clears the grant', async () => {
    // The scheduler job is deleted before the new template is applied, so the
    // old cadence never fires the new revision.
    const { api, adapter } = adapterFor();
    await drain(adapter.apply(scheduling(), nightly()));
    expect(api.scheduled()).toHaveLength(1);

    api.requests.length = 0;
    await drain(adapter.apply(scheduling(), nightly({ schedule: undefined })));

    expect(api.scheduled()).toEqual([]);
    expect(api.jobPolicy('shop-nightly')).toEqual({ policy: { bindings: [] } });
    expect(await api.tick()).toEqual([]);

    const removed = api.requests.findIndex(
      (request) =>
        request.method === 'DELETE' &&
        request.path ===
          '/v1/projects/example-vessel/locations/somewhere/jobs/shop-nightly',
    );
    const patched = api.requests.findIndex(
      (request) =>
        request.method === 'PATCH' && request.path.includes('/jobs/'),
    );
    expect(removed).toBe(0);
    expect(removed).toBeLessThan(patched);
  });

  test('destroy takes the schedule with the Job', async () => {
    // A scheduler job left behind would keep calling `jobs.run`.
    const { api, adapter } = adapterFor();
    const { verdict } = await drain(adapter.apply(scheduling(), nightly()));

    await adapter.destroy(scheduling(), verdict.ref as string);
    expect(api.job('shop-nightly')).toBeUndefined();
    expect(api.scheduled()).toEqual([]);
  });

  test('re-deploying patches the schedule rather than replacing it', async () => {
    // Cloud Scheduler has no create-or-update: `jobs.create` answers `409` for
    // an existing name and `jobs.patch` answers `404` for a missing one.
    const { api, adapter } = adapterFor();
    await drain(adapter.apply(scheduling(), nightly()));

    api.requests.length = 0;
    const { verdict } = await drain(
      adapter.apply(scheduling(), nightly({ schedule: '30 4 * * 1' })),
    );

    expect(verdict.phase).toBe('LIVE');
    expect(api.scheduled()).toHaveLength(1);
    expect(api.schedule('shop-nightly')?.schedule).toBe('30 4 * * 1');
    // One PATCH and no DELETE first, which would leave a window with nothing
    // scheduled and let a failed create stop the cadence silently.
    expect(
      api.requests
        .filter((request) => request.path.startsWith('/v1/'))
        .map((request) => request.method),
    ).toEqual(['PATCH']);
  });

  test('a Target naming no identity is refused before anything is written', async () => {
    // Cloud Scheduler accepts a job with no account and refuses every tick.
    const { api, adapter } = adapterFor();
    const { verdict } = await drain(adapter.apply(target(), nightly()));

    expect(verdict.phase).toBe('FAILED');
    if (verdict.phase === 'FAILED') {
      expect(verdict.reason).toBe('REJECTED');
      expect(blameFor(verdict.reason)).toBe('developer');
      expect(verdict.detail).toContain('identity');
    }
    expect(
      api.requests.filter((request) => request.method === 'PATCH'),
    ).toEqual([]);
  });

  test('a schedule the far side refuses fails the deploy and takes the grant back', async () => {
    // Cloud Scheduler answers an unparseable cron with `400 INVALID_ARGUMENT`.
    // The Job is already up, since the schedule is the last thing `apply` does.
    const { api, adapter } = adapterFor();
    const { verdict } = await drain(
      adapter.apply(scheduling(), nightly({ schedule: 'every tuesday' })),
    );

    expect(verdict.phase).toBe('FAILED');
    if (verdict.phase === 'FAILED') {
      expect(verdict.reason).toBe('REJECTED');
      expect(verdict.detail).toContain('every tuesday');
    }
    expect(api.scheduled()).toEqual([]);
    // The runtime account is shared by every workload in the vessel, so the
    // grant must not outlive the failed schedule.
    expect(api.jobPolicy('shop-nightly')).toEqual({ policy: { bindings: [] } });
    const ran = await api.fetch(
      new Request(
        `${api.endpoint}/v2/projects/example-vessel/locations/somewhere/jobs/shop-nightly:run`,
        { method: 'POST', headers: { authorization: `Bearer sa:${RUNTIME}` } },
      ),
    );
    expect(ran.status).toBe(403);
  });

  test('a job that declares no schedule does not depend on Cloud Scheduler', async () => {
    // Clearing an old schedule must not fail a plain job: Cloud Scheduler
    // serves fewer regions than Cloud Run, and project IAM lags its apply.
    const refusals = [
      // With the service off there was never a scheduler job to remove.
      { refuseScheduler: serviceDisabled(), residue: false },
      { refuseScheduler: permissionDenied(), residue: true },
      {
        refuseScheduler: {
          status: 400,
          body: { error: { message: 'unsupported location' } },
        },
        residue: true,
      },
    ];
    for (const { refuseScheduler, residue } of refusals) {
      const { api, adapter } = adapterFor({ refuseScheduler });
      const { verdict, events } = await drain(
        adapter.apply(scheduling(), nightly({ schedule: undefined })),
      );

      expect(verdict.phase).toBe('LIVE');
      expect(api.job('shop-nightly')).toBeDefined();
      // The grant goes regardless, so a surviving scheduler job cannot fire.
      expect(api.jobPolicy('shop-nightly')).toEqual({
        policy: { bindings: [] },
      });
      // A residue this deploy could not clear is logged.
      expect(
        events.some(
          (event) =>
            event.type === 'log' && event.line.includes('could not be removed'),
        ),
      ).toBe(residue);
    }
  });

  test('destroy raises what apply tolerates', async () => {
    // A refusal during destroy would leave a scheduler job calling `jobs.run`
    // at a Job that is gone.
    const { adapter } = adapterFor({ refuseScheduler: permissionDenied() });
    const { verdict } = await drain(adapter.apply(scheduling(), nightly()));
    expect(verdict.phase).toBe('FAILED');

    const ref = 'projects/example-vessel/locations/somewhere/jobs/shop-nightly';
    await expect(adapter.destroy(scheduling(), ref)).rejects.toThrow(
      'could not be removed',
    );
  });

  test('a project with Cloud Scheduler switched off destroys a plain job', async () => {
    // An API never enabled holds no scheduler job.
    const { api, adapter } = adapterFor({ refuseScheduler: serviceDisabled() });
    const { verdict } = await drain(
      adapter.apply(scheduling(), nightly({ schedule: undefined })),
    );
    expect(verdict.phase).toBe('LIVE');

    await adapter.destroy(scheduling(), verdict.ref as string);
    expect(api.job('shop-nightly')).toBeUndefined();
  });

  test('and a refusal that only mentions the words does not count', async () => {
    // The tolerance reads the ErrorInfo `reason` only, never the human
    // message.
    const denied = permissionDenied();
    const { adapter } = adapterFor({
      refuseScheduler: {
        status: denied.status,
        body: {
          error: {
            message:
              'the caller does not have permission; check whether SERVICE_DISABLED applies',
            status: 'PERMISSION_DENIED',
            details: [
              {
                '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
                reason: 'IAM_PERMISSION_DENIED',
              },
            ],
          },
        },
      },
    });
    const { verdict } = await drain(
      adapter.apply(scheduling(), nightly({ schedule: undefined })),
    );
    expect(verdict.phase).toBe('LIVE');

    await expect(
      adapter.destroy(scheduling(), verdict.ref as string),
    ).rejects.toThrow('could not be removed');
  });

  test('observe reports the cadence the platform is actually holding', async () => {
    const { adapter } = adapterFor();
    const { verdict } = await drain(adapter.apply(scheduling(), nightly()));

    const observed = await adapter.observe(scheduling(), verdict.ref as string);
    expect(observed?.schedule).toBe('0 3 * * *');
  });

  test('a scheduler job deleted out of band reads back as no cadence', async () => {
    // The Job looks untouched, but nothing will ever fire it again.
    const { api, adapter } = adapterFor();
    const { verdict } = await drain(adapter.apply(scheduling(), nightly()));
    expect(await api.tick()).toHaveLength(1);

    api.deschedule('shop-nightly');
    expect(await api.tick()).toEqual([]);

    const observed = await adapter.observe(scheduling(), verdict.ref as string);
    expect(observed?.phase).toBe('LIVE');
    expect(observed?.artifactDigest).toBe('sha256:abc');
    expect(observed?.schedule).toBeNull();
  });

  test('a job that declares no schedule reads back the same way', async () => {
    // The API answers one `404` for both, so core, which holds the
    // declaration, tells them apart.
    const { adapter } = adapterFor();
    const { verdict } = await drain(
      adapter.apply(scheduling(), nightly({ schedule: undefined })),
    );
    expect(
      (await adapter.observe(scheduling(), verdict.ref as string))?.schedule,
    ).toBeNull();
  });

  test('a service reports no cadence at all, rather than an absent one', async () => {
    // `null` would mean a cadence is gone, and a Service never had one.
    const { adapter } = adapterFor();
    const { verdict } = await drain(adapter.apply(target(), desired()));

    const observed = await adapter.observe(target(), verdict.ref as string);
    expect(observed?.phase).toBe('LIVE');
    expect('schedule' in (observed ?? {})).toBe(false);
  });

  test('a refusal that does not prove absence is not reported as absence', async () => {
    // `null` makes core announce a stopped cadence, so only an answer that
    // proves absence may produce it.
    const api = new FakeCloudRun();
    const denied = permissionDenied();
    const adapter = new CloudRunDeployAdapter({
      token: api.token,
      schedulerEndpoint: api.schedulerEndpoint,
      pollIntervalMs: 1,
      sleep: async () => {},
      fetch: async (request) => {
        const url = new URL(request.url);
        return url.origin === new URL(api.schedulerEndpoint).origin &&
          request.method === 'GET'
          ? new Response(JSON.stringify(denied.body), {
              status: denied.status,
              headers: { 'content-type': 'application/json' },
            })
          : api.fetch(request);
      },
    });
    const { verdict } = await drain(adapter.apply(scheduling(), nightly()));

    const observed = await adapter.observe(scheduling(), verdict.ref as string);
    expect(observed?.phase).toBe('LIVE');
    expect('schedule' in (observed ?? {})).toBe(false);
  });
});

describe('the ref an adapter hands back names its own collection', () => {
  const job = () =>
    desired({ component: 'nightly', kind: 'job', reach: 'none', auth: 'none' });

  const LEGACY_SERVICE_REF =
    'projects/example-vessel/locations/somewhere/services/shop-web';

  test('a job round-trips through observe and destroy', async () => {
    const { api, adapter } = adapterFor();
    const { verdict } = await drain(adapter.apply(target(), job()));
    expect(verdict.ref).toBe(
      'projects/example-vessel/locations/somewhere/jobs/shop-nightly',
    );

    const observed = await adapter.observe(target(), verdict.ref as string);
    expect(observed?.phase).toBe('LIVE');
    expect(observed?.artifactDigest).toBe('sha256:abc');

    await adapter.destroy(target(), verdict.ref as string);
    expect(api.job('shop-nightly')).toBeUndefined();
  });

  test('a Service ref written before jobs existed still round-trips', async () => {
    // Stored Service refs carry no kind beside them, so the parser must still
    // read `/services/`.
    const { api, adapter } = adapterFor();
    const { verdict } = await drain(adapter.apply(target(), desired()));
    expect(verdict.ref).toBe(LEGACY_SERVICE_REF);

    const observed = await adapter.observe(target(), LEGACY_SERVICE_REF);
    expect(observed?.phase).toBe('LIVE');
    expect(observed?.artifactDigest).toBe('sha256:abc');

    await adapter.destroy(target(), LEGACY_SERVICE_REF);
    expect(api.service('shop-web')).toBeUndefined();
  });

  test('a collection this adapter does not place into is not a ref', async () => {
    const { adapter } = adapterFor();
    await drain(adapter.apply(target(), desired()));
    expect(
      await adapter.observe(
        target(),
        'projects/example-vessel/locations/somewhere/executions/shop-web',
      ),
    ).toBeNull();
  });
});

describe('runtime log tail', () => {
  test('resumes Cloud Logging entries from its opaque cursor', async () => {
    const api = new FakeCloudRun();
    let reads = 0;
    const requests: Record<string, unknown>[] = [];
    const adapter = new CloudRunDeployAdapter({
      token: api.token,
      logsEndpoint: api.endpoint,
      fetch: async (request) => {
        if (new URL(request.url).pathname !== '/v2/entries:list') {
          return api.fetch(request);
        }
        reads += 1;
        requests.push(
          (await request.clone().json()) as Record<string, unknown>,
        );
        const entries = [
          {
            timestamp: '2026-07-29T12:00:00.000Z',
            receiveTimestamp: '2026-07-29T12:10:00.000Z',
            insertId: 'a',
            textPayload: 'first',
            resource: { labels: { revision_name: 'shop-web-00001' } },
          },
          {
            timestamp: '2026-07-29T12:00:01.000Z',
            receiveTimestamp: '2026-07-29T12:10:01.000Z',
            insertId: 'b',
            textPayload: 'second',
            resource: { labels: { revision_name: 'shop-web-00001' } },
          },
          ...(reads === 1
            ? []
            : [
                {
                  timestamp: '2026-07-29T12:00:02.000Z',
                  receiveTimestamp: '2026-07-29T12:10:02.000Z',
                  insertId: 'c',
                  textPayload: 'third',
                  resource: { labels: { revision_name: 'shop-web-00002' } },
                },
              ]),
        ];
        return Response.json({ entries });
      },
    });

    const first = await adapter.tail(target({ logHistorySeconds: 7200 }), {
      app: 'shop',
      component: 'web',
    });
    expect(first.kind).toBe('stream');
    if (first.kind !== 'stream') return;
    expect(first.entries.map((entry) => entry.line)).toEqual([
      'first',
      'second',
    ]);
    expect(first.entries[0]?.at.toISOString()).toBe('2026-07-29T12:00:00.000Z');
    expect(first.reach).toBe(7200);

    const resumed = await adapter.tail(
      target({ logHistorySeconds: 7200 }),
      { app: 'shop', component: 'web' },
      { after: first.cursor ?? undefined },
    );
    expect(resumed.kind).toBe('stream');
    if (resumed.kind !== 'stream') return;
    expect(resumed.entries.map((entry) => entry.line)).toEqual(['third']);
    expect(resumed.entries[0]?.replica).toBe('shop-web-00002');
    expect(requests[0]?.orderBy).toBe('timestamp asc');
    expect(requests[1]?.filter).toContain(
      'timestamp>="2026-07-29T12:00:01.000Z"',
    );
  });
});

/**
 * A Job runs only when `jobs.run` asks, and a run's log entries are
 * `cloud_run_job`, which a `cloud_run_revision` filter never selects.
 */
describe('a job is run, and its runs are read', () => {
  const JOB_REF =
    'projects/example-vessel/locations/somewhere/jobs/shop-nightly';
  const job = () =>
    desired({ component: 'nightly', kind: 'job', reach: 'none', auth: 'none' });

  function execution(
    name: string,
    fields: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      name: `projects/example-vessel/locations/somewhere/jobs/shop-nightly/executions/${name}`,
      ...fields,
    };
  }

  test('starts a run through the runtime’s own verb', async () => {
    const { api, adapter } = adapterFor();
    await drain(adapter.apply(target(), job()));

    const started = await adapter.run(target(), JOB_REF);

    expect(started.kind).toBe('started');
    if (started.kind !== 'started') return;
    // The short name, the only form the log filter's `execution_name` label
    // carries.
    expect(started.execution.name).toBe('shop-nightly-1');
    expect(started.execution.outcome).toBe('running');
    expect(api.pathsOf('POST')).toContain(
      '/v2/projects/example-vessel/locations/somewhere/jobs/shop-nightly:run',
    );
  });

  test("sends this run's parameters as the execution's container override", async () => {
    // A per-execution override leaves the Job's template untouched, so the
    // next scheduled fire does not inherit this run's parameters.
    const { api, adapter } = adapterFor();
    await drain(adapter.apply(target(), job()));

    const started = await adapter.run(target(), JOB_REF, {
      env: { SNAPSHOT: 'nightly-2026-08-03', SINCE: '2026-08-01' },
    });

    expect(started.kind).toBe('started');
    const run = api.requests.find(
      (request) =>
        request.method === 'POST' && request.path.endsWith('shop-nightly:run'),
    );
    expect(run?.body).toEqual({
      overrides: {
        containerOverrides: [
          {
            env: [
              { name: 'SNAPSHOT', value: 'nightly-2026-08-03' },
              { name: 'SINCE', value: '2026-08-01' },
            ],
          },
        ],
      },
    });
  });

  test('a run without parameters sends no override at all', async () => {
    const { api, adapter } = adapterFor();
    await drain(adapter.apply(target(), job()));

    await adapter.run(target(), JOB_REF, { env: {} });

    const run = api.requests.find(
      (request) =>
        request.method === 'POST' && request.path.endsWith('shop-nightly:run'),
    );
    expect(run?.body).toEqual({});
  });

  test('reads the names a run was started with back into its line, never the values', async () => {
    // Config variables arrive as pinned references, so a plain `value` on the
    // execution's template can only be a run parameter.
    const { adapter } = adapterFor({
      executions: {
        'shop-nightly': [
          execution('shop-nightly-4', {
            startTime: '2026-08-04T00:00:00Z',
            succeededCount: 1,
            conditions: [
              {
                type: 'Completed',
                state: 'CONDITION_SUCCEEDED',
                message: 'the task exited 0',
              },
            ],
            template: {
              containers: [
                {
                  env: [
                    {
                      name: 'DATABASE_URL',
                      valueSource: {
                        secretKeyRef: { secret: 's', version: '1' },
                      },
                    },
                    { name: 'SNAPSHOT', value: 'nightly-2026-08-03' },
                    { name: 'SINCE', value: '2026-08-01' },
                  ],
                },
              ],
            },
          }),
        ],
      },
    });
    await drain(adapter.apply(target(), job()));

    const runs = await adapter.executions(target(), JOB_REF);

    expect(runs.kind).toBe('executions');
    if (runs.kind !== 'executions') return;
    expect(runs.executions[0]?.detail).toBe(
      'ran with SNAPSHOT, SINCE · the task exited 0',
    );
    expect(JSON.stringify(runs)).not.toContain('nightly-2026-08-03');
  });

  test('refuses a ref that names a service rather than a job', async () => {
    const { adapter } = adapterFor();
    await drain(adapter.apply(target(), desired()));

    expect(
      await adapter.run(
        target(),
        'projects/example-vessel/locations/somewhere/services/shop-web',
      ),
    ).toEqual({
      kind: 'none',
      because:
        'this ref names a service, which has a runtime tail rather than runs',
    });
  });

  test('lists the runs that happened, newest first, with their outcome', async () => {
    const { adapter } = adapterFor({
      executions: {
        'shop-nightly': [
          execution('shop-nightly-3', {
            startTime: '2026-08-03T00:00:00Z',
          }),
          execution('shop-nightly-2', {
            startTime: '2026-08-02T00:00:00Z',
            failedCount: 1,
            conditions: [
              {
                type: 'Completed',
                state: 'CONDITION_FAILED',
                message: 'the task exited 1',
              },
            ],
          }),
          execution('shop-nightly-1', {
            startTime: '2026-08-01T00:00:00Z',
            succeededCount: 1,
            conditions: [{ type: 'Completed', state: 'CONDITION_SUCCEEDED' }],
          }),
        ],
      },
    });
    await drain(adapter.apply(target(), job()));

    const runs = await adapter.executions(target(), JOB_REF);

    expect(runs.kind).toBe('executions');
    if (runs.kind !== 'executions') return;
    expect(runs.executions.map((run) => [run.name, run.outcome])).toEqual([
      ['shop-nightly-3', 'running'],
      ['shop-nightly-2', 'failed'],
      ['shop-nightly-1', 'passed'],
    ]);
    expect(runs.executions[1]?.detail).toBe('the task exited 1');
  });

  test('reads past the page it wants, because the API orders nothing', async () => {
    // `executions.list` documents no ordering and takes no `orderBy`, so the
    // adapter reads past `limit`, sorts, and reports `limit`.
    const oldestFirst = Array.from({ length: 14 }, (_, index) =>
      execution(`shop-nightly-${index + 1}`, {
        startTime: `2026-08-${String(index + 1).padStart(2, '0')}T00:00:00Z`,
        succeededCount: 1,
      }),
    );
    const { adapter } = adapterFor({
      executions: { 'shop-nightly': oldestFirst },
    });
    await drain(adapter.apply(target(), job()));

    const runs = await adapter.executions(target(), JOB_REF, 10);

    expect(runs.kind).toBe('executions');
    if (runs.kind !== 'executions') return;
    expect(runs.executions).toHaveLength(10);
    expect(runs.executions[0]?.name).toBe('shop-nightly-14');
    expect(runs.executions.at(-1)?.name).toBe('shop-nightly-5');
  });

  test("reads one run's logs with a job filter, not a revision one", async () => {
    const api = new FakeCloudRun();
    const filters: string[] = [];
    const adapter = new CloudRunDeployAdapter({
      token: api.token,
      logsEndpoint: api.endpoint,
      fetch: async (request) => {
        if (new URL(request.url).pathname !== '/v2/entries:list') {
          return api.fetch(request);
        }
        const body = (await request.clone().json()) as { filter: string };
        filters.push(body.filter);
        return Response.json({
          entries: [
            {
              timestamp: '2026-08-04T12:00:00.000Z',
              insertId: 'a',
              textPayload: 'backing up',
              labels: { 'run.googleapis.com/task_index': '0' },
            },
          ],
        });
      },
    });

    const page = await adapter.tail(target(), {
      app: 'shop',
      component: 'nightly',
      execution: 'shop-nightly-2',
    });

    expect(page.kind).toBe('stream');
    if (page.kind !== 'stream') return;
    expect(page.entries.map((entry) => entry.line)).toEqual(['backing up']);
    // A run has tasks, not revisions.
    expect(page.entries[0]?.replica).toBe('task 0');
    expect(filters[0]).toContain('resource.type="cloud_run_job"');
    expect(filters[0]).toContain('resource.labels.job_name="shop-nightly"');
    expect(filters[0]).toContain(
      'labels."run.googleapis.com/execution_name"="shop-nightly-2"',
    );
    expect(filters[0]).not.toContain('cloud_run_revision');
  });

  test('a service still reads its revisions — the filter did not move', async () => {
    const api = new FakeCloudRun();
    const filters: string[] = [];
    const adapter = new CloudRunDeployAdapter({
      token: api.token,
      logsEndpoint: api.endpoint,
      fetch: async (request) => {
        if (new URL(request.url).pathname !== '/v2/entries:list') {
          return api.fetch(request);
        }
        filters.push(
          ((await request.clone().json()) as { filter: string }).filter,
        );
        return Response.json({ entries: [] });
      },
    });

    await adapter.tail(target(), { app: 'shop', component: 'web' });

    expect(filters[0]).toContain('resource.type="cloud_run_revision"');
    expect(filters[0]).toContain('resource.labels.service_name="shop-web"');
    expect(filters[0]).not.toContain('execution_name');
  });
});

describe('restart', () => {
  const SERVICE_REF =
    'projects/example-vessel/locations/somewhere/services/shop-web';

  test('rolls a new revision of the same image by re-writing the template annotations through a mask', async () => {
    const { api, adapter } = adapterFor();
    const { verdict } = await drain(adapter.apply(target(), desired()));
    if (verdict.phase !== 'LIVE') throw new Error('nothing placed to restart');

    const restarted = await adapter.restart(target(), verdict.ref);

    expect(restarted.kind).toBe('restarted');
    const service = api.service('shop-web') as {
      template: {
        annotations?: Record<string, string>;
        containers: { image: string }[];
      };
    };
    expect(service.template.annotations?.[RESTART_STAMP]).toBeDefined();
    expect(service.template.containers[0]?.image).toBe(
      'registry.example.test/shop@sha256:abc',
    );
    // The runtime copies the rest of the template forward, so the masked write
    // carries annotations only.
    const masked = api.requests.filter(
      (request) =>
        request.method === 'PATCH' && request.url.includes('updateMask'),
    );
    expect(masked).toHaveLength(1);
    expect(masked[0]?.url).toContain('updateMask=template.annotations');
    const body = masked[0]?.body as { template: Record<string, unknown> };
    expect(Object.keys(body)).toEqual(['template']);
    expect(Object.keys(body.template)).toEqual(['annotations']);
  });

  test('refuses a job ref — a job has runs, not a process', async () => {
    const { api, adapter } = adapterFor();

    expect(
      await adapter.restart(
        target(),
        'projects/example-vessel/locations/somewhere/jobs/shop-nightly',
      ),
    ).toEqual({
      kind: 'none',
      because:
        'this ref names a job, which has runs rather than a process to restart',
    });
    expect(api.pathsOf('PATCH')).toEqual([]);
  });

  test('a ref that names nothing on the Target is refused, not written', async () => {
    const { api, adapter } = adapterFor();

    expect(await adapter.restart(target(), SERVICE_REF)).toEqual({
      kind: 'none',
      because: 'shop-web is no longer on this Target',
    });
    expect(api.pathsOf('PATCH')).toEqual([]);
  });

  test('a refused write is a fault with the runtime’s sentence, not a restart', async () => {
    const api = new FakeCloudRun();
    const adapter = new CloudRunDeployAdapter({
      token: api.token,
      // The apply lands; only the masked write is refused.
      fetch: async (request) =>
        new URL(request.url).searchParams.has('updateMask')
          ? new Response(JSON.stringify({ error: { message: 'forbidden' } }), {
              status: 403,
              headers: { 'content-type': 'application/json' },
            })
          : api.fetch(request),
      pollIntervalMs: 1,
      sleep: async () => {},
    });
    const { verdict } = await drain(adapter.apply(target(), desired()));
    if (verdict.phase !== 'LIVE') throw new Error('nothing placed to restart');

    await expect(adapter.restart(target(), verdict.ref)).rejects.toThrow(
      /restarting service shop-web failed/,
    );
  });

  test('a read the runtime would not answer is a fault, not an absent service', async () => {
    const api = new FakeCloudRun();
    const adapter = new CloudRunDeployAdapter({
      token: api.token,
      // Only a 404 says the service is gone; an expired token or a runtime
      // that is down says nothing about whether it is there.
      fetch: async (request) =>
        request.method === 'GET'
          ? new Response(
              JSON.stringify({ error: { message: 'unauthenticated' } }),
              { status: 401, headers: { 'content-type': 'application/json' } },
            )
          : api.fetch(request),
    });

    await expect(adapter.restart(target(), SERVICE_REF)).rejects.toThrow(
      /reading service shop-web failed: unauthenticated/,
    );
    expect(api.pathsOf('PATCH')).toEqual([]);
  });
});
