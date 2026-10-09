/** KubeHands' sandboxes against a fake apiserver: the manifest, the mint and the pool. */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { SandboxConfig } from '../src/config.ts';
import { HARNESS_CONTAINER } from '../src/hands.ts';
import { KthxSites, parseSites, serialize } from '../src/kthx-sites.ts';
import { Kube } from '../src/kube.ts';
import {
  type KubeHandsDeps,
  type TurnLeaseSummary,
  WORKSPACE,
} from '../src/lease.ts';
import type { Profile } from '../src/profiles.ts';
import { PREEMPT_IDLE_MS } from '../src/sandbox-lease.ts';
import {
  sandboxLabels,
  sandboxManifest,
  sandboxName,
} from '../src/sandboxes.ts';
import type { ThreadRef } from '../src/surface.ts';
import {
  begin,
  CUSTODIAN,
  cleanUp,
  GUILD,
  Hooks,
  INVESTIGATOR,
  OPERATOR,
  OTHER_THREAD,
  type Rig,
  rig,
  SANDBOX_CONFIG,
  SANDBOX_IMAGE,
  THREAD,
  until,
} from './hands-support.ts';
import { FakeClock } from './support.ts';

afterEach(cleanUp);

const C = BACKGROUND_CONTEXT;
const NAME = sandboxName(THREAD);

const FULL: Partial<SandboxConfig> = {
  vault: {
    connectHost:
      'http://onepassword-connect.external-secrets.svc.cluster.local:8080',
    connectSecret: 'mate-onepassword',
  },
  kubeServiceAccount: 'mate-sandbox-admin',
  kubePeers: ['folly'],
  github: true,
  switchboard: {
    url: 'http://switchboard.elevenlabs.svc.cluster.local:8080',
    secret: 'mate-switchboard',
  },
};

type Json = Record<string, any>;

/** One turn that makes one tool call, so the thread gets its sandbox. */
async function mint(
  r: Rig,
  thread: ThreadRef = THREAD,
): Promise<TurnLeaseSummary & { error: string | null }> {
  const turn = begin(r.hands.thread(thread, new Hooks(), OPERATOR));
  const result = await turn.env.exists('.', C);
  const summary = await turn.lease.finish();
  turn.end();
  return { ...summary, error: result.ok ? null : result.error.message };
}

function object(r: Rig, name = NAME): Json {
  return r.fake.sandboxes.get(name) as Json;
}

function podTemplate(r: Rig, name = NAME): Json {
  return object(r, name).spec.podTemplate.spec;
}

function envOf(container: Json): Json {
  return Object.fromEntries(
    (container.env ?? []).map((e: Json) => [e.name, e]),
  );
}

/** Spares carry the spare label; a claimed one keeps its `mate-spare-` name. */
function spareNames(r: Rig): string[] {
  return [...r.fake.sandboxes.entries()]
    .filter(
      ([, o]) => (o.metadata as Json).labels['lolwtf.ca/spare'] === 'true',
    )
    .map(([name]) => name);
}

/**
 * A stand-in for the token file mate stamps each turn. `null` leaves it
 * absent, as in a sandbox before its first turn or after its last.
 */
function tokenFile(contents: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'mate-token-'));
  const path = join(dir, '.github-token');
  if (contents !== null) writeFileSync(path, contents, { mode: 0o600 });
  return path;
}

/**
 * `git credential <operation>` under the harness container's env. System and
 * global config are empty, as in the sandbox: no `/etc/gitconfig`, empty HOME.
 */
function credential(
  r: Rig,
  token: string,
  operation: 'fill' | 'approve' | 'reject',
  host: string,
  global = '/dev/null',
) {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    GIT_CONFIG_GLOBAL: global,
    GIT_CONFIG_SYSTEM: '/dev/null',
  };
  for (const entry of podTemplate(r).containers[0].env as {
    name: string;
    value?: string;
  }[]) {
    if (entry.value !== undefined) env[entry.name] = entry.value;
  }
  // The pod's value is a path inside the sandbox.
  env.MATE_GITHUB_TOKEN_FILE = token;
  // A fill gets no credential on stdin, or git answers it without asking a helper.
  const answer =
    operation === 'fill' ? '' : 'username=x-access-token\npassword=a-pat\n';
  return Bun.spawnSync(['git', 'credential', operation], {
    env,
    stdin: Buffer.from(`protocol=https\nhost=${host}\n${answer}\n`),
  });
}

/** A Sandbox as an earlier mate, or another process, left it. */
async function plant(
  r: Rig,
  name: string,
  labels: Record<string, string>,
): Promise<void> {
  const response = await new Kube(r.fake.config()).request(
    '/apis/agents.x-k8s.io/v1beta1/namespaces/mate/sandboxes',
    {
      method: 'POST',
      body: sandboxManifest({
        name,
        namespace: 'mate',
        labels,
        config: SANDBOX_CONFIG,
        image: SANDBOX_IMAGE,
        shutdownTime: new Date(Date.now() + 3_600_000).toISOString(),
        profile: OPERATOR,
      }),
    },
  );
  expect(response.status).toBe(201);
}

function withoutHands(labels: Record<string, string>): Record<string, string> {
  const copy = { ...labels };
  delete copy['lolwtf.ca/hands'];
  return copy;
}

