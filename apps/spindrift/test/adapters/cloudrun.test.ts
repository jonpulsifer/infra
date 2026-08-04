/**
 * The Cloud Run deploy adapter (Task 28, §6, §8, §9, §16).
 *
 * Every test drives the real adapter against a fake of the runtime's HTTP API
 * (§ Seam 2) and asserts what the project would have been sent, or what the
 * adapter concluded from what it was told. Nothing here reaches core.
 *
 * The claims worth stating up front, because each is a rule §4, §6, §8 or §9
 * makes that a plausible implementation would break:
 *
 * - **The document carries an image and nothing that could cause a build.** The
 *   runtime offers a source-to-image path and taking it would give this
 *   installation a second build engine reachable from one backend only (§4).
 * - **Reach is written before the Service when it tightens** and after it
 *   when it opens, because §9's transitions fail closed.
 * - **Phases come from the revision.** The adapter polls; it never decides that
 *   something is ready.
 * - **`ARTIFACT_UNAVAILABLE` blames the platform**, which is §6's whole reason
 *   for having blame at all: the build is green and the instinct is wrong.
 * - **No egress filtering is advertised** (§8), and `verifiedDeploy` needs an
 *   *enforcing* policy rather than a configured one (§32).
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
import { blameFor } from '../../src/adapters/deploy/contract.ts';
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
    name: 'cloud',
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

/** The adapter, with the waiting stubbed: the polling is real, the sleep is not. */
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
    // The runtime would happily accept either of these and build the result,
    // which is the second engine §4 forbids.
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

  test('only a public reach with no auth leaves an open invoker', async () => {
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

      const policy = api.policy('shop-web') as {
        policy: { bindings: { members: string[] }[] };
      };
      const members = policy.policy.bindings.flatMap(
        (binding) => binding.members,
      );
      expect(members.includes('allUsers')).toBe(reach === 'public');
    }
  });

  test('tightening writes the policy before the Service, opening after it', async () => {
    // §9: "tightening drops public reach first and stays red if the stricter
    // boundary does not come up." Ordering is the whole of that promise, so it
    // is asserted on the request log rather than on the end state.
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

  test('a public deploy whose grant fails is red, not quietly private', async () => {
    const { adapter } = adapterFor({ refuseIam: permissionDenied() });
    const { verdict } = await drain(
      adapter.apply(target(), desired({ reach: 'public', auth: 'none' })),
    );
    expect(verdict.phase).toBe('FAILED');
    if (verdict.phase === 'FAILED') {
      expect(verdict.detail).toContain('invoker policy');
    }
  });
});

