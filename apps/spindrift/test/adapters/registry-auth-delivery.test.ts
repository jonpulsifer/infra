/**
 * How a registry credential reaches the thing that pushes (§16).
 *
 * The whole of the secret handling is one decision, and this is where it is
 * held: **the token goes on the container's environment and never into the
 * program**. The BuildKit program is a string that lands in a Job's `command`
 * and in a Cloud Build step's `args` — both readable by anyone who can `get`
 * the object, and both kept for as long as the object is. A token interpolated
 * into it would be a token in an API object with an hours-long TTL.
 *
 * So every assertion here is a variation on: the program mentions the variable,
 * and nothing anywhere mentions the value.
 */
import { describe, expect, test } from 'bun:test';
import {
  buildKitProgram,
  dockerConfigFor,
  REGISTRY_AUTH_VAR,
} from '../../src/adapters/build/buildkit.ts';
import { InClusterBuildRoute } from '../../src/adapters/build/in-cluster.ts';
import type { KubernetesObject } from '../../src/adapters/deploy/kubernetes/api.ts';
import type { RegistryAuth } from '../../src/storage/registry-credentials.ts';

const TOKEN = 'a-token-that-must-not-appear-anywhere';

const AUTH: readonly RegistryAuth[] = [
  { host: 'registry-1.docker.io', username: 'an-owner', secret: TOKEN },
];

describe('the Docker config a builder is handed', () => {
  test('is the format every registry client reads', () => {
    const config = dockerConfigFor(AUTH);
    expect(config).not.toBeNull();
    expect(JSON.parse(config ?? '{}')).toEqual({
      auths: {
        'registry-1.docker.io': {
          auth: btoa(`an-owner:${TOKEN}`),
        },
      },
    });
  });

  /**
   * `null` and not an empty document: a route sets no variable at all when
   * there is no credential, so an installation that stores nothing leaves no
   * trace of the mechanism on its build objects.
   */
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
   * The program is identical whether or not a credential exists — it is the
   * *environment* that differs. A program that varied would make the presence
   * of a credential visible in every build object that ever ran.
   */
  test('is the same program either way', () => {
    expect(program).toContain(`if [ -n "\${${REGISTRY_AUTH_VAR}:-}" ]`);
  });
});

describe('the in-cluster route', () => {
  /** The Job this route composes, caught at `apply` before anything runs. */
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
          // The route turns this into a refusal it yields rather than throwing,
          // which is exactly what stops the build before it polls for a pod.
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
          registryAuth,
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
