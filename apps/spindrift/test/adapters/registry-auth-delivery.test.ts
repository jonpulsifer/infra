/**
 * A registry credential reaches the builder on the container's environment,
 * never in the BuildKit program, which is stored in API objects anyone with
 * `get` can read.
 */
import { describe, expect, test } from 'bun:test';
import {
  buildKitProgram,
  dockerConfigFor,
  REGISTRY_AUTH_VAR,
} from '../../src/adapters/build/buildkit.ts';
import { CloudBuildRoute } from '../../src/adapters/build/cloud-build.ts';
import { InClusterBuildRoute } from '../../src/adapters/build/in-cluster.ts';
import type { KubernetesObject } from '../../src/adapters/deploy/kubernetes/api.ts';
import type { RegistryAuth } from '../../src/storage/registry-credentials.ts';

const TOKEN = 'a-token-that-must-not-appear-anywhere';

const AUTH: readonly RegistryAuth[] = [
  { host: 'registry-1.docker.io', username: 'an-owner', secret: TOKEN },
];

describe('the Docker config a builder is handed', () => {
  /**
   * BuildKit reads Docker Hub credentials only under the legacy index URL;
   * under either hostname the push fails with `push access denied`.
   */
  test('files Docker Hub under the key BuildKit reads it from', () => {
    const config = dockerConfigFor(AUTH);
    expect(config).not.toBeNull();
    expect(JSON.parse(config ?? '{}')).toEqual({
      auths: {
        'https://index.docker.io/v1/': {
          auth: btoa(`an-owner:${TOKEN}`),
        },
      },
    });
    // `docker.io`, as operators store it, maps to the same key.
    expect(
      JSON.parse(dockerConfigFor([{ ...AUTH[0]!, host: 'docker.io' }]) ?? '{}'),
    ).toEqual(JSON.parse(config ?? '{}'));
  });

  test('leaves every other registry under its own hostname', () => {
    const config = dockerConfigFor([
      { host: 'ghcr.io', username: 'an-owner', secret: TOKEN },
    ]);
    expect(JSON.parse(config ?? '{}')).toEqual({
      auths: { 'ghcr.io': { auth: btoa(`an-owner:${TOKEN}`) } },
    });
  });

  /** Null, so a route with no credential sets no variable at all. */
  test('is absent entirely when there is no credential', () => {
    expect(dockerConfigFor([])).toBeNull();
  });
});

describe('the BuildKit program', () => {
  const program = buildKitProgram({
    bundleUrl: 'https://depot.example.test/bundle.tgz',
    bundleDigest: 'sha256:bundle',
    subpath: '.',
    destinations: ['registry-1.docker.io/an-owner/web'],
    tags: ['latest'],
    zeroConfigFrontend: 'registry.example.test/zero-config',
    buildArgs: {},
    buildSecretNames: [],
  });

  test('reads the credential out of the environment, never out of itself', () => {
    expect(program).toContain(REGISTRY_AUTH_VAR);
    expect(program).not.toContain(TOKEN);
  });

  test('points DOCKER_CONFIG at its own directory and clears the variable', () => {
    expect(program).toContain('DOCKER_CONFIG=$(mktemp -d)');
    expect(program).toContain(`unset ${REGISTRY_AUTH_VAR}`);
  });

  /**
   * Only the environment varies, so a build object never shows whether a
   * credential exists.
   */
  test('is the same program either way', () => {
    expect(program).toContain(`if [ -n "\${${REGISTRY_AUTH_VAR}:-}" ]`);
  });
});

/**
 * The cloud builder pushes with its metadata-server identity and with stored
 * credentials at once, and both must be written to one Docker config.
 */