describe('§6: phases come from the revision', () => {
  test('apply polls until the terminal condition succeeds', async () => {
    const { api, adapter } = adapterFor();
    const { events, verdict } = await drain(adapter.apply(target(), desired()));

    expect(verdict.phase).toBe('LIVE');
    // The default fake reports reconciling first, so an adapter that trusted
    // its own write would never have seen WAITING.
    const phases = events
      .filter((event) => event.type === 'status')
      .map((event) => (event.type === 'status' ? event.phase : ''));
    expect(phases).toContain('WAITING');
    expect(api.pathsOf('GET').length).toBeGreaterThan(1);
  });

  test('the platform names its own, and the name comes back on the verdict', async () => {
    const { adapter } = adapterFor();
    const { verdict } = await drain(adapter.apply(target(), desired()));
    // §9: core mints nothing here, so a canonical address that core never
    // supplied must arrive across this seam or the App has no address at all.
    expect(verdict.phase).toBe('LIVE');
    if (verdict.phase === 'LIVE') {
      expect(verdict.url).toBe('https://shop-web.run.example.test');
    }
  });

  test('a pull failure blames the platform, not the developer', () => {
    // §6 singles this case out: the build is green and every instinct says
    // "look at my app".
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
      // §12: the diagnosis is persisted because the platform's own retention
      // will outlive nothing.
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
    // The `PATCH` answers with an Operation and the Service is created behind
    // it, so a `GET` straight afterwards can come back `404`. That is the one
    // window a *first* deploy is guaranteed to hit, so it is driven here
    // rather than left to never happen.
    const { api, adapter } = adapterFor({ createLatencyReads: 3 });
    const { events, verdict } = await drain(adapter.apply(target(), desired()));

    expect(verdict.phase).toBe('LIVE');
    // An absent Service is "still applying", not a failure — so no second
    // APPLYING lands on the timeline and nothing goes red while it is created.
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
    // The adapter discards the body today. The `name` is the handle an
    // operation is polled by, so a fake without one could not tell the moment
    // anything wanted to.
    const operation = api.operations[0];
    expect(operation?.name).toMatch(/\/operations\//);
    expect(operation?.done).toBe(false);
  });

  test('a Service naming a field the schema does not define is refused', async () => {
    // Google's protobuf-JSON parsers refuse an unknown member outright. The
    // rendered document is the single thing standing between this product and
    // a Cloud Run deploy, and every other test in this file asserts the real
    // one is *accepted*; this asserts the check is real.
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
    // An operator may reconnect a Target against a different project; a ref
    // that did not say which would report somebody else's workload as this
    // Deploy's.
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
    // The remediation is entirely different, and sending an operator to fix a
    // permission that is already correct is the failure this distinction
    // exists to prevent.
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
    expect(vessel?.detail).toContain('never creates a project');
  });
});

describe('§8 and §32: what this Target is honest about', () => {
  test('no egress filtering is advertised', async () => {
    const { adapter } = adapterFor();
    const { discovery } = await adapter.inspect(target());
    // §8's egress control is a by-name allowlist. This backend has network
    // controls and not that one, and a capability reported on the strength of
    // something adjacent is a workload placed where its egress was never
    // constrained.
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
    // Nobody said where to look, so nothing was verified. This is the
    // direction a claim about verification has to fail in.
    expect(discovery.policyEngine).toEqual({ installed: false, mode: null });
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
    // There is nothing here that could be a value: core never read one.
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
    // Not a default composed here: an adapter that picked an identity would be
    // choosing what the workload may reach. The runtime substitutes the
    // project's default compute account, and refuses the apply for missing
    // `iam.serviceAccounts.actAs` on an account nobody named — which is the
    // failure this field exists to turn into a deliberate choice.
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

    // Cloud Run treats Binary Authorization as a property of the Service: one
    // that names no policy has none, which is what
    // `run.allowedBinaryAuthorizationPolicies` refuses. Declaring it is how a
    // Deploy submits to the check rather than how it escapes one.
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

describe('§3: a job is a Job that exists and is triggered by nothing', () => {
  /** A job, with the only reach nothing routing to it can honestly claim. */
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
    // Asserted whole rather than field by field, the way the Service document
    // is: what makes this document right is as much what is absent from it as
    // what is in it, and only an exact comparison sees an absence.
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
        // `Job.template` is an ExecutionTemplate; its own `template` is the
        // TaskTemplate. A Service nests once, and rendering that shape here
        // produces an error that reads like a field-name problem.
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
          // The chart's `backoffLimit: 0` on the same Component's CronJob. The
          // runtime's own default is 3, so leaving it out would mean one App
          // retrying on one backend and not on the other.
          maxRetries: 0,
        },
      },
    });
  });

  test('nothing that answers "who may reach this" is rendered or written', async () => {
    // `ingress`, a container port and the invoker policy are all Service
    // concepts: the Job resource has no `ingress` member, nothing routes to a
    // Job, and nothing invokes one. The fake's closed Job schema refuses the
    // first two; the request log is what proves the third never happened.
    const document = cloudRunJob(job(), RENDER);
    expect(document).not.toHaveProperty('ingress');
    expect(JSON.stringify(document)).not.toContain('containerPort');

    const { api, adapter } = adapterFor();
    const { verdict } = await drain(adapter.apply(target(), job()));
    expect(verdict.phase).toBe('LIVE');
    expect(
      api.requests.filter((request) => request.path.endsWith(':setIamPolicy')),
    ).toEqual([]);
  });

  test('the runtime accepts it, and reports no address for it', async () => {
    const { api, adapter } = adapterFor();
    const { verdict } = await drain(adapter.apply(target(), job()));

    expect(api.job('shop-nightly')).toBeDefined();
    expect(api.service('shop-nightly')).toBeUndefined();
    expect(verdict.phase).toBe('LIVE');
    // §9: core mints nothing. A Job has no `uri` member at all, so the absence
    // here is the platform saying there is no address rather than core
    // declining to invent one.
    if (verdict.phase === 'LIVE') expect(verdict.url).toBeUndefined();
  });

  test('the Service nesting would be refused by the API, not silently taken', async () => {
    // The negative half of the first test. Google's protobuf-JSON parsers
    // reject an unknown member, so a renderer that nested once would fail at
    // apply with a message about a *name* rather than about a shape — which is
    // why the fake carries a closed Job schema rather than a `Map.set`.
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

  test('a schedule is refused rather than dropped', async () => {
    // A Cloud Run Job carries no schedule, and nothing in this vessel fires one
    // (**72**). Rendering the Job and saying nothing would leave a Component
    // reporting LIVE on a cadence nothing keeps — the same failure shape as a
    // declared change that reaches storage and never reaches what acts on it.
    const { api, adapter } = adapterFor();
    const { verdict } = await drain(
      adapter.apply(target(), job({ schedule: '0 3 * * *' })),
    );
    expect(verdict.phase).toBe('FAILED');
    if (verdict.phase === 'FAILED') {
      expect(verdict.reason).toBe('REJECTED');
      expect(blameFor(verdict.reason)).toBe('developer');
      expect(verdict.detail).toContain('schedule');
    }
    // Nothing was placed: a refusal that had already written the Job would be
    // the silent drop wearing an error message.
    expect(
      api.requests.filter((request) => request.method === 'PATCH'),
    ).toEqual([]);
  });
});

describe('the ref an adapter hands back names its own collection', () => {
  const job = () =>
    desired({ component: 'nightly', kind: 'job', reach: 'none', auth: 'none' });

  /** The shape of every ref written before jobs existed. */
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
    // Every ref in the database today says `services`. `observe` and `destroy`
    // are handed one with no kind beside it, so a parser that had learned only
    // `/jobs/` would orphan every running Service — nothing would read it and
    // nothing would delete it.
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
 * A job's runs (§17).
 *
 * A Job here is triggered by nothing, so an execution exists exactly when
 * something asked for one — `jobs.run` is that asking, and its `Operation`
 * carries the Execution the runtime named. The reading half is the sub-
 * collection, and the log half is the filter that a Service's would never
 * match: a run's entries are `cloud_run_job`, keyed on `job_name` and labelled
 * with the execution, none of which a `cloud_run_revision` filter selects.
 */
describe('a job is run, and its runs are read', () => {
  const JOB_REF =
    'projects/example-vessel/locations/somewhere/jobs/shop-nightly';
  const job = () =>
    desired({ component: 'nightly', kind: 'job', reach: 'none', auth: 'none' });

  /** One `Execution` as the API returns it. */
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
    // The short name, which is the only form the log filter's own
    // `execution_name` label carries.
    expect(started.execution.name).toBe('shop-nightly-1');
    expect(started.execution.outcome).toBe('running');
    expect(api.pathsOf('POST')).toContain(
      '/v2/projects/example-vessel/locations/somewhere/jobs/shop-nightly:run',
    );
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
    // `projects.locations.jobs.executions.list` documents no ordering and takes
    // no `orderBy`, so a page of `limit` is `limit` arbitrary runs. Asking for
    // exactly what the screen shows and sorting the reply is correct only if
    // the API happens to answer newest-first: seeded oldest-first, that reads
    // the same ten stale runs forever and a run started by the button is never
    // on the list. The page asked for is a ceiling, `limit` is what to report.
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
    // A run has tasks rather than revisions, and a column reading `unknown` for
    // every line a job ever writes is what a revision-shaped read produces.
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