describe('the manifest', () => {
  test('is the sandbox a thread gets, labelled with the hands it speaks', async () => {
    const r = rig({ config: FULL });
    expect(await mint(r)).toMatchObject({
      source: 'fresh',
      sandbox: NAME,
      error: null,
    });

    const sandbox = object(r);
    expect(sandbox.apiVersion).toBe('agents.x-k8s.io/v1beta1');
    expect(sandbox.kind).toBe('Sandbox');
    expect(sandbox.metadata.labels).toEqual({
      'app.kubernetes.io/name': 'mate-sandbox',
      'app.kubernetes.io/part-of': 'mate',
      'lolwtf.ca/minted-by': 'mate',
      'lolwtf.ca/guild': GUILD,
      'lolwtf.ca/hands': '2',
      'lolwtf.ca/profile': 'operator',
      'lolwtf.ca/surface': 'discord',
      'lolwtf.ca/thread': THREAD.id,
      'lolwtf.ca/channel': THREAD.channelId,
    });
    expect(sandbox.spec.podTemplate.metadata.labels).toEqual(
      sandbox.metadata.labels,
    );
    expect(sandbox.spec.shutdownPolicy).toBe('Delete');
    const ttl = Date.parse(sandbox.spec.shutdownTime) - Date.now();
    expect(ttl).toBeGreaterThan(110 * 60_000);
    expect(ttl).toBeLessThanOrEqual(120 * 60_000);

    const pod = podTemplate(r);
    expect(pod.runtimeClassName).toBe('kata-clh');
    expect(
      pod.affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution
        .nodeSelectorTerms,
    ).toEqual([
      {
        matchExpressions: [
          {
            key: 'node-role.kubernetes.io/control-plane',
            operator: 'DoesNotExist',
          },
        ],
      },
    ]);
    expect(pod.automountServiceAccountToken).toBe(false);
    expect(pod.securityContext).toMatchObject({
      runAsNonRoot: true,
      runAsUser: 1337,
      fsGroup: 1337,
    });
    expect(pod.initContainers[0].name).toBe('checkout');
    expect(pod.initContainers[0].command).toEqual([
      'git',
      'clone',
      '--depth',
      '50',
      '--branch',
      'main',
      'https://github.com/jonpulsifer/infra',
      WORKSPACE,
    ]);
    // The clone runs as the harness uid so the agent owns every file;
    // safe.directory covers the mount root.
    expect(pod.initContainers[0].securityContext.runAsUser).toBe(1337);
    expect(pod.initContainers[0].imagePullPolicy).toBe('IfNotPresent');

    const harness = pod.containers[0];
    expect(harness.name).toBe(HARNESS_CONTAINER);
    expect(harness.image).toBe(SANDBOX_IMAGE);
    expect(harness.imagePullPolicy).toBe('IfNotPresent');
    expect(harness.securityContext.capabilities.drop).toEqual(['ALL']);
    expect(harness.resources).toEqual({
      requests: { cpu: '250m', memory: '512Mi' },
      limits: { cpu: '2000m', memory: '4Gi' },
    });
    // The model and its key live in mate's pod; the sandbox runs tools only.
    const names = Object.keys(envOf(harness));
    expect(names.filter((n) => n.startsWith('OPENCODE_'))).toEqual([]);
    expect(names).not.toContain('KTHX_AGENT_TOKEN');
    expect(envOf(harness).KUBECONFIG.value).toBe('/home/agent/.kube/config');
  });

  // mise has no wildcard for disable_tools, so the image lists every repo tool.
  // An unlisted tool makes mise resolve it on every `mise run`, which fails offline.
  test('disables every tool the repo declares in the sandbox image', async () => {
    const toml = async <T>(path: string) =>
      Bun.TOML.parse(
        await Bun.file(new URL(path, import.meta.url)).text(),
      ) as T;
    const repo = await toml<{ tools: Record<string, unknown> }>(
      '../../../mise.toml',
    );
    const image = await toml<{ settings: { disable_tools: string[] } }>(
      '../../../images/mate-sandbox/mise.toml',
    );

    expect([...image.settings.disable_tools].sort()).toEqual(
      Object.keys(repo.tools).sort(),
    );
  });

  test('hands both containers the git config the checkout needs', async () => {
    const r = rig({ config: FULL });
    await mint(r);
    const pod = podTemplate(r);

    // fsGroup leaves the emptyDir root uid 0, so git needs safe.directory to
    // trust the repo. The image's agent user has no ident for `git commit`.
    for (const container of [pod.initContainers[0], pod.containers[0]]) {
      const env = envOf(container);
      expect(env.GIT_CONFIG_KEY_0.value).toBe('safe.directory');
      expect(env.GIT_CONFIG_VALUE_0.value).toBe(WORKSPACE);
      expect(env.GIT_CONFIG_KEY_1.value).toBe('user.name');
      expect(env.GIT_CONFIG_VALUE_1.value).toBe('clanky-bot[bot]');
      expect(env.GIT_CONFIG_KEY_2.value).toBe('user.email');
      expect(env.GIT_CONFIG_VALUE_2.value).toBe(
        '332275392+clanky-bot[bot]@users.noreply.github.com',
      );
      // The push username GitHub fixes for installation tokens is not the author.
      expect(env.GIT_CONFIG_VALUE_1.value).not.toBe('x-access-token');
    }
    // The checkout gets no credential helper and no secrets.
    const checkout = envOf(pod.initContainers[0]);
    expect(checkout.GIT_CONFIG_COUNT.value).toBe('3');
    expect(checkout.OP_CONNECT_TOKEN).toBeUndefined();
    expect(checkout.SWITCHBOARD_URL).toBeUndefined();
    expect(checkout.SWITCHBOARD_RING_TOKEN).toBeUndefined();
  });

  test('hands the harness the switchboard address and an optional ring token', async () => {
    const r = rig({ config: FULL });
    await mint(r);
    const env = envOf(podTemplate(r).containers[0]);

    expect(env.SWITCHBOARD_URL.value).toBe(
      'http://switchboard.elevenlabs.svc.cluster.local:8080',
    );
    // Optional: a missing Secret must not hold the sandbox in
    // CreateContainerConfigError. The pod names the Secret, never the token.
    expect(env.SWITCHBOARD_RING_TOKEN.valueFrom.secretKeyRef).toEqual({
      name: 'mate-switchboard',
      key: 'SWITCHBOARD_RING_TOKEN',
      optional: true,
    });
    expect(env.SWITCHBOARD_RING_TOKEN.value).toBeUndefined();
    expect(env.SWITCHBOARD_MISSION_TOKEN.valueFrom.secretKeyRef).toEqual({
      name: 'mate-switchboard',
      key: 'SWITCHBOARD_MISSION_TOKEN',
      optional: true,
    });
    expect(env.SWITCHBOARD_MISSION_TOKEN.value).toBeUndefined();
  });

  test('points the harness at Connect and never at a service account', async () => {
    const r = rig({ config: FULL });
    await mint(r);
    const env = envOf(podTemplate(r).containers[0]);

    expect(env.OP_CONNECT_HOST.value).toBe(
      'http://onepassword-connect.external-secrets.svc.cluster.local:8080',
    );
    expect(env.OP_CONNECT_TOKEN.valueFrom.secretKeyRef).toEqual({
      name: 'mate-onepassword',
      key: 'OP_CONNECT_TOKEN',
      optional: true,
    });
    expect(env.MATE_GITHUB_TOKEN_FILE.value).toBe('/home/agent/.github-token');
    // Never both 1Password authentication paths.
    expect(env.OP_SERVICE_ACCOUNT_TOKEN).toBeUndefined();
    // Otherwise a missing credential blocks when the agent's tool gives git a terminal.
    expect(env.GIT_TERMINAL_PROMPT.value).toBe('0');
  });

  test('hands the harness the kthx origin, and never the agent token', async () => {
    const r = rig({
      config: {
        kthx: {
          origin: 'https://kthx.example.test',
          sitesSecret: 'mate-kthx-sites',
        },
      },
    });
    await mint(r);
    const env = envOf(podTemplate(r).containers[0]);
    expect(env.KTHX_ORIGIN.value).toBe('https://kthx.example.test');
    // mate calls the engine's MCP server itself, with a token only it holds.
    expect(env.KTHX_AGENT_TOKEN).toBeUndefined();
  });

  // The helper is a shell snippet, so only running git proves its shape.
  test('git fills a github.com credential from the file mate stamped', async () => {
    const r = rig({ config: FULL });
    await mint(r);
    const token = tokenFile('ghs-a-token');

    const filled = credential(r, token, 'fill', 'github.com');
    expect(filled.stdout.toString()).toContain('username=x-access-token');
    expect(filled.stdout.toString()).toContain('password=ghs-a-token');

    // Scoped to the one URL: no other host reaches this helper.
    const other = credential(r, token, 'fill', 'gitlab.com');
    expect(other.exitCode).not.toBe(0);
    expect(other.stdout.toString()).not.toContain('password=');

    // Without the helper reset, this decoy global helper would answer first.
    const decoy = join(dirname(token), 'decoy.gitconfig');
    writeFileSync(
      decoy,
      '[credential]\n\thelper = "!echo username=somebody; echo password=not-the-token"\n',
    );
    const contested = credential(r, token, 'fill', 'github.com', decoy);
    expect(contested.stdout.toString()).toContain('username=x-access-token');
  });

  // GitHub reports a blank password as a rejected credential, which reads as revoked.
  test('a token that is absent or blank fails the fill rather than answering', async () => {
    const r = rig({ config: FULL });
    await mint(r);

    for (const contents of [null, '']) {
      const missing = credential(r, tokenFile(contents), 'fill', 'github.com');
      expect(missing.exitCode).not.toBe(0);
      expect(missing.stdout.toString()).not.toContain('password=');
    }
  });

  // No token file: a helper that read it before checking the operation would fail.
  test('storing and erasing a credential never read the token', async () => {
    const r = rig({ config: FULL });
    await mint(r);

    for (const operation of ['approve', 'reject'] as const) {
      const result = credential(r, tokenFile(null), operation, 'github.com');
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).not.toContain('password=');
    }
  });

  // gh ignores git's credential helper, so images/mate-sandbox/gh wraps it and
  // reads these variables by name. This test keeps the two in step.
  test('names the environment the image gh wrapper reads', async () => {
    const r = rig({ config: FULL });
    await mint(r);
    const env = envOf(podTemplate(r).containers[0]);
    const wrapper = await Bun.file(
      new URL('../../../images/mate-sandbox/gh', import.meta.url),
    ).text();

    const read = new Set<string>();
    for (const [, name] of wrapper.matchAll(/\$\{?((?:MATE|OP)_[A-Z_]+)/g)) {
      if (name) read.add(name);
    }
    expect(read.size).toBeGreaterThan(0);
    for (const name of read) expect(env[name]).toBeDefined();

    // gh gets its token only through the wrapper: the pod holds a path, never a token.
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
  });

  test('hands the harness no credential path when none is configured', async () => {
    const r = rig();
    await mint(r);
    const env = envOf(podTemplate(r).containers[0]);

    expect(env.GIT_CONFIG_COUNT.value).toBe('3');
    expect(env.OP_CONNECT_HOST).toBeUndefined();
    expect(env.OP_CONNECT_TOKEN).toBeUndefined();
    expect(env.MATE_GITHUB_TOKEN_FILE).toBeUndefined();
    expect(env.SWITCHBOARD_URL).toBeUndefined();
    expect(env.SWITCHBOARD_RING_TOKEN).toBeUndefined();
    expect(env.KUBECONFIG).toBeUndefined();
    expect(env.KTHX_ORIGIN).toBeUndefined();
  });

  test('pulls on every mint when the image is a bare tag', async () => {
    const r = rig({
      deps: { image: async () => 'ghcr.io/jonpulsifer/mate-sandbox:latest' },
    });
    await mint(r);

    const pod = podTemplate(r);
    expect(pod.initContainers[0].imagePullPolicy).toBe('Always');
    expect(pod.containers[0].imagePullPolicy).toBe('Always');
  });

  test('refuses a thread id that is not a snowflake', () => {
    expect(() => sandboxName({ ...THREAD, id: '../escape' })).toThrow(
      /not a snowflake/,
    );
  });
});

