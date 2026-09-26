/** KubeSandboxes against a fake apiserver. */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { SandboxConfig } from '../src/config.ts';
import {
  KthxSites,
  parseSites,
  type Sites,
  serialize,
} from '../src/kthx-sites.ts';
import { Kube } from '../src/kube.ts';
import type { PromptSink, SandboxRef, Update } from '../src/sandbox.ts';
import type { TokenSource } from '../src/sandboxes.ts';
import {
  HARNESS_CONTAINER,
  KubeSandboxes,
  SESSION_ANNOTATION,
  sandboxName,
  TTL_MS,
  TURN_ANNOTATION,
  WORKSPACE,
} from '../src/sandboxes.ts';
import type { ThreadRef, ToolCall } from '../src/surface.ts';
import { FakeKube } from './fakeapi.ts';
import { RecordingInstruments, RecordingLog } from './support.ts';

const THREAD: ThreadRef = {
  surface: 'discord',
  id: '1509024937422356777',
  channelId: '1509024937422356532',
};
const GUILD = '1509024936717455381';
const NAME = sandboxName(THREAD);
const threadQuery = encodeURIComponent(
  `lolwtf.ca/minted-by=mate,lolwtf.ca/guild=${GUILD},lolwtf.ca/thread=${THREAD.id}`,
);

const OTHER_THREAD: ThreadRef = {
  surface: 'discord',
  id: '1509024937422356999',
  channelId: '1509024937422356532',
};

const config: SandboxConfig = {
  image:
    'ghcr.io/jonpulsifer/mate-sandbox:latest@sha256:6f135be2df9ddf2cca529e845b3325cba5c6e72c8587c1ce48ec30bd5b10cbac',
  runtimeClass: 'kata-clh',
  namespace: 'mate',
  secret: 'mate-opencode',
  checkoutRepo: 'https://github.com/jonpulsifer/infra',
  checkoutRef: 'main',
  model: 'opencode-go/qwen3.8-flash',
  turnTimeoutMs: 4000,
  spares: 0,
  vault: {
    connectHost:
      'http://onepassword-connect.external-secrets.svc.cluster.local:8080',
    connectSecret: 'mate-onepassword',
  },
  kubeServiceAccount: 'mate-sandbox-debug',
  github: true,
  kthx: {
    origin: null,
    sitesSecret: 'mate-kthx-sites',
    mcpUrl: null,
    agentSecret: 'mate-kthx-agent',
  },
  switchboard: {
    url: 'http://switchboard.elevenlabs.svc.cluster.local:8080',
    secret: 'mate-switchboard',
  },
};

class Collect implements PromptSink {
  text = '';
  readonly status: (string | null)[] = [];
  readonly cards: ToolCall[] = [];
  update(update: Update): void {
    if (update.kind === 'text') this.text += update.delta;
    else if (update.kind === 'tool') this.cards.push(update.call);
    else this.status.push(update.line);
  }
}

let fake: FakeKube;
let log: RecordingLog;
let metrics: RecordingInstruments;
let sandboxes: KubeSandboxes;

beforeEach(() => {
  fake = new FakeKube();
  log = new RecordingLog();
  metrics = new RecordingInstruments();
  sandboxes = new KubeSandboxes({
    kube: new Kube(fake.config()),
    config,
    guildId: GUILD,
    log,
    readyTimeoutMs: 4000,
    goneTimeoutMs: 4000,
  });
});

afterEach(() => {
  fake.stop();
});

function podTemplate(): Record<string, any> {
  const spec = fake.sandboxes.get(NAME)?.spec as Record<string, any>;
  return spec.podTemplate.spec;
}

function shutdownTime(): number {
  const spec = fake.sandboxes.get(NAME)?.spec as Record<string, any>;
  return Date.parse(spec.shutdownTime);
}