describe('the cloud build route', () => {
  async function stepFor(registryAuth: readonly RegistryAuth[]) {
    let submitted: unknown;
    const route = new CloudBuildRoute({
      name: 'managed',
      endpoint: 'https://builds.example.test',
      logsEndpoint: 'https://logs.example.test',
      project: 'a-project',
      region: 'a-region',
      image: 'registry.example.test/buildkit',
      zeroConfigFrontend: 'registry.example.test/zero-config',
      signer: '',
      attestor: '',
      token: () => 'a-bearer-token',
      fetch: async (request: Request) => {
        submitted = await request.json();
        return new Response('no', { status: 500 });
      },
    });

    for await (const _ of route.build(
      {
        bundleDigest: 'sha256:bundle',
        origin: {
          type: 'archive',
          location: 'https://depot.example.test/bundle.tgz',
          subpath: '.',
        },
      },
      {
        artifactType: 'image',
        kind: 'service',
        platform: { os: 'linux', arch: 'amd64' },
        // One of each: a host the metadata token covers, and one it does not.
        destinations: [
          'a-region-docker.pkg.dev/a-project/i/an-app/web',
          'registry-1.docker.io/an-owner/web',
        ],
        tags: ['latest'],
        buildArgs: {},
        outputDirectory: null,
        vercelFramework: null,
        registryAuth,
        buildSecrets: [],
      },
    )) {
      // drained for the submit; the route reports the 500 as a failure
    }

    const body = submitted as {
      steps: readonly {
        args: readonly string[];
        env?: readonly string[];
      }[];
    };
    const step = body.steps[0];
    if (step === undefined) throw new Error('no step was submitted');
    return step;
  }

  test('carries the stored credential on the env and not in the program', async () => {
    const step = await stepFor(AUTH);

    expect(step.env).toEqual([
      `${REGISTRY_AUTH_VAR}=${dockerConfigFor(AUTH) ?? ''}`,
    ]);
    expect(step.args.join('\n')).not.toContain(TOKEN);
  });

  /**
   * The prelude adds to the variable the program reads, since the program's
   * `DOCKER_CONFIG=$(mktemp -d)` hides any config written before it.
   */
  test('mints its own credential into the same document, never over it', async () => {
    // The build service turns the route's `$$` escape back into `$` before sh
    // sees it.
    const program = (await stepFor(AUTH)).args.join('\n').replaceAll('$$', '$');

    expect(program).toContain(`${REGISTRY_AUTH_VAR}="{\\"auths\\":{`);
    expect(program).toContain(`export ${REGISTRY_AUTH_VAR}`);
    expect(program.split('DOCKER_CONFIG=$(mktemp -d)')).toHaveLength(2);
  });

  /**
   * The build service reads `$UPPERCASE` and `${UPPERCASE}` in step fields as
   * substitutions and refuses unknown ones, so those must arrive `$$`-escaped.
   */
  test('submits no unescaped dollar the service reads as a substitution', async () => {
    const step = await stepFor(AUTH);

    for (const field of [...step.args, ...(step.env ?? [])]) {
      expect(field).not.toMatch(/(?<!\$)\$\{?[A-Z_][A-Z0-9_]*/);
    }
  });

  test('still mints one when this installation stores nothing', async () => {
    const step = await stepFor([]);

    expect(step.env).toBeUndefined();
    expect(step.args.join('\n')).toContain(`export ${REGISTRY_AUTH_VAR}`);
  });
});

describe('the in-cluster route', () => {
  async function jobFor(
    registryAuth: readonly RegistryAuth[],
  ): Promise<KubernetesObject> {
    const applied: KubernetesObject[] = [];
    const route = new InClusterBuildRoute({
      name: 'in-cluster',
      namespace: 'builds',
      image: 'registry.example.test/buildkit',
      zeroConfigFrontend: 'registry.example.test/zero-config',
      serviceAccount: 'builder',
      id: () => 'test',
      api: {
        apply: async (object: KubernetesObject) => {
          applied.push(object);
          // The route yields this as a refusal, before polling for a pod.
          throw new Error('caught after the Job was composed');
        },
      } as never,
    });

    // One step is enough: the Job is applied before the first yield.
    await route
      .build(
        {
          bundleDigest: 'sha256:bundle',
          origin: {
            type: 'archive',
            location: 'https://depot.example.test/bundle.tgz',
            subpath: '.',
          },
        },
        {
          artifactType: 'image',
          kind: 'service',
          platform: { os: 'linux', arch: 'amd64' },
          destinations: ['registry-1.docker.io/an-owner/web'],
          tags: ['latest'],
          buildArgs: {},
          outputDirectory: null,
          vercelFramework: null,
          registryAuth,
          buildSecrets: [],
        },
      )
      .next();

    const job = applied[0];
    if (job === undefined) throw new Error('no Job was composed');
    return job;
  }

  function containerOf(job: KubernetesObject) {
    const spec = job.spec as {
      template: {
        spec: {
          containers: readonly {
            command?: readonly string[];
            env?: readonly { name: string; value: string }[];
          }[];
        };
      };
    };
    const container = spec.template.spec.containers[0];
    if (container === undefined) throw new Error('the Job has no container');
    return container;
  }

  test('puts the credential on the container env and not in the command', async () => {
    const container = containerOf(await jobFor(AUTH));

    expect(container.env).toEqual([
      { name: REGISTRY_AUTH_VAR, value: dockerConfigFor(AUTH) ?? '' },
    ]);
    expect(JSON.stringify(container.command)).not.toContain(TOKEN);
  });

  test('declares no env at all without one', async () => {
    const job = await jobFor([]);

    expect(containerOf(job).env).toBeUndefined();
    expect(JSON.stringify(job)).not.toContain(TOKEN);
  });
});