describe('the mint', () => {
  test('waits for the controller to report Ready', async () => {
    const r = rig();
    r.fake.readyOnCreate = false;
    const minted = mint(r);
    await until(() => r.fake.sandboxes.has(NAME));
    setTimeout(() => r.fake.markReady(NAME), 60);
    expect((await minted).error).toBeNull();
    expect(r.fake.pods.has(NAME)).toBe(true);
  });

  test('says so when it only claimed a sandbox that was already standing', async () => {
    const r = rig();
    await mint(r);
    expect((await mint(r)).source).toBe('reused');
    expect(r.log.of('sandbox already existed')).toHaveLength(1);
  });

  test('gives up when Ready never arrives, saying why and taking the sandbox with it', async () => {
    const r = rig({ deps: { readyTimeoutMs: 300 } });
    r.fake.readyOnCreate = false;
    const failed = await mint(r);
    expect(failed.error).toMatch(/was not ready in time/);
    expect(failed.source).toBe('failed');
    await until(() => !r.fake.sandboxes.has(NAME));
  });

  test('passes over a sandbox an earlier mate minted, and its name', async () => {
    const r = rig();
    await plant(r, NAME, withoutHands(sandboxLabels(THREAD, GUILD, OPERATOR)));
    const minted = await mint(r);
    expect(minted.source).toBe('fresh');
    expect(minted.sandbox).toMatch(new RegExp(`^${NAME}-[0-9a-f]{4}$`));
    expect(object(r, minted.sandbox as string).metadata.labels).toMatchObject({
      'lolwtf.ca/hands': '2',
      'lolwtf.ca/thread': THREAD.id,
    });
    // The old one is left for boot's condemn pass.
    expect(r.fake.sandboxes.has(NAME)).toBe(true);
  });

  test('ignores a pod it does not own', async () => {
    const r = rig();
    await plant(r, NAME, sandboxLabels(THREAD, GUILD, OPERATOR));
    r.fake.pods.delete(NAME);
    r.fake.pods.set('someone-elses', {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: {
        name: 'someone-elses',
        labels: { 'agents.x-k8s.io/sandbox-name-hash': NAME },
        ownerReferences: [{ kind: 'Sandbox', name: NAME, uid: 'other' }],
      },
      spec: {},
      status: { phase: 'Running' },
    });
    expect((await mint(r)).error).toMatch(/no running pod/);
  });
});