function envOf(container: Record<string, any>): Record<string, any> {
  return Object.fromEntries(
    (container.env ?? []).map((e: Record<string, unknown>) => [e.name, e]),
  );
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
  for (const entry of podTemplate().containers[0].env as {
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

async function attach(): Promise<SandboxRef> {
  const ref = await sandboxes.mint(THREAD);
  await sandboxes.attach(ref);
  return ref;
}

/** With `spares` warm sandboxes and recorded instruments. */
function withSpares(spares: number): KubeSandboxes {
  return new KubeSandboxes({
    kube: new Kube(fake.config()),
    config: { ...config, spares },
    guildId: GUILD,
    log,
    metrics,
    readyTimeoutMs: 4000,
    goneTimeoutMs: 4000,
  });
}

/** A claimed spare keeps its `mate-spare-` name, so only the label counts. */
function spareNames(): string[] {
  return [...fake.sandboxes.entries()]
    .filter(([, object]) => (object.metadata as any).labels['lolwtf.ca/spare'])
    .map(([name]) => name);
}

async function until(what: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!what()) {
    if (Date.now() > deadline) throw new Error('it never happened');
    await Bun.sleep(10);
  }
}

describe('mint', () => {
  test('stamps the sandbox a thread gets', async () => {
    const ref = await sandboxes.mint(THREAD);
    expect(ref).toEqual({ name: NAME, thread: THREAD, source: 'fresh' });

    const sandbox = fake.sandboxes.get(NAME) as Record<string, any>;
    expect(sandbox.apiVersion).toBe('agents.x-k8s.io/v1beta1');
    expect(sandbox.kind).toBe('Sandbox');
    expect(sandbox.metadata.labels).toMatchObject({
      'lolwtf.ca/minted-by': 'mate',
      'lolwtf.ca/surface': 'discord',
      'lolwtf.ca/thread': THREAD.id,
      'lolwtf.ca/channel': THREAD.channelId,
      'lolwtf.ca/guild': GUILD,
    });
    expect(sandbox.spec.shutdownPolicy).toBe('Delete');
    const ttl = Date.parse(sandbox.spec.shutdownTime) - Date.now();
    expect(ttl).toBeGreaterThan(110 * 60_000);
    expect(ttl).toBeLessThanOrEqual(120 * 60_000);

    const pod = podTemplate();
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
    expect(harness.image).toBe(config.image);
    expect(harness.imagePullPolicy).toBe('IfNotPresent');
    expect(harness.securityContext.capabilities.drop).toEqual(['ALL']);
    expect(harness.resources).toEqual({
      requests: { cpu: '250m', memory: '512Mi' },
      limits: { cpu: '2000m', memory: '4Gi' },
    });
    const env = envOf(harness);
    expect(env.OPENCODE_API_KEY.valueFrom.secretKeyRef).toEqual({
      name: 'mate-opencode',
      key: 'OPENCODE_API_KEY',
    });
    expect(env.OPENCODE_DISABLE_PROJECT_CONFIG.value).toBe('1');
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT.value)).toEqual({
      model: 'opencode-go/qwen3.8-flash',
      instructions: [`${WORKSPACE}/AGENTS.md`],
      skills: { paths: [`${WORKSPACE}/dotfiles/skills`] },
      permission: 'allow',
      autoupdate: false,
      share: 'disabled',
    });
  });

  // A rename would point every sandbox at a missing instruction file.
  test('names an instruction file the checkout really has', async () => {
    const root = new URL('../../../AGENTS.md', import.meta.url);
    expect(await Bun.file(root).exists()).toBe(true);
  });

  // opencode is silent about a skills path that is missing or empty.
  test('names a skills directory that really holds skills', async () => {
    const dir = new URL('../../../dotfiles/skills/', import.meta.url);
    const skills = [...new Bun.Glob('*/SKILL.md').scanSync(dir.pathname)];
    expect(skills.length).toBeGreaterThan(0);
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
    await sandboxes.mint(THREAD);
    const pod = podTemplate();

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
    await sandboxes.mint(THREAD);
    const env = envOf(podTemplate().containers[0]);

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
  });

  test('points the harness at Connect and never at a service account', async () => {
    await sandboxes.mint(THREAD);
    const env = envOf(podTemplate().containers[0]);

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

  // The helper is a shell snippet, so only running git proves its shape.
  test('git fills a github.com credential from the file mate stamped', async () => {
    await sandboxes.mint(THREAD);
    const token = tokenFile('ghs-a-token');

    const filled = credential(token, 'fill', 'github.com');
    expect(filled.stdout.toString()).toContain('username=x-access-token');
    expect(filled.stdout.toString()).toContain('password=ghs-a-token');

    // Scoped to the one URL: no other host reaches this helper.
    const other = credential(token, 'fill', 'gitlab.com');
    expect(other.exitCode).not.toBe(0);
    expect(other.stdout.toString()).not.toContain('password=');

    // Without the helper reset, this decoy global helper would answer first.
    const decoy = join(dirname(token), 'decoy.gitconfig');
    writeFileSync(
      decoy,
      '[credential]\n\thelper = "!echo username=somebody; echo password=not-the-token"\n',
    );
    const contested = credential(token, 'fill', 'github.com', decoy);
    expect(contested.stdout.toString()).toContain('username=x-access-token');
  });

  // GitHub reports a blank password as a rejected credential, which reads as revoked.
  test('a token that is absent or blank fails the fill rather than answering', async () => {
    await sandboxes.mint(THREAD);

    for (const contents of [null, '']) {
      const missing = credential(tokenFile(contents), 'fill', 'github.com');
      expect(missing.exitCode).not.toBe(0);
      expect(missing.stdout.toString()).not.toContain('password=');
    }
  });

  // No token file: a helper that read it before checking the operation would fail.
  test('storing and erasing a credential never read the token', async () => {
    await sandboxes.mint(THREAD);

    for (const operation of ['approve', 'reject'] as const) {
      const result = credential(tokenFile(null), operation, 'github.com');
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).not.toContain('password=');
    }
  });

  // gh ignores git's credential helper, so images/mate-sandbox/gh wraps it and
  // reads these variables by name. This test keeps the two in step.
  test('names the environment the image gh wrapper reads', async () => {
    await sandboxes.mint(THREAD);
    const env = envOf(podTemplate().containers[0]);
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
    sandboxes = new KubeSandboxes({
      kube: new Kube(fake.config()),
      config: { ...config, vault: null, github: false, switchboard: null },
      guildId: GUILD,
      log,
    });
    await sandboxes.mint(THREAD);
    const env = envOf(podTemplate().containers[0]);

    expect(env.GIT_CONFIG_COUNT.value).toBe('3');
    expect(env.OP_CONNECT_HOST).toBeUndefined();
    expect(env.OP_CONNECT_TOKEN).toBeUndefined();
    expect(env.MATE_GITHUB_TOKEN_FILE).toBeUndefined();
    expect(env.SWITCHBOARD_URL).toBeUndefined();
    expect(env.SWITCHBOARD_RING_TOKEN).toBeUndefined();
  });

  test('waits for the controller to report Ready', async () => {
    fake.readyOnCreate = false;
    const minted = sandboxes.mint(THREAD);
    setTimeout(() => fake.markReady(NAME), 60);
    await minted;
    expect(fake.pods.has(NAME)).toBe(true);
  });

  test('says so when it only claimed a sandbox that was already standing', async () => {
    await sandboxes.mint(THREAD);
    const again = await sandboxes.mint(THREAD);
    expect(again.source).toBe('reused');
  });

  test('gives up when Ready never arrives, saying why and taking the sandbox with it', async () => {
    fake.readyOnCreate = false;
    sandboxes = new KubeSandboxes({
      kube: new Kube(fake.config()),
      config,
      guildId: GUILD,
      log,
      readyTimeoutMs: 300,
      goneTimeoutMs: 4000,
    });
    await expect(sandboxes.mint(THREAD)).rejects.toThrow(
      /was not ready in time/,
    );
    expect(fake.sandboxes.has(NAME)).toBe(false);
  });

  test('pulls on every mint when the image is a bare tag', async () => {
    sandboxes = new KubeSandboxes({
      kube: new Kube(fake.config()),
      config: { ...config, image: 'ghcr.io/jonpulsifer/mate-sandbox:latest' },
      guildId: GUILD,
      log,
    });
    await sandboxes.mint(THREAD);

    const pod = podTemplate();
    expect(pod.initContainers[0].imagePullPolicy).toBe('Always');
    expect(pod.containers[0].imagePullPolicy).toBe('Always');
  });

  test('refuses a thread id that is not a snowflake', () => {
    expect(() => sandboxName({ ...THREAD, id: '../escape' })).toThrow(
      /not a snowflake/,
    );
  });
});

describe('attach', () => {
  test('execs the harness and opens a fresh session', async () => {
    const ref = await sandboxes.mint(THREAD);
    const session = await sandboxes.attach(ref);

    const exec = fake.lastExec;
    expect(exec?.pod).toBe(NAME);
    expect(exec?.container).toBe(HARNESS_CONTAINER);
    expect(exec?.command).toEqual(['opencode', 'acp', '--cwd', WORKSPACE]);
    expect(exec?.protocol).toBe('v4.channel.k8s.io');
    expect(exec?.authorization).toBe('Bearer fake-token');
    expect(exec?.stdin.some((line) => line.includes('"initialize"'))).toBe(
      true,
    );
    expect(exec?.stdin.some((line) => line.includes('"session/new"'))).toBe(
      true,
    );

    expect(session.id).toMatch(/^ses-/);
    const stored = fake.sandboxes.get(NAME) as Record<string, any>;
    expect(stored.metadata.annotations[SESSION_ANNOTATION]).toBe(session.id);
  });

  test('loads the stored session before opening a new one', async () => {
    const ref = await attach();
    const first = fake.sandboxes.get(NAME) as Record<string, any>;
    const stored = first.metadata.annotations[SESSION_ANNOTATION];

    const again = await sandboxes.attach(ref);
    expect(again.id).toBe(stored);
    const last = fake.lastExec;
    expect(last?.stdin.some((line) => line.includes('"session/load"'))).toBe(
      true,
    );
    expect(last?.stdin.some((line) => line.includes('"session/new"'))).toBe(
      false,
    );
    // A mate that died left its harness running; the reconnect kills it first.
    expect(fake.execs.map((e) => e.command)).toContainEqual([
      '/bin/sh',
      '-c',
      'pkill -x opencode; exit 0',
    ]);
  });

  test('falls back to a new session when the harness cannot replay', async () => {
    const ref = await attach();
    const before = (fake.sandboxes.get(NAME) as Record<string, any>).metadata
      .annotations[SESSION_ANNOTATION];
    fake.script = { loadFails: true };

    const again = await sandboxes.attach(ref);
    expect(again.id).not.toBe(before);
    expect(fake.lastExec?.stdin.some((l) => l.includes('"session/new"'))).toBe(
      true,
    );
    expect(
      log.of('acp session/load failed; opening a new session'),
    ).toHaveLength(1);
  });

  test('leaves nothing attached when the object cannot be patched', async () => {
    const ref = await sandboxes.mint(THREAD);
    fake.patchFails = true;

    expect(sandboxes.attach(ref)).rejects.toThrow(/forbidden/);
    await Bun.sleep(20);
    expect(fake.lastExec?.clientClosed).toBe(true);
    expect(
      sandboxes.prompt(
        { id: 'ses-whatever', sandbox: ref, resumed: false },
        'hi',
        new Collect(),
      ),
    ).rejects.toThrow(/not attached/);
  });

  // A credential stamp is a one-shot exec beside the ACP stream.
  describe('the turn credential', () => {
    class FakeApp implements TokenSource {
      minted = 0;
      readonly revoked: string[] = [];
      failMint: Error | null = null;
      async token(): Promise<{ token: string }> {
        if (this.failMint) throw this.failMint;
        this.minted += 1;
        return { token: `ghs-token-${this.minted}` };
      }
      async revoke(token: string): Promise<void> {
        this.revoked.push(token);
      }
    }

    let app: FakeApp;

    async function turning() {
      app = new FakeApp();
      sandboxes = new KubeSandboxes({
        kube: new Kube(fake.config()),
        config,
        guildId: GUILD,
        log,
        metrics,
        githubApp: app,
      });
      const ref = await sandboxes.mint(THREAD);
      return sandboxes.attach(ref);
    }

    /** Every one-shot exec that wrote the token file, oldest first. */
    function stamps() {
      return fake.execs.filter((e) =>
        e.command.some((word) => word.includes('.github-token')),
      );
    }

    /** The four values one stamp wrote, in the order the script consumes them. */
    function wrote(at: number) {
      const stamp = stamps()[at];
      const [, , , , github, kube, ssh, sshConfig] = stamp?.command ?? [];
      return { github, kube, ssh, sshConfig };
    }

    test('writes every credential as an argument and never onto stdin', async () => {
      const session = await turning();
      await sandboxes.prompt(session, 'open a pull request', new Collect());

      const [stamp] = stamps();
      expect(stamp?.container).toBe(HARNESS_CONTAINER);
      // argv, because the exec stream has no half-close: a command reading
      // stdin would wait for an EOF that never arrives.
      expect(stamp?.command.slice(0, 2)).toEqual(['/bin/sh', '-c']);
      expect(stamp?.command[2]).toContain('umask 077');
      expect(stamp?.command[2]).toContain('/home/agent/.github-token');
      expect(stamp?.command[2]).toContain('/home/agent/.kube/config');
      expect(stamp?.command[2]).toContain('/home/agent/.ssh/id_ed25519');
      expect(wrote(0).github).toBe('ghs-token-1');
      expect(stamp?.stdin.join('')).not.toContain('ghs-token-1');
      expect(metrics.tokenMints).toEqual(['ok']);
      expect(metrics.tokenStamps).toEqual(['ok']);
    });

    test('mints cluster access that outlasts the turn, and verifies the apiserver', async () => {
      const session = await turning();
      await sandboxes.prompt(
        session,
        'why is the pod crashlooping',
        new Collect(),
      );

      expect(fake.tokenRequests).toHaveLength(1);
      const [asked] = fake.tokenRequests;
      expect(asked?.account).toBe('mate-sandbox-debug');
      // The token must outlive the longest turn.
      expect(asked?.expirationSeconds).toBeGreaterThan(
        config.turnTimeoutMs / 1000,
      );
      expect(asked?.audiences).toEqual(['https://kubernetes.default.svc:443']);

      const kubeconfig = wrote(0).kube ?? '';
      expect(kubeconfig).toContain('token: sa-token-1');
      expect(kubeconfig).toContain(
        'server: https://kubernetes.default.svc:443',
      );
      // Never skip-verify on an agent's behalf.
      expect(kubeconfig).not.toContain('insecure-skip-tls-verify');
    });

    test('truncates everything and hands the token back when the turn ends', async () => {
      const session = await turning();
      await sandboxes.prompt(session, 'hi', new Collect());

      // Two stamps: the credentials going in, and empty strings clearing them.
      expect(stamps()).toHaveLength(2);
      expect(wrote(1)).toEqual({
        github: '',
        kube: '',
        ssh: '',
        sshConfig: '',
      });
      expect(app.revoked).toEqual(['ghs-token-1']);
    });

    test('answers the turn anyway when no credential can be minted', async () => {
      const session = await turning();
      app.failMint = new Error('422 from GitHub');
      fake.tokenRequestFails = 'no RBAC for serviceaccounts/token';

      // Without credentials the agent can still read and explain.
      const result = await sandboxes.prompt(session, 'hi', new Collect());
      expect(result.stopReason).toBe('end_turn');
      expect(wrote(0)).toEqual({
        github: '',
        kube: '',
        ssh: '',
        sshConfig: '',
      });
      expect(metrics.tokenMints).toEqual(['mint-failed']);
      expect(app.revoked).toEqual([]);
      expect(
        log.of('could not mint a GitHub token for this turn'),
      ).toHaveLength(1);
      expect(
        log.of('could not mint cluster access for this turn'),
      ).toHaveLength(1);
    });

    test('spends the token at once when it cannot be stamped', async () => {
      const session = await turning();
      fake.commandFails = 'container not found';

      const result = await sandboxes.prompt(session, 'hi', new Collect());
      expect(result.stopReason).toBe('end_turn');
      // It never reached the sandbox, so it is revoked at once.
      expect(app.revoked).toEqual(['ghs-token-1']);
      expect(metrics.tokenStamps).toEqual(['stamp-failed']);
    });

    test('stamps an SSH key and the client config that finds it', async () => {
      const app = new FakeApp();
      sandboxes = new KubeSandboxes({
        kube: new Kube(fake.config()),
        config,
        guildId: GUILD,
        log,
        metrics,
        githubApp: app,
        sshKey: 'PRIVATE-KEY-BYTES',
      });
      const ref = await sandboxes.mint(THREAD);
      const session = await sandboxes.attach(ref);
      await sandboxes.prompt(session, 'ssh to oldschool', new Collect());

      const first = wrote(0);
      expect(first.ssh).toBe('PRIVATE-KEY-BYTES');
      expect(first.sshConfig).toContain('User rowbutt');
      expect(first.sshConfig).toContain(
        'IdentityFile /home/agent/.ssh/id_ed25519',
      );
      // The agent's home is a fresh emptyDir with no known hosts, so `yes` would refuse all.
      expect(first.sshConfig).toContain('StrictHostKeyChecking accept-new');
      // umask 077, because ssh refuses a private key others can read.
      expect(stamps()[0]?.command[2]).toContain('umask 077');
      expect(stamps()[0]?.command[2]).toContain('mkdir -p /home/agent/.ssh');
    });

    test('writes no key and no client config when mate holds none', async () => {
      const session = await turning();
      await sandboxes.prompt(session, 'hi', new Collect());
      // A config naming a missing IdentityFile makes every failure look like a rejected key.
      expect(wrote(0).ssh).toBe('');
      expect(wrote(0).sshConfig).toBe('');
    });

    test('stamps nothing at all with no App and no cluster account', async () => {
      sandboxes = new KubeSandboxes({
        kube: new Kube(fake.config()),
        config: { ...config, kubeServiceAccount: null },
        guildId: GUILD,
        log,
      });
      const ref = await sandboxes.mint(THREAD);
      const session = await sandboxes.attach(ref);
      await sandboxes.prompt(session, 'hi', new Collect());
      expect(fake.tokenRequests).toEqual([]);
      // Not even a clearing exec: there is nothing to write or clear.
      expect(stamps()).toEqual([]);
    });
  });

  // The CLI's token file is stamped from a Secret at a turn's start and read
  // back into it at the end, so a site claimed here outlives the sandbox.
  describe('the kthx sites', () => {
    const ORIGIN = 'https://kthx.example.test';
    const MCP = 'http://spindrift.spindrift.svc.cluster.local:3000/mcp';
    const FILE = '/home/agent/.config/kthx/sites.json';
    const SECRET = 'mate-kthx-sites';
    const kthxConfig: SandboxConfig = {
      ...config,
      kthx: {
        origin: ORIGIN,
        sitesSecret: SECRET,
        mcpUrl: MCP,
        agentSecret: 'mate-kthx-agent',
      },
    };

    function held(names: Record<string, string>): Sites {
      return { [ORIGIN]: names };
    }

    function turning(sandboxConfig = kthxConfig) {
      const kube = new Kube(fake.config());
      sandboxes = new KubeSandboxes({
        kube,
        config: sandboxConfig,
        guildId: GUILD,
        log,
        metrics,
        kthxSites: new KthxSites({
          kube,
          namespace: fake.namespace,
          secret: SECRET,
          log,
        }),
      });
      return sandboxes;
    }

    /** Every one-shot exec that stamped credentials, oldest first. */
    function stamps() {
      return fake.execs.filter((e) =>
        e.command.some((word) => word.includes('.github-token')),
      );
    }

    function secretPatches() {
      return fake.patches.filter((patch) => patch.name === SECRET);
    }

    function stored(): Sites {
      return parseSites(fake.secretValue(SECRET, 'sites.json') ?? '');
    }

    /** A turn during which the agent leaves `contents` in the CLI's file. */
    async function turnLeaving(contents: string | null) {
      fake.script = { chunks: ['one', 'two'], chunkDelayMs: 80 };
      const ref = await sandboxes.mint(THREAD);
      const session = await sandboxes.attach(ref);
      const turn = sandboxes.prompt(session, 'claim a site', new Collect());
      // After the stamp, before the harvest.
      await until(() => stamps().length === 1);
      await Bun.sleep(20);
      if (contents !== null) fake.files.set(FILE, contents);
      return { ref, result: await turn };
    }

    test('hands the harness the origin, the agent token and the MCP server', async () => {
      await turning().mint(THREAD);
      const env = envOf(podTemplate().containers[0]);

      expect(env.KTHX_ORIGIN.value).toBe(ORIGIN);
      // `optional`: the owner mints this token; until then no Secret exists.
      expect(env.KTHX_AGENT_TOKEN.valueFrom.secretKeyRef).toEqual({
        name: 'mate-kthx-agent',
        key: 'KTHX_AGENT_TOKEN',
        optional: true,
      });
      expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT.value).mcp).toEqual({
        kthx: {
          type: 'remote',
          url: MCP,
          enabled: true,
          headers: { Authorization: 'Bearer {env:KTHX_AGENT_TOKEN}' },
          oauth: false,
          timeout: 10000,
        },
      });
    });

    test('each half stands alone', async () => {
      await turning({
        ...kthxConfig,
        kthx: { ...kthxConfig.kthx, mcpUrl: null },
      }).mint(THREAD);
      let env = envOf(podTemplate().containers[0]);
      expect(env.KTHX_ORIGIN.value).toBe(ORIGIN);
      expect(env.KTHX_AGENT_TOKEN).toBeUndefined();
      expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT.value).mcp).toBeUndefined();

      fake.sandboxes.clear();
      await turning({
        ...kthxConfig,
        kthx: { ...kthxConfig.kthx, origin: null },
      }).mint(THREAD);
      env = envOf(podTemplate().containers[0]);
      expect(env.KTHX_ORIGIN).toBeUndefined();
      expect(env.KTHX_AGENT_TOKEN.valueFrom.secretKeyRef.name).toBe(
        'mate-kthx-agent',
      );
      expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT.value).mcp.kthx.url).toBe(
        MCP,
      );
    });

    test('with neither knob the sandbox is exactly what it was', async () => {
      const ref = await sandboxes.mint(THREAD);
      const env = envOf(podTemplate().containers[0]);
      expect(env.KTHX_ORIGIN).toBeUndefined();
      expect(env.KTHX_AGENT_TOKEN).toBeUndefined();
      expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT.value)).not.toHaveProperty(
        'mcp',
      );

      // The stamp neither reads nor writes the file, and nothing touches the Secret.
      const session = await sandboxes.attach(ref);
      await sandboxes.prompt(session, 'hi', new Collect());
      for (const exec of fake.execs) {
        expect(exec.command.join(' ')).not.toContain('kthx');
      }
      expect(fake.requests.some((r) => r.path.includes('/secrets/'))).toBe(
        false,
      );
      expect(metrics.siteSyncs).toEqual([]);
    });

    test('stamps the file from the Secret and truncates it after the turn', async () => {
      turning();
      fake.putSecret(SECRET, {
        'sites.json': serialize(held({ blog: 'tok-blog' })),
      });
      const { result } = await turnLeaving(null);
      expect(result.stopReason).toBe('end_turn');

      const [stamp, retire] = stamps();
      expect(stamp?.command[2]).toContain('umask 077');
      expect(stamp?.command[2]).toContain(`"$(dirname ${FILE})"`);
      expect(stamp?.command[2]).toContain(`printf %s "$5" > ${FILE}`);
      expect(parseSites(stamp?.command[8] ?? '')).toEqual(
        held({ blog: 'tok-blog' }),
      );
      // Read back unchanged: nothing to save, and the file is cleared.
      expect(retire?.command[8]).toBe('{}\n');
      expect(fake.files.get(FILE)).toBe('{}\n');
      expect(secretPatches()).toEqual([]);
      expect(metrics.siteSyncs).toEqual(['ok', 'ok']);
    });

    test('a site claimed during the turn is saved under mate s own field manager', async () => {
      turning();
      fake.putSecret(SECRET, {
        'sites.json': serialize(held({ blog: 'tok-blog' })),
      });
      const before = fake.secretRevision(SECRET);
      await turnLeaving(
        serialize(held({ blog: 'tok-blog', shop: 'tok-shop' })),
      );

      const [patch] = secretPatches();
      expect(secretPatches()).toHaveLength(1);
      expect(patch?.query).toBe('fieldManager=mate');
      expect(patch?.contentType).toBe('application/merge-patch+json');
      expect(patch?.body.metadata).toEqual({ resourceVersion: before });
      expect(stored()).toEqual(held({ blog: 'tok-blog', shop: 'tok-shop' }));
      expect(fake.files.get(FILE)).toBe('{}\n');
      expect(metrics.siteSyncs).toEqual(['ok', 'ok']);
      // No token reaches the log.
      expect(JSON.stringify(log.entries)).not.toContain('tok-shop');
    });

    test('a site removed during the turn leaves the ledger, and one claimed elsewhere stays', async () => {
      turning();
      fake.putSecret(SECRET, {
        'sites.json': serialize(held({ blog: 'tok-blog', old: 'tok-old' })),
      });
      fake.script = { chunks: ['one', 'two'], chunkDelayMs: 80 };
      const ref = await sandboxes.mint(THREAD);
      const session = await sandboxes.attach(ref);
      const turn = sandboxes.prompt(session, 'kthx rm old', new Collect());
      await until(() => stamps().length === 1);
      await Bun.sleep(20);
      // The agent ran `kthx rm old`; another thread claimed `shop` meanwhile.
      fake.files.set(FILE, serialize(held({ blog: 'tok-blog' })));
      fake.putSecret(SECRET, {
        'sites.json': serialize(
          held({ blog: 'tok-blog', old: 'tok-old', shop: 'tok-shop' }),
        ),
      });
      await turn;

      expect(stored()).toEqual(held({ blog: 'tok-blog', shop: 'tok-shop' }));
    });

    test('a save that lands on a moved Secret is folded again', async () => {
      turning();
      fake.putSecret(SECRET, {
        'sites.json': serialize(held({ blog: 'tok-blog' })),
      });
      fake.script = { chunks: ['one', 'two'], chunkDelayMs: 80 };
      const ref = await sandboxes.mint(THREAD);
      const session = await sandboxes.attach(ref);
      const turn = sandboxes.prompt(session, 'claim a site', new Collect());
      await until(() => stamps().length === 1);
      await Bun.sleep(20);
      fake.files.set(
        FILE,
        serialize(held({ blog: 'tok-blog', shop: 'tok-shop' })),
      );
      fake.secretMovesAfterRead = 1;
      await turn;

      expect(secretPatches()).toHaveLength(2);
      expect(
        log.of('kthx sites ledger moved under a save; retrying'),
      ).toHaveLength(1);
      expect(stored()).toEqual(held({ blog: 'tok-blog', shop: 'tok-shop' }));
      expect(fake.files.get(FILE)).toBe('{}\n');
      expect(metrics.siteSyncs).toEqual(['ok', 'ok']);
    });

    test('a failed save leaves the file for the next turn, which heals it', async () => {
      turning();
      fake.putSecret(SECRET, {
        'sites.json': serialize(held({ blog: 'tok-blog' })),
      });
      fake.secretPatchFails = true;
      const claimed = serialize(held({ blog: 'tok-blog', shop: 'tok-shop' }));
      const { ref, result } = await turnLeaving(claimed);
      expect(result.stopReason).toBe('end_turn');

      // Not truncated: the file is the only copy of the new bearer.
      expect(fake.files.get(FILE)).toBe(claimed);
      expect(stored()).toEqual(held({ blog: 'tok-blog' }));
      expect(metrics.siteSyncs).toEqual(['ok', 'save-failed']);
      expect(
        log.of('could not save the sandbox kthx sites into the ledger'),
      ).toHaveLength(1);
      // The other credentials were still cleared.
      expect(stamps()[1]?.command[4]).toBe('');

      // The next turn's start folds the file in before stamping.
      fake.secretPatchFails = false;
      fake.script = {};
      const session = await sandboxes.attach(ref);
      await sandboxes.prompt(session, 'again', new Collect());
      expect(stored()).toEqual(held({ blog: 'tok-blog', shop: 'tok-shop' }));
      expect(parseSites(stamps()[2]?.command[8] ?? '')).toEqual(
        held({ blog: 'tok-blog', shop: 'tok-shop' }),
      );
      expect(metrics.siteSyncs).toEqual(['ok', 'save-failed', 'ok', 'ok']);
    });

    test('a second turn that claims nothing keeps every site the first one did', async () => {
      turning();
      fake.putSecret(SECRET, { 'sites.json': serialize(held({})) });
      const { ref } = await turnLeaving(serialize(held({ blog: 'tok-blog' })));
      expect(stored()).toEqual(held({ blog: 'tok-blog' }));
      // Truncated at the end of the turn, so the file is empty when the next
      // one starts; an empty file is not a removal.
      expect(fake.files.get(FILE)).toBe('{}\n');

      fake.script = {};
      const session = await sandboxes.attach(ref);
      await sandboxes.prompt(session, 'again', new Collect());
      expect(stored()).toEqual(held({ blog: 'tok-blog' }));
      expect(parseSites(stamps()[2]?.command[8] ?? '')).toEqual(
        held({ blog: 'tok-blog' }),
      );
      expect(metrics.siteSyncs).toEqual(['ok', 'ok', 'ok', 'ok']);
    });

    test('a stamp that fails after the fold is never read as a removal', async () => {
      turning();
      fake.putSecret(SECRET, {
        'sites.json': serialize(held({ blog: 'tok-blog', shop: 'tok-shop' })),
      });
      fake.writeFails = 'exec did not open';
      const { result } = await turnLeaving(null);
      expect(result.stopReason).toBe('end_turn');

      // The file never held the ledger, so nothing in it is missing.
      expect(stored()).toEqual(held({ blog: 'tok-blog', shop: 'tok-shop' }));
      expect(secretPatches()).toEqual([]);
      expect(metrics.siteSyncs).toEqual(['ok', 'ok']);
    });

    test('a file over the limit is read-failed and never saved over', async () => {
      turning();
      fake.putSecret(SECRET, {
        'sites.json': serialize(held({ blog: 'tok-blog' })),
      });
      const huge = serialize(
        held({ blog: 'tok-blog', big: 'x'.repeat(70_000) }),
      );
      const { result } = await turnLeaving(huge);
      expect(result.stopReason).toBe('end_turn');

      expect(fake.files.get(FILE)).toBe(huge);
      expect(stored()).toEqual(held({ blog: 'tok-blog' }));
      expect(metrics.siteSyncs).toEqual(['ok', 'read-failed']);
      expect(
        String(
          log.of('could not read the sandbox kthx sites file')[0]?.fields
            ?.error,
        ),
      ).toContain('more than');
    });

    test('a corrupt file is left alone and never saved over', async () => {
      turning();
      fake.putSecret(SECRET, {
        'sites.json': serialize(held({ blog: 'tok-blog' })),
      });
      const { result } = await turnLeaving('{not json');
      expect(result.stopReason).toBe('end_turn');

      expect(fake.files.get(FILE)).toBe('{not json');
      expect(secretPatches()).toEqual([]);
      expect(metrics.siteSyncs).toEqual(['ok', 'read-failed']);
      expect(log.of('could not read the sandbox kthx sites file')).toHaveLength(
        1,
      );
    });

    test('a missing Secret is logged and the turn still answers', async () => {
      turning();
      const { result } = await turnLeaving(null);
      expect(result.stopReason).toBe('end_turn');
      // Nothing to stamp, so the file is not written at all.
      expect(fake.files.has(FILE)).toBe(false);
      expect(metrics.siteSyncs).toEqual(['save-failed', 'save-failed']);
      const [entry] = log.of(
        'could not save the sandbox kthx sites into the ledger',
      );
      expect(entry?.fields?.error).toContain('not found');
    });

    test('teardown keeps what the sandbox still holds', async () => {
      turning();
      fake.putSecret(SECRET, {
        'sites.json': serialize(held({ blog: 'tok-blog' })),
      });
      fake.secretPatchFails = true;
      const { ref } = await turnLeaving(
        serialize(held({ blog: 'tok-blog', shop: 'tok-shop' })),
      );
      fake.secretPatchFails = false;

      await sandboxes.teardown(ref);
      expect(fake.sandboxes.has(NAME)).toBe(false);
      expect(stored()).toEqual(held({ blog: 'tok-blog', shop: 'tok-shop' }));
      expect(metrics.siteSyncs.at(-1)).toBe('ok');
    });

    test('a teardown of something already gone is still not an error', async () => {
      turning();
      await sandboxes.teardown({ name: NAME, thread: THREAD });
      expect(log.entries.filter((e) => e.level !== 'info')).toEqual([]);
      expect(metrics.siteSyncs).toEqual([]);
    });
  });

  test('caps and redacts what the harness prints', async () => {
    fake.script = { stderr: 'auth failed: sk-abcd1234efgh5678ijklmnop\n' };
    const ref = await sandboxes.mint(THREAD);
    await sandboxes.attach(ref);
    await Bun.sleep(20);

    const line = log.of('harness stderr')[0]?.fields?.line as string;
    expect(line).toContain('auth failed');
    expect(line).not.toContain('sk-abcd1234efgh5678ijklmnop');
    expect(line).toContain('[redacted]');
  });

  test('ignores a pod it does not own', async () => {
    const ref = await sandboxes.mint(THREAD);
    fake.pods.delete(NAME);
    fake.pods.set('someone-elses', {
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
    expect(sandboxes.attach(ref)).rejects.toThrow(/no running pod/);
  });
});