describe('release', () => {
  test('deletes the sandbox and waits for it to be gone', async () => {
    const r = rig();
    await mint(r);
    await r.hands.release(THREAD, 'quiet');
    expect(r.fake.sandboxes.has(NAME)).toBe(false);
    expect(r.fake.pods.has(NAME)).toBe(false);
    expect(r.fake.handsExecs.every((e) => e.clientClosed)).toBe(true);
  });

  test('a release of something already gone is not an error', async () => {
    const r = rig();
    await r.hands.release(THREAD, 'archived');
    expect(r.fake.sandboxes.size).toBe(0);
    expect(r.log.entries.filter((e) => e.level !== 'info')).toEqual([]);
  });
});

describe('the warm pool', () => {
  function pool(spares: number): Rig {
    return rig({ config: { spares } });
  }

  test('warms a sandbox that belongs to no thread', async () => {
    const r = pool(1);
    await r.hands.ensureSpares();

    const [name] = spareNames(r);
    expect(name).toMatch(/^mate-spare-/);
    const spare = object(r, name);
    expect(spare.metadata.labels).toEqual({
      'app.kubernetes.io/name': 'mate-sandbox',
      'app.kubernetes.io/part-of': 'mate',
      'lolwtf.ca/minted-by': 'mate',
      'lolwtf.ca/guild': GUILD,
      'lolwtf.ca/hands': '2',
      'lolwtf.ca/profile': 'operator',
      'lolwtf.ca/spare': 'true',
    });
    // The pod needs `app.kubernetes.io/name`, which the network policy selects on;
    // without it a spare can reach the LAN.
    expect(spare.spec.podTemplate.metadata.labels).toEqual(
      spare.metadata.labels,
    );
    // Its own short TTL, because nothing but the sweep renews a spare.
    const ttl = Date.parse(spare.spec.shutdownTime) - Date.now();
    expect(ttl).toBeGreaterThan(25 * 60_000);
    expect(ttl).toBeLessThanOrEqual(30 * 60_000);

    await r.hands.ensureSpares();
    expect(spareNames(r)).toHaveLength(1);
  });

  test('a thread takes the spare, and the spare takes its labels', async () => {
    const r = pool(1);
    await r.hands.ensureSpares();
    const [name] = spareNames(r);

    const minted = await mint(r);
    expect(minted).toMatchObject({ source: 'spare', sandbox: name });

    const adopted = object(r, name);
    expect(adopted.metadata.labels['lolwtf.ca/thread']).toBe(THREAD.id);
    expect(adopted.metadata.labels['lolwtf.ca/channel']).toBe(THREAD.channelId);
    expect(adopted.metadata.labels['lolwtf.ca/surface']).toBe('discord');
    expect(adopted.metadata.labels['lolwtf.ca/spare']).toBeUndefined();
    // The claiming patch also sets a thread's TTL.
    expect(Date.parse(adopted.spec.shutdownTime) - Date.now()).toBeGreaterThan(
      110 * 60_000,
    );
    // The spare's clone is as old as the spare, so it is fetched forward first,
    // and the ref is passed as `$1`, never spliced into the script.
    const refresh = r.fake.execs.find((e) => e.command[0] === '/bin/sh');
    expect(refresh?.container).toBe(HARNESS_CONTAINER);
    expect(refresh?.command).toEqual([
      '/bin/sh',
      '-c',
      `set -e; cd ${WORKSPACE}; git fetch --depth 1 origin "$1"; git reset --hard FETCH_HEAD`,
      'mate',
      'main',
    ]);
    // agent-sandbox copies template labels onto the running pod, so the pod names its thread too.
    expect(adopted.spec.podTemplate.metadata.labels).toEqual(
      adopted.metadata.labels,
    );
    await until(() => spareNames(r).length === 1);
  });

  test('a second thread cannot take the spare the first one took', async () => {
    const r = pool(1);
    await r.hands.ensureSpares();
    const [spare] = spareNames(r);

    const [first, second] = await Promise.all([
      mint(r, THREAD),
      mint(r, OTHER_THREAD),
    ]);
    expect(first.sandbox).not.toBe(second.sandbox);
    expect(
      [first, second].filter((minted) => minted.sandbox === spare),
    ).toHaveLength(1);
    const loser = first.sandbox === spare ? second : first;
    expect(loser.source).toBe('fresh');
  });

  test('the thread is found again by its label, not by a name it no longer has', async () => {
    const r = pool(1);
    await r.hands.ensureSpares();
    const first = await mint(r);

    const again = await mint(r);
    expect(again.sandbox).toBe(first.sandbox);
    expect(again.source).toBe('reused');
    expect(r.fake.sandboxes.has(NAME)).toBe(false);
  });

  test('a spare an earlier mate minted is never handed out', async () => {
    const r = pool(1);
    const labels = withoutHands(sandboxLabels(THREAD, GUILD, OPERATOR));
    for (const key of [
      'lolwtf.ca/surface',
      'lolwtf.ca/thread',
      'lolwtf.ca/channel',
    ]) {
      delete labels[key];
    }
    await plant(r, 'mate-spare-older', {
      ...labels,
      'lolwtf.ca/spare': 'true',
    });
    expect((await mint(r)).source).toBe('fresh');
  });

  test('with no pool configured, a mint never looks for a spare', async () => {
    const r = rig();
    await r.hands.ensureSpares();
    expect(r.fake.requests).toEqual([]);

    expect((await mint(r)).source).toBe('fresh');
    expect([...r.fake.sandboxes.keys()]).toEqual([NAME]);
    expect(r.fake.requests.some((q) => q.query.includes('spare'))).toBe(false);
  });

  test('renews what it holds, and only what still is one', async () => {
    const r = pool(1);
    await r.hands.ensureSpares();
    const [name] = spareNames(r);
    const spare = object(r, name);
    const first = Date.parse(spare.spec.shutdownTime);

    await Bun.sleep(10);
    await r.hands.ensureSpares();
    expect(Date.parse(spare.spec.shutdownTime)).toBeGreaterThan(first);
    // The resourceVersion stops a stale renewal overwriting a claimed spare's TTL.
    const slide = r.fake.patches.filter((p) => p.name === name).at(-1);
    expect(
      (slide?.body.metadata as Json | undefined)?.resourceVersion,
    ).toBeDefined();
  });

  test('a call that lands mid-pass gets a pass of its own', async () => {
    const r = pool(1);
    r.fake.readyOnCreate = false;
    const first = r.hands.ensureSpares();
    await until(() => spareNames(r).length === 1);

    // Joining the pass in flight would report the pool as counted before this call.
    const second = r.hands.ensureSpares();
    r.fake.markReady(spareNames(r)[0] ?? '');
    await Promise.all([first, second]);

    // Only the second pass had a spare to renew.
    expect(
      r.fake.patches.filter((p) => p.name.startsWith('mate-spare-')),
    ).toHaveLength(1);
  });

  test('keeps none of the spares an earlier mate left behind', async () => {
    const r = pool(1);
    await r.hands.ensureSpares();
    const [inherited] = spareNames(r);

    // Nothing on a spare records the ref it was built from.
    r.hands = r.another();
    await r.hands.ensureSpares();
    await until(() => !r.fake.sandboxes.has(inherited ?? ''));
    expect(spareNames(r)).toHaveLength(1);
    expect(spareNames(r)[0]).not.toBe(inherited);
  });

  test('a new sandbox image reaches the next mint and replaces the spare', async () => {
    let image = SANDBOX_IMAGE;
    const r = rig({
      config: { spares: 1 },
      deps: { image: async () => image },
    });
    await r.hands.ensureSpares();
    const [old] = spareNames(r);

    image = SANDBOX_IMAGE.replace(/[0-9a-f]{64}$/, '2'.repeat(64));
    expect(await mint(r)).toMatchObject({ sandbox: NAME, source: 'fresh' });
    expect(podTemplate(r).containers[0].image).toBe(image);
    expect(podTemplate(r).initContainers[0].image).toBe(image);

    await r.hands.ensureSpares();
    await until(() => !r.fake.sandboxes.has(old ?? ''));
    expect(r.log.of('condemned a spare that runs an older image')).toHaveLength(
      1,
    );
    const [fresh] = spareNames(r);
    expect(podTemplate(r, fresh).containers[0].image).toBe(image);
  });

  test('will not hand out a spare whose pod has gone', async () => {
    const r = pool(1);
    await r.hands.ensureSpares();
    const [name] = spareNames(r);
    r.fake.markNotReady(name ?? '');

    const minted = await mint(r);
    expect(minted).toMatchObject({ sandbox: NAME, source: 'fresh' });
  });

  test('replaces a spare that stopped being ready', async () => {
    const r = pool(1);
    await r.hands.ensureSpares();
    const [broken] = spareNames(r);
    const spare = object(r, broken);
    const held = Date.parse(spare.spec.shutdownTime);
    r.fake.markNotReady(broken ?? '');

    await r.hands.ensureSpares();
    // Not renewed: the TTL is the only thing that removes an unusable spare.
    expect(Date.parse(spare.spec.shutdownTime)).toBe(held);
    await until(() => !r.fake.sandboxes.has(broken ?? ''));
    expect(r.log.of('condemned a spare that stopped being ready')).toHaveLength(
      1,
    );
    // The resourceVersion stops a condemn landing on a spare a thread just claimed.
    const took = r.fake.patches.filter((patch) => patch.name === broken).at(0);
    expect(
      (took?.body.metadata as Json | undefined)?.resourceVersion,
    ).toBeDefined();

    const standing = spareNames(r);
    expect(standing).toHaveLength(1);
    expect(standing[0]).not.toBe(broken);
    expect((await mint(r)).source).toBe('spare');
  });

  test('reports what the pool holds against what it is for', async () => {
    const r = pool(1);
    await r.hands.ensureSpares();
    expect(r.metrics.pool).toEqual({ ready: 1, wanted: 1 });

    const [broken] = spareNames(r);
    r.fake.markNotReady(broken ?? '');
    r.fake.patchFails = true;
    await r.hands.ensureSpares();
    // One sandbox held, none usable: only this gauge shows a pool that stopped working.
    expect(r.metrics.pool).toEqual({ ready: 0, wanted: 1 });
  });

  test('a spare it could not take out is not joined by a replacement', async () => {
    const r = pool(1);
    await r.hands.ensureSpares();
    const [broken] = spareNames(r);
    r.fake.markNotReady(broken ?? '');
    r.fake.patchFails = true;

    await r.hands.ensureSpares();
    // It still holds node room, so a replacement would push the pool past its size.
    expect(spareNames(r)).toEqual([broken ?? '']);
    expect(
      r.log.of('could not condemn a spare that stopped being ready'),
    ).toHaveLength(1);
  });

  test('a refresh that fails takes the spare out rather than the thread', async () => {
    const r = pool(1);
    await r.hands.ensureSpares();
    const [spare] = spareNames(r);
    r.fake.commandFails = 'fatal: could not read from remote repository';

    const minted = await mint(r);
    // A spare is only worth handing out with a current checkout.
    expect(minted).toMatchObject({ sandbox: NAME, source: 'fresh' });
    expect(
      r.log.of('could not bring an adopted spare up to date; minting one'),
    ).toHaveLength(1);
    await until(() => !r.fake.sandboxes.has(spare ?? ''));
  });

  test('a spare that cannot be deleted still stops being the thread', async () => {
    const r = pool(1);
    await r.hands.ensureSpares();
    const [spare] = spareNames(r);
    r.fake.commandFails = 'fatal: could not read from remote repository';
    r.fake.deleteFails = true;

    await mint(r);
    // A failed delete must not leave a second object carrying the thread's labels.
    const wearing = [...r.fake.sandboxes.entries()]
      .filter(([, o]) => (o.metadata as Json).labels['lolwtf.ca/thread'])
      .map(([name]) => name);
    expect(wearing).toEqual([NAME]);
    expect(object(r, spare).metadata.labels['lolwtf.ca/spare']).toBe(
      'condemned',
    );
  });

  test('a thread whose sandbox is terminating gets a new one, not a refusal', async () => {
    const r = pool(1);
    await r.hands.ensureSpares();
    const adopted = await mint(r);
    await until(() => spareNames(r).length === 1);
    r.fake.terminating(adopted.sandbox as string);

    // Still labelled for the thread but terminating; `reuse` would fail on it.
    const again = await mint(r);
    expect(again.sandbox).not.toBe(adopted.sandbox);
    expect(again.source).toBe('spare');
  });
});