describe('prompt', () => {
  test('streams the harness into the sink and slides the TTL', async () => {
    fake.script = {
      chunks: ['AGENTS', '.md:24'],
      thinking: true,
      tool: 'read AGENTS.md',
      cost: 0.0024,
    };
    const ref = await sandboxes.mint(THREAD);
    const minted = (fake.sandboxes.get(NAME) as Record<string, any>).spec
      .shutdownTime;
    const session = await sandboxes.attach(ref);
    const sink = new Collect();

    const result = await sandboxes.prompt(session, 'where is the rule?', sink);
    expect(result.stopReason).toBe('end_turn');
    expect(sink.text).toBe('AGENTS.md:24');
    expect(sink.status).toContain('read AGENTS.md…');
    expect(sink.status.at(-1)).toBeNull();
    // Cards keep the harness's call id, and a status-only update keeps the title.
    expect(sink.cards).toEqual([
      { id: 'call-1', title: 'read AGENTS.md', state: 'in_progress' },
      { id: 'call-1', title: 'read AGENTS.md', state: 'complete' },
    ]);

    expect(log.of('turn ended')[0]?.fields?.cost).toEqual({
      amount: 0.0024,
      currency: 'USD',
    });

    const slide = fake.patches.at(-1);
    expect(slide?.contentType).toBe('application/merge-patch+json');
    expect(Object.keys((slide?.body.spec ?? {}) as object)).toEqual([
      'shutdownTime',
    ]);

    // A merge patch on one field leaves the rest of the declaration alone.
    const after = fake.sandboxes.get(NAME) as Record<string, any>;
    expect(Date.parse(after.spec.shutdownTime)).toBeGreaterThan(
      Date.parse(minted),
    );
    expect(after.spec.shutdownPolicy).toBe('Delete');
    expect(after.spec.podTemplate.spec.runtimeClassName).toBe('kata-clh');
    expect(after.metadata.labels['lolwtf.ca/thread']).toBe(THREAD.id);
  });

  test('reassembles updates split across frames', async () => {
    fake.script = { chunks: ['split ', 'across ', 'frames'], splitLines: true };
    const ref = await sandboxes.mint(THREAD);
    const session = await sandboxes.attach(ref);
    const sink = new Collect();
    await sandboxes.prompt(session, 'anything', sink);
    expect(sink.text).toBe('split across frames');
  });

  test('a stop ends the turn as cancelled', async () => {
    fake.script = {
      chunks: ['one ', 'two ', 'three ', 'four ', 'five '],
      chunkDelayMs: 40,
    };
    const ref = await sandboxes.mint(THREAD);
    const session = await sandboxes.attach(ref);
    const sink = new Collect();
    const turn = sandboxes.prompt(session, 'count', sink);
    await Bun.sleep(60);
    await sandboxes.cancel(session);
    expect((await turn).stopReason).toBe('cancelled');
  });

  test('a stop for a session the harness no longer holds is ignored', async () => {
    const ref = await sandboxes.mint(THREAD);
    const stale = await sandboxes.attach(ref);
    fake.script = {
      chunks: ['one ', 'two ', 'three '],
      chunkDelayMs: 40,
      loadFails: true,
    };
    const fresh = await sandboxes.attach(ref);
    expect(fresh.id).not.toBe(stale.id);

    const turn = sandboxes.prompt(fresh, 'count', new Collect());
    await Bun.sleep(60);
    await sandboxes.cancel(stale);
    expect((await turn).stopReason).toBe('end_turn');
    expect(fake.lastExec?.stdin.some((l) => l.includes('session/cancel'))).toBe(
      false,
    );
  });

  test('a harness that dies mid-turn surfaces the close status', async () => {
    fake.script = {
      chunks: ['starting'],
      closeAfterChunk: 1,
      closeStatus: {
        status: 'Failure',
        reason: 'NonZeroExitCode',
        message: 'command terminated with exit code 137',
      },
    };
    const ref = await sandboxes.mint(THREAD);
    const session = await sandboxes.attach(ref);
    expect(sandboxes.prompt(session, 'count', new Collect())).rejects.toThrow(
      /exit code 137/,
    );
  });

  test('refuses a session that is not attached', async () => {
    const ref = await sandboxes.mint(THREAD);
    expect(
      sandboxes.prompt(
        { id: 'stale', sandbox: ref, resumed: false },
        'hi',
        new Collect(),
      ),
    ).rejects.toThrow(/not attached/);
  });
});