// A sandbox is minted for one profile: its labels, name and env follow the
// profile's grants, and a read-only one never reaches the kthx ledger.
describe('profiles', () => {
  const READER = `${NAME}-r`;
  const ORIGIN = 'https://kthx.example.test';
  const SECRET = 'mate-kthx-sites';
  const SITES = '.config/kthx/sites.json';
  const LEDGER = serialize({ [ORIGIN]: { blog: 'tok-blog' } });
  const HOSTILE = serialize({ [ORIGIN]: { blog: 'tok-attacker' } });

  function reader(
    opts: {
      config?: Partial<SandboxConfig>;
      deps?: Partial<KubeHandsDeps>;
    } = {},
  ): Rig {
    return rig({
      config: {
        ...FULL,
        kubeReaderServiceAccount: 'mate-sandbox-reader',
        kthx: { origin: ORIGIN, sitesSecret: SECRET },
        ...opts.config,
      },
      deps: opts.deps,
    });
  }

  function ledgered(r: Rig): KthxSites {
    return new KthxSites({
      kube: r.kube,
      namespace: 'mate',
      secret: SECRET,
      log: r.log,
    });
  }

  /** The ledger holds one site, and the hands fold sites into it. */
  function withLedger(r: Rig): Rig {
    r.fake.putSecret(SECRET, { 'sites.json': LEDGER });
    r.hands = r.another({ kthxSites: ledgered(r) });
    return r;
  }

  function leaveSites(r: Rig, contents: string): void {
    mkdirSync(dirname(join(r.home, SITES)), { recursive: true });
    writeFileSync(join(r.home, SITES), contents);
  }

  /** Nothing read the sandbox's sites file or wrote the ledger. */
  function ledgerUntouched(r: Rig): void {
    expect(r.fake.patches.filter((p) => p.name === SECRET)).toEqual([]);
    expect(r.fake.secretValue(SECRET, 'sites.json')).toBe(LEDGER);
    expect(r.metrics.siteSyncs).toEqual([]);
    for (const exec of r.fake.execs) {
      expect(exec.command.join(' ')).not.toContain('sites.json');
    }
  }

  async function mintAs(
    r: Rig,
    profile: Profile,
    thread: ThreadRef = THREAD,
  ): Promise<TurnLeaseSummary & { error: string | null }> {
    const turn = begin(r.hands.thread(thread, new Hooks(), profile));
    const result = await turn.env.exists('.', C);
    const summary = await turn.lease.finish();
    turn.end();
    return { ...summary, error: result.ok ? null : result.error.message };
  }

  function labelsOf(r: Rig, name: string): Json {
    return object(r, name).metadata.labels;
  }

  test('an operator sandbox carries every credential path, and its profile', async () => {
    const r = reader();
    await mint(r);
    expect(labelsOf(r, NAME)['lolwtf.ca/profile']).toBe('operator');
    expect(Object.keys(envOf(podTemplate(r).containers[0]))).toEqual([
      'OP_CONNECT_HOST',
      'OP_CONNECT_TOKEN',
      'KTHX_ORIGIN',
      'SWITCHBOARD_URL',
      'SWITCHBOARD_RING_TOKEN',
      'SWITCHBOARD_MISSION_TOKEN',
      'GIT_CONFIG_COUNT',
      'GIT_CONFIG_KEY_0',
      'GIT_CONFIG_VALUE_0',
      'GIT_CONFIG_KEY_1',
      'GIT_CONFIG_VALUE_1',
      'GIT_CONFIG_KEY_2',
      'GIT_CONFIG_VALUE_2',
      'GIT_CONFIG_KEY_3',
      'GIT_CONFIG_VALUE_3',
      'GIT_CONFIG_KEY_4',
      'GIT_CONFIG_VALUE_4',
      'GIT_TERMINAL_PROMPT',
      'MATE_GITHUB_TOKEN_FILE',
      'KUBECONFIG',
    ]);
  });

  test('an investigator sandbox has its own name and network, and no write credential', async () => {
    const r = reader();
    expect(await mintAs(r, INVESTIGATOR)).toMatchObject({
      sandbox: READER,
      source: 'fresh',
      error: null,
    });
    expect(r.fake.sandboxes.has(NAME)).toBe(false);
    expect(labelsOf(r, READER)).toEqual({
      'app.kubernetes.io/name': 'mate-sandbox-reader',
      'app.kubernetes.io/part-of': 'mate',
      'lolwtf.ca/minted-by': 'mate-reader',
      'lolwtf.ca/guild': GUILD,
      'lolwtf.ca/hands': '2',
      'lolwtf.ca/profile': 'investigator',
      'lolwtf.ca/checkout': 'closed',
      'lolwtf.ca/surface': 'discord',
      'lolwtf.ca/thread': THREAD.id,
      'lolwtf.ca/channel': THREAD.channelId,
    });
    // Minted with the window open, for the clone.
    expect(
      sandboxLabels(THREAD, GUILD, INVESTIGATOR)['lolwtf.ca/checkout'],
    ).toBe('open');
    const env = envOf(podTemplate(r, READER).containers[0]);
    for (const name of Object.keys(env)) {
      expect(name).not.toMatch(/^(SWITCHBOARD_|OP_)/);
    }
    expect(env.KTHX_ORIGIN).toBeUndefined();
    expect(env.MATE_GITHUB_TOKEN_FILE).toBeUndefined();
    expect(env.GIT_CONFIG_COUNT.value).toBe('3');
    expect(env.KUBECONFIG.value).toBe('/home/agent/.kube/config');

    const without = sandboxManifest({
      name: READER,
      namespace: 'mate',
      labels: sandboxLabels(THREAD, GUILD, INVESTIGATOR),
      config: { ...SANDBOX_CONFIG, ...FULL, kubeReaderServiceAccount: null },
      image: SANDBOX_IMAGE,
      shutdownTime: new Date().toISOString(),
      profile: INVESTIGATOR,
    }) as Json;
    expect(
      envOf(without.spec.podTemplate.spec.containers[0]).KUBECONFIG,
    ).toBeUndefined();
  });

  test('mate lists both kinds of sandbox; an image from before profiles lists only its own', async () => {
    const r = reader();
    await mint(r, OTHER_THREAD);
    await mintAs(r, INVESTIGATOR);
    const list = (selector: string) =>
      r.kube
        .json<{ items: Json[] }>(
          '/apis/agents.x-k8s.io/v1beta1/namespaces/mate/sandboxes',
          { query: { labelSelector: selector } },
        )
        .then(({ items }) => items.map((item) => item.metadata.name));
    expect(
      await list(
        `lolwtf.ca/minted-by in (mate,mate-reader),lolwtf.ca/guild=${GUILD}`,
      ),
    ).toEqual([sandboxName(OTHER_THREAD), READER]);
    expect(
      await list(`lolwtf.ca/minted-by=mate,lolwtf.ca/guild=${GUILD}`),
    ).toEqual([sandboxName(OTHER_THREAD)]);
    // Release finds it under the wider selector.
    await r.hands.release(THREAD, 'quiet');
    expect(r.fake.sandboxes.has(READER)).toBe(false);
  });

  test('an investigator never adopts a spare', async () => {
    const r = reader({ config: { spares: 1 } });
    await r.hands.ensureSpares();
    const [spare] = spareNames(r);
    expect((await mintAs(r, INVESTIGATOR)).source).toBe('fresh');
    expect(spareNames(r)).toEqual([spare ?? '']);
  });

  test('a thread keeps its profile: its hands refuse another', () => {
    const r = reader();
    r.hands.thread(THREAD, new Hooks(), OPERATOR);
    expect(() => r.hands.thread(THREAD, new Hooks(), INVESTIGATOR)).toThrow(
      /held under profile operator, not investigator/,
    );
  });

  test('an operator sandbox found for an investigator thread keeps its sites, then is condemned', async () => {
    const r = withLedger(reader());
    await mint(r);
    leaveSites(
      r,
      serialize({ [ORIGIN]: { blog: 'tok-blog', shop: 'tok-shop' } }),
    );
    // A later mate, with this thread's row born investigator.
    r.hands = r.another({ kthxSites: ledgered(r) });
    expect(await mintAs(r, INVESTIGATOR)).toMatchObject({
      sandbox: READER,
      source: 'fresh',
    });
    expect(
      r.log.of('a sandbox of this thread is labelled for another profile'),
    ).toHaveLength(1);
    expect(parseSites(r.fake.secretValue(SECRET, 'sites.json') ?? '')).toEqual({
      [ORIGIN]: { blog: 'tok-blog', shop: 'tok-shop' },
    });
    await until(() => !r.fake.sandboxes.has(NAME));
  });

  test('a reader sandbox labelled operator is condemned with no sites read', async () => {
    const r = withLedger(reader());
    await plant(r, 'mate-forged', {
      ...sandboxLabels(THREAD, GUILD, INVESTIGATOR),
      'lolwtf.ca/profile': 'operator',
    });
    leaveSites(r, HOSTILE);
    expect((await mintAs(r, INVESTIGATOR)).sandbox).toBe(READER);
    expect(
      r.log.of('a sandbox of this thread is labelled for another profile'),
    ).toHaveLength(1);
    await until(() => !r.fake.sandboxes.has('mate-forged'));
    ledgerUntouched(r);
  });

  test('a reader sandbox whose pod came back after the window closed is replaced at once', async () => {
    const r = reader();
    expect((await mintAs(r, INVESTIGATOR)).source).toBe('fresh');
    r.fake.recreatePod(READER);
    const started = Date.now();
    const again = await mintAs(r, INVESTIGATOR);
    expect(again).toMatchObject({ source: 'fresh', error: null });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(
      r.log.of('condemned a read-only sandbox whose pod cannot clone again'),
    ).toHaveLength(1);
  });

  test('a reader sandbox still booting with its window open is waited for and reused', async () => {
    const r = reader();
    r.fake.readyOnCreate = false;
    await plant(r, READER, sandboxLabels(THREAD, GUILD, INVESTIGATOR));
    setTimeout(() => r.fake.markReady(READER), 60);
    expect(await mintAs(r, INVESTIGATOR)).toMatchObject({
      sandbox: READER,
      source: 'reused',
      error: null,
    });
  });

  test('the window closes on the object, the template and the pod, and Cilium sees it, before the first command', async () => {
    const r = reader();
    r.fake.cepLags = 2;
    expect((await mintAs(r, INVESTIGATOR)).error).toBeNull();
    const closing = r.fake.patches.find(
      (p) =>
        p.name === READER &&
        (p.body.metadata as Json | undefined)?.labels?.['lolwtf.ca/checkout'],
    );
    expect(closing?.body).toEqual({
      metadata: { labels: { 'lolwtf.ca/checkout': 'closed' } },
      spec: {
        podTemplate: {
          metadata: { labels: { 'lolwtf.ca/checkout': 'closed' } },
        },
      },
    });
    const pod = r.fake.pods.get(READER) as Json;
    expect(pod.metadata.labels['lolwtf.ca/checkout']).toBe('closed');
    const endpoints = r.fake.requests
      .map((q, at) => ({ ...q, at }))
      .filter((q) => q.path.includes('/ciliumendpoints/'));
    expect(endpoints.length).toBeGreaterThanOrEqual(3);
    const firstExec = r.fake.requests.findIndex((q) =>
      q.path.endsWith('/exec'),
    );
    expect(firstExec).toBeGreaterThan(endpoints.at(-1)?.at ?? -1);
  });

  test('a window Cilium never sees closed takes the sandbox down and fails the turn', async () => {
    const r = reader();
    r.fake.cepLags = Number.MAX_SAFE_INTEGER;
    const failed = await mintAs(r, INVESTIGATOR);
    expect(failed.error).toMatch(/could not close its checkout window/);
    expect(failed.source).toBe('failed');
    expect(r.fake.handsExecs).toEqual([]);
    await until(() => !r.fake.sandboxes.has(READER));
  });

  test('a closed window whose check fails once is checked again, and its sandbox kept', async () => {
    const r = reader();
    expect((await mintAs(r, INVESTIGATOR)).error).toBeNull();
    r.fake.cepFails = 1;
    expect(await mintAs(r, INVESTIGATOR)).toMatchObject({
      sandbox: READER,
      source: 'reused',
      error: null,
    });
    expect(r.fake.cepFails).toBe(0);
    expect(r.fake.sandboxes.has(READER)).toBe(true);
  });

  test('a closed window Cilium cannot confirm fails the turn and keeps the sandbox', async () => {
    const r = reader();
    const hooks = new Hooks();
    const thread = r.hands.thread(THREAD, hooks, INVESTIGATOR);
    const first = begin(thread);
    expect((await first.env.exists('.', C)).ok).toBe(true);
    await first.lease.finish();
    first.end();
    r.fake.cepState = 'regenerating';
    const second = begin(thread);
    const result = await second.env.exists('.', C);
    expect(result.ok ? null : result.error.message).toMatch(
      /could not close its checkout window/,
    );
    await second.lease.finish();
    second.end();
    expect(hooks.gone).toEqual([]);
    expect(r.fake.sandboxes.has(READER)).toBe(true);
    expect(r.fake.handsExecs).toHaveLength(1);
  });

  test('a held sandbox deleted with its window open is gone, and frees its slot', async () => {
    const r = reader();
    await plant(r, READER, sandboxLabels(THREAD, GUILD, INVESTIGATOR));
    await r.hands.start();
    expect(r.metrics.live).toBe(1);
    r.fake.cepState = 'regenerating';
    const hooks = new Hooks();
    const turn = begin(r.hands.thread(THREAD, hooks, INVESTIGATOR));
    expect((await turn.env.exists('.', C)).ok).toBe(false);
    await turn.lease.finish();
    turn.end();
    expect(hooks.gone).toEqual(['lost']);
    await until(() => !r.fake.sandboxes.has(READER));
    expect(r.metrics.live).toBe(0);
    expect(r.fake.handsExecs).toEqual([]);
  });

  test('a reader pod whose window is open again is never spoken to', async () => {
    const r = reader();
    const turn = begin(r.hands.thread(THREAD, new Hooks(), INVESTIGATOR));
    expect((await turn.env.exists('.', C)).ok).toBe(true);
    const client = turn.lease.current();
    if (client) turn.lease.drop(client, 'deadline');
    (r.fake.pods.get(READER) as Json).metadata.labels['lolwtf.ca/checkout'] =
      'open';
    expect((await turn.env.exists('.', C)).ok).toBe(false);
    expect(turn.events).toContainEqual(
      expect.objectContaining({
        kind: 'lost',
        error: expect.stringContaining('still has its checkout window open'),
      }),
    );
    await turn.lease.finish();
    turn.end();
  });

  describe('a hostile sites file in a reader sandbox never reaches the ledger', () => {
    test('on release', async () => {
      const r = withLedger(reader());
      await mintAs(r, INVESTIGATOR);
      leaveSites(r, HOSTILE);
      await r.hands.release(THREAD, 'quiet');
      expect(r.fake.sandboxes.has(READER)).toBe(false);
      ledgerUntouched(r);
    });

    test('on eviction', async () => {
      const clock = new FakeClock();
      const r = reader({ deps: { maxSandboxes: 1, clock } });
      r.fake.putSecret(SECRET, { 'sites.json': LEDGER });
      r.hands = r.another({ kthxSites: ledgered(r) });
      const hooks = new Hooks();
      const turn = begin(r.hands.thread(THREAD, hooks, INVESTIGATOR));
      expect((await turn.env.exists('.', C)).ok).toBe(true);
      await turn.lease.finish();
      turn.end();
      leaveSites(r, HOSTILE);
      await clock.advance(PREEMPT_IDLE_MS);
      expect((await mintAs(r, INVESTIGATOR, OTHER_THREAD)).error).toBeNull();
      expect(hooks.gone).toEqual(['preempted']);
      ledgerUntouched(r);
    });

    test('on a loss', async () => {
      const r = withLedger(reader());
      leaveSites(r, HOSTILE);
      r.fake.oldHands = true;
      expect((await mintAs(r, INVESTIGATOR)).error).not.toBeNull();
      await until(() => !r.fake.sandboxes.has(READER));
      ledgerUntouched(r);
    });

    test('at boot, from an earlier mate', async () => {
      const r = withLedger(reader());
      await plant(
        r,
        READER,
        withoutHands(sandboxLabels(THREAD, GUILD, INVESTIGATOR)),
      );
      leaveSites(r, HOSTILE);
      expect(await r.hands.start()).toEqual([]);
      await until(() => !r.fake.sandboxes.has(READER));
      ledgerUntouched(r);
    });
  });

  test('a standing custodian sandbox counts in the automation lane', async () => {
    const clock = new FakeClock();
    const r = reader({ deps: { maxSandboxes: 1, clock } });
    await plant(r, NAME, sandboxLabels(THREAD, GUILD, CUSTODIAN));
    await r.hands.start();
    expect(r.metrics.live).toBe(1);
    // An automation waiter takes an idle automation holder, never an interactive one.
    await clock.advance(PREEMPT_IDLE_MS);
    expect((await mintAs(r, CUSTODIAN, OTHER_THREAD)).error).toBeNull();
    await until(() => !r.fake.sandboxes.has(NAME));
  });
});