describe('teardown and list', () => {
  test('deletes the sandbox and waits for it to be gone', async () => {
    const ref = await attach();
    await sandboxes.teardown(ref);
    expect(fake.sandboxes.has(NAME)).toBe(false);
    expect(fake.pods.has(NAME)).toBe(false);
    expect(fake.lastExec?.clientClosed).toBe(true);
  });

  test('a teardown of something already gone is not an error', async () => {
    await sandboxes.teardown({ name: NAME, thread: THREAD });
    expect(fake.sandboxes.size).toBe(0);
  });

  test('lists only this guild s own sandboxes, thread and channel included', async () => {
    await sandboxes.mint(THREAD);
    const other = new KubeSandboxes({
      kube: new Kube(fake.config()),
      config,
      guildId: '1509024936717455999',
      log,
    });
    await other.mint({
      surface: 'discord',
      id: '1509024937422356888',
      channelId: 'c2',
    });

    const mine = await sandboxes.list();
    expect(mine).toEqual([{ name: NAME, thread: THREAD, turnInFlight: false }]);
  });

  test('skips a sandbox with no thread labels', async () => {
    await sandboxes.mint(THREAD);
    const stray = fake.sandboxes.get(NAME) as Record<string, any>;
    fake.sandboxes.set('mate-stray', {
      ...structuredClone(stray),
      metadata: {
        name: 'mate-stray',
        labels: {
          'lolwtf.ca/minted-by': 'mate',
          'lolwtf.ca/guild': GUILD,
        },
      },
    });
    expect(await sandboxes.list()).toEqual([
      { name: NAME, thread: THREAD, turnInFlight: false },
    ]);
    expect(log.of('sandbox has no thread labels; ignoring it')).toHaveLength(1);
  });
});

describe('the warm pool', () => {
  test('warms a sandbox that belongs to no thread', async () => {
    const pool = withSpares(1);
    await pool.ensureSpares();

    const [name] = spareNames();
    expect(name).toMatch(/^mate-spare-/);
    const spare = fake.sandboxes.get(name ?? '') as Record<string, any>;
    expect(spare.metadata.labels).toEqual({
      'app.kubernetes.io/name': 'mate-sandbox',
      'app.kubernetes.io/part-of': 'mate',
      'lolwtf.ca/minted-by': 'mate',
      'lolwtf.ca/guild': GUILD,
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

    // Rehydration skips it, without the stray-sandbox warning.
    expect(await pool.list()).toEqual([]);
    expect(log.of('sandbox has no thread labels; ignoring it')).toHaveLength(0);

    await pool.ensureSpares();
    expect(spareNames()).toHaveLength(1);
  });

  test('a thread takes the spare, and the spare takes its labels', async () => {
    const pool = withSpares(1);
    await pool.ensureSpares();
    const [name] = spareNames();

    const ref = await pool.mint(THREAD);
    expect(ref).toEqual({ name: name ?? '', thread: THREAD, source: 'spare' });

    const adopted = fake.sandboxes.get(ref.name) as Record<string, any>;
    expect(adopted.metadata.labels['lolwtf.ca/thread']).toBe(THREAD.id);
    expect(adopted.metadata.labels['lolwtf.ca/channel']).toBe(THREAD.channelId);
    expect(adopted.metadata.labels['lolwtf.ca/surface']).toBe('discord');
    expect(adopted.metadata.labels['lolwtf.ca/spare']).toBeUndefined();
    // The claiming patch also sets a thread's TTL.
    expect(Date.parse(adopted.spec.shutdownTime) - Date.now()).toBeGreaterThan(
      110 * 60_000,
    );
    // The spare's clone is as old as the spare, so it is fetched forward first.
    expect(fake.lastExec?.container).toBe(HARNESS_CONTAINER);
    // The ref is passed as `$1`, never spliced into the script.
    expect(fake.lastExec?.command).toEqual([
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
    // Listed as a thread despite its `mate-spare-` name.
    expect(await pool.list()).toEqual([
      { name: ref.name, thread: THREAD, turnInFlight: false },
    ]);
    await until(() => spareNames().length === 1);
  });

  test('a second thread cannot take the spare the first one took', async () => {
    const pool = withSpares(1);
    await pool.ensureSpares();
    const [spare] = spareNames();

    const [first, second] = await Promise.all([
      pool.mint(THREAD),
      pool.mint(OTHER_THREAD),
    ]);
    expect(first.name).not.toBe(second.name);
    expect([first, second].filter((ref) => ref.name === spare)).toHaveLength(1);
    const loser = first.name === spare ? second : first;
    expect(loser.name).toBe(sandboxName(loser.thread));
    expect(loser.source).toBe('fresh');
  });

  test('the thread is found again by its label, not by a name it no longer has', async () => {
    const pool = withSpares(1);
    await pool.ensureSpares();
    const first = await pool.mint(THREAD);

    const again = await pool.mint(THREAD);
    expect(again.name).toBe(first.name);
    expect(again.source).toBe('reused');
    expect(log.of('sandbox already existed')).toHaveLength(1);
    expect(fake.sandboxes.has(sandboxName(THREAD))).toBe(false);
  });

  test('with no pool configured a mint is exactly what it was', async () => {
    await sandboxes.ensureSpares();
    expect(fake.requests).toEqual([]);

    const ref = await sandboxes.mint(THREAD);
    expect(ref).toEqual({ name: NAME, thread: THREAD, source: 'fresh' });
    expect([...fake.sandboxes.keys()]).toEqual([NAME]);
    // Each extra request is one more way for a mint to fail.
    expect(
      fake.requests.map((r) => `${r.method} ${r.query || r.path}`),
    ).toEqual([
      `GET labelSelector=${threadQuery}`,
      'POST /apis/agents.x-k8s.io/v1beta1/namespaces/mate/sandboxes',
      `GET fieldSelector=metadata.name%3D${NAME}`,
    ]);
  });

  test('renews what it holds, and only what still is one', async () => {
    const pool = withSpares(1);
    await pool.ensureSpares();
    const [name] = spareNames();
    const spare = fake.sandboxes.get(name ?? '') as Record<string, any>;
    const first = Date.parse(spare.spec.shutdownTime);

    await Bun.sleep(10);
    await pool.ensureSpares();
    expect(Date.parse(spare.spec.shutdownTime)).toBeGreaterThan(first);
    // The resourceVersion stops a stale renewal overwriting a claimed spare's TTL.
    const slide = fake.patches.filter((p) => p.name === name).at(-1);
    const meta = (slide?.body.metadata ?? {}) as Record<string, unknown>;
    expect(meta.resourceVersion).toBeDefined();
  });

  test('a call that lands mid-pass gets a pass of its own', async () => {
    const pool = withSpares(1);
    fake.readyOnCreate = false;
    const first = pool.ensureSpares();
    await until(() => spareNames().length === 1);

    // Joining the pass in flight would report the pool as counted before this call.
    const second = pool.ensureSpares();
    fake.markReady(spareNames()[0] ?? '');
    await Promise.all([first, second]);

    // Only the second pass had a spare to renew.
    expect(
      fake.patches.filter((p) => p.name.startsWith('mate-spare-')),
    ).toHaveLength(1);
  });

  test('keeps none of the spares an earlier mate left behind', async () => {
    const before = withSpares(1);
    await before.ensureSpares();
    const [inherited] = spareNames();

    // Nothing on a spare records the image, model or ref it was built from.
    const after = withSpares(1);
    await after.ensureSpares();
    await until(() => !fake.sandboxes.has(inherited ?? ''));
    expect(spareNames()).toHaveLength(1);
    expect(spareNames()[0]).not.toBe(inherited);
  });

  test('will not hand out a spare whose pod has gone', async () => {
    const pool = withSpares(1);
    await pool.ensureSpares();
    const [name] = spareNames();
    fake.markNotReady(name ?? '');

    const ref = await pool.mint(THREAD);
    expect(ref.name).toBe(NAME);
    expect(ref.source).toBe('fresh');
  });

  test('replaces a spare that stopped being ready', async () => {
    const pool = withSpares(1);
    await pool.ensureSpares();
    const [broken] = spareNames();
    const object = fake.sandboxes.get(broken ?? '') as Record<string, any>;
    const held = Date.parse(object.spec.shutdownTime);
    fake.markNotReady(broken ?? '');

    await pool.ensureSpares();
    // Not renewed: the TTL is the only thing that removes an unusable spare.
    expect(Date.parse(object.spec.shutdownTime)).toBe(held);
    await until(() => !fake.sandboxes.has(broken ?? ''));
    expect(log.of('condemned a spare that stopped being ready')).toHaveLength(
      1,
    );
    // The resourceVersion stops a condemn landing on a spare a thread just claimed.
    const took = fake.patches.filter((patch) => patch.name === broken).at(0);
    const meta = (took?.body.metadata ?? {}) as Record<string, unknown>;
    expect(meta.resourceVersion).toBeDefined();

    const standing = spareNames();
    expect(standing).toHaveLength(1);
    expect(standing[0]).not.toBe(broken);
    expect((await pool.mint(THREAD)).source).toBe('spare');
  });

  test('reports what the pool holds against what it is for', async () => {
    const pool = withSpares(1);
    await pool.ensureSpares();
    expect(metrics.pool).toEqual({ ready: 1, wanted: 1 });

    const [broken] = spareNames();
    fake.markNotReady(broken ?? '');
    fake.patchFails = true;
    await pool.ensureSpares();
    // One sandbox held, none usable: only this gauge shows a pool that stopped working.
    expect(metrics.pool).toEqual({ ready: 0, wanted: 1 });
  });

  test('a spare it could not take out is not joined by a replacement', async () => {
    const pool = withSpares(1);
    await pool.ensureSpares();
    const [broken] = spareNames();
    fake.markNotReady(broken ?? '');
    fake.patchFails = true;

    await pool.ensureSpares();
    // It still holds node room, so a replacement would push the pool past its size.
    expect(spareNames()).toEqual([broken ?? '']);
    expect(
      log.of('could not condemn a spare that stopped being ready'),
    ).toHaveLength(1);
  });

  test('a refresh that fails takes the spare out rather than the thread', async () => {
    const pool = withSpares(1);
    await pool.ensureSpares();
    const [spare] = spareNames();
    fake.commandFails = 'fatal: could not read from remote repository';

    const ref = await pool.mint(THREAD);
    // A spare is only worth handing out with a current checkout.
    expect(ref).toEqual({ name: NAME, thread: THREAD, source: 'fresh' });
    expect(
      log.of('could not bring an adopted spare up to date; minting one'),
    ).toHaveLength(1);
    await until(() => !fake.sandboxes.has(spare ?? ''));
  });

  test('a spare that cannot be deleted still stops being the thread', async () => {
    const pool = withSpares(1);
    await pool.ensureSpares();
    const [spare] = spareNames();
    fake.commandFails = 'fatal: could not read from remote repository';
    fake.deleteFails = true;

    await pool.mint(THREAD);
    // A failed delete must not leave a second object carrying the thread's labels.
    const wearing = [...fake.sandboxes.entries()]
      .filter(([, o]: any) => o.metadata.labels['lolwtf.ca/thread'])
      .map(([name]) => name);
    expect(wearing).toEqual([NAME]);
    const condemned = fake.sandboxes.get(spare ?? '') as Record<string, any>;
    expect(condemned.metadata.labels['lolwtf.ca/spare']).toBe('condemned');
    expect(await pool.list()).toEqual([
      { name: NAME, thread: THREAD, turnInFlight: false },
    ]);
  });

  test('a thread whose sandbox is terminating gets a new one, not a refusal', async () => {
    const pool = withSpares(1);
    await pool.ensureSpares();
    const adopted = await pool.mint(THREAD);
    await until(() => spareNames().length === 1);
    fake.terminating(adopted.name);

    // Still labelled for the thread but terminating; `reuse` would fail on it.
    const again = await pool.mint(THREAD);
    expect(again.name).not.toBe(adopted.name);
    expect(again.source).toBe('spare');
  });
});

describe('the turn mark', () => {
  test('is on the object while a turn runs and gone when it ends', async () => {
    fake.script = { chunks: ['one', 'two'], chunkDelayMs: 60 };
    const ref = await sandboxes.mint(THREAD);
    const session = await sandboxes.attach(ref);

    const turn = sandboxes.prompt(session, 'go', new Collect());
    await Bun.sleep(30);
    expect((await sandboxes.list())[0]?.turnInFlight).toBe(true);

    await turn;
    expect((await sandboxes.list())[0]?.turnInFlight).toBe(false);
    const object = fake.sandboxes.get(NAME) as Record<string, any>;
    expect(object.metadata.annotations[TURN_ANNOTATION]).toBeUndefined();
  });

  test('takes the sandbox with it, so a long turn is not reaped mid-answer', async () => {
    fake.script = { chunks: ['one', 'two'], chunkDelayMs: 60 };
    const ref = await sandboxes.mint(THREAD);
    const session = await sandboxes.attach(ref);

    await Bun.sleep(5);
    const started = Date.now();
    const turn = sandboxes.prompt(session, 'go', new Collect());
    await Bun.sleep(30);
    // A full TTL from the turn's start, which the attach-time deadline, 5 ms older, cannot meet.
    expect(shutdownTime()).toBeGreaterThanOrEqual(started + TTL_MS);
    await turn;
  });

  test('a turn nothing ever finished stays marked for the next mate', async () => {
    fake.script = { chunks: ['starting'], closeAfterChunk: 1 };
    const ref = await sandboxes.mint(THREAD);
    const session = await sandboxes.attach(ref);

    await sandboxes.prompt(session, 'go', new Collect()).catch(() => {});
    expect((await sandboxes.list())[0]?.turnInFlight).toBe(true);
  });

  test('attach says whether the harness reloaded the session', async () => {
    const ref = await sandboxes.mint(THREAD);
    expect((await sandboxes.attach(ref)).resumed).toBe(false);
    expect((await sandboxes.attach(ref)).resumed).toBe(true);

    fake.script = { loadFails: true };
    expect((await sandboxes.attach(ref)).resumed).toBe(false);
  });
});

describe('what a turn cost', () => {
  test('is the step in the session total, not the total', async () => {
    fake.script = { costs: [0.0024, 0.006] };
    const ref = await sandboxes.mint(THREAD);
    const session = await sandboxes.attach(ref);

    const first = await sandboxes.prompt(session, 'one', new Collect());
    const second = await sandboxes.prompt(session, 'two', new Collect());
    expect(first.costUsd).toBeCloseTo(0.0024, 6);
    expect(second.costUsd).toBeCloseTo(0.0036, 6);
  });

  test('is nothing for the first turn of a session the harness reloaded', async () => {
    fake.script = { costs: [0.0024, 0.006] };
    const ref = await sandboxes.mint(THREAD);
    await sandboxes.attach(ref);
    const resumed = await sandboxes.attach(ref);
    expect(resumed.resumed).toBe(true);

    const first = await sandboxes.prompt(resumed, 'one', new Collect());
    const second = await sandboxes.prompt(resumed, 'two', new Collect());
    expect(first.costUsd).toBeNull();
    expect(second.costUsd).toBeCloseTo(0.0036, 6);
  });
});
