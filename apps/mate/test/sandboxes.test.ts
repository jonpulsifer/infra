/**
 * The sandbox side against a fake apiserver: what mate stamps, how it waits,
 * how it attaches and prompts, what it patches, and what it deletes.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SandboxConfig } from '../src/config.ts';
import { Kube } from '../src/kube.ts';
import type { PromptSink, SandboxRef, Update } from '../src/sandbox.ts';
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
import { RecordingLog } from './support.ts';

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
  credentials: {
    connectHost:
      'http://onepassword-connect.external-secrets.svc.cluster.local:8080',
    connectSecret: 'mate-onepassword',
    githubTokenRef: 'op://a-vault/an-item/password',
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
let sandboxes: KubeSandboxes;

beforeEach(() => {
  fake = new FakeKube();
  log = new RecordingLog();
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
 * A directory to put first on PATH, holding a stand-in `op` with the body
 * given and a stand-in `timeout` that records the bound it was handed and then
 * execs what it was handed. Both leave a marker behind, so a test can ask
 * whether the helper reached them at all.
 */
function fakeOp(body: string) {
  const dir = mkdtempSync(join(tmpdir(), 'mate-op-'));
  writeFileSync(join(dir, 'op'), `#!/bin/sh\n: >'${dir}/op.ran'\n${body}\n`, {
    mode: 0o755,
  });
  writeFileSync(
    join(dir, 'timeout'),
    `#!/bin/sh\nprintf %s "$1" >'${dir}/timeout.bound'\nshift\nexec "$@"\n`,
    { mode: 0o755 },
  );
  return dir;
}

/**
 * `git credential <operation>` under the harness container's own environment,
 * with `bin` first on PATH. No user or system config is in reach, which is the
 * sandbox's shape rather than a convenience: the image writes no
 * `/etc/gitconfig` and the pod backs HOME with an empty emptyDir, so the
 * environment below is every helper git can find.
 */
function credential(
  bin: string,
  operation: 'fill' | 'approve' | 'reject',
  host: string,
  global = '/dev/null',
) {
  const env: Record<string, string> = {
    PATH: `${bin}:${process.env.PATH}`,
    GIT_CONFIG_GLOBAL: global,
    GIT_CONFIG_SYSTEM: '/dev/null',
  };
  for (const entry of podTemplate().containers[0].env as {
    name: string;
    value?: string;
  }[]) {
    if (entry.value !== undefined) env[entry.name] = entry.value;
  }
  // `approve` and `reject` are given a credential to act on, the way git hands
  // back what a fill returned. A fill is given none, or git answers it from
  // stdin without asking a helper at all.
  const answer =
    operation === 'fill' ? '' : 'username=rowbutt\npassword=a-pat\n';
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

/** The same mate, with a pool of one behind it. */
function withSpares(spares: number): KubeSandboxes {
  return new KubeSandboxes({
    kube: new Kube(fake.config()),
    config: { ...config, spares },
    guildId: GUILD,
    log,
    readyTimeoutMs: 4000,
    goneTimeoutMs: 4000,
  });
}

/** Unclaimed: the marker, not the name, is what still makes one a spare. */
function spareNames(): string[] {
  return [...fake.sandboxes.entries()]
    .filter(([, object]) => (object.metadata as any).labels['lolwtf.ca/spare'])
    .map(([name]) => name);
}

/** What a fire-and-forget replacement needs: a wait with a reason to stop. */
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
    // The clone runs as the harness uid so every file it writes is the
    // agent's; the mount root above them is settled by the git env instead.
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

  // Nothing else in the repo names AGENTS.md, so a rename would strand every
  // sandbox on a path that no longer exists.
  test('names an instruction file the checkout really has', async () => {
    const root = new URL('../../../AGENTS.md', import.meta.url);
    expect(await Bun.file(root).exists()).toBe(true);
  });

  // The same trap one directory over, and quieter: opencode reports neither a
  // skills path that is missing nor one that holds no skill, so a move would
  // take the agent back to the eight under `.agents/skills/` in silence.
  test('names a skills directory that really holds skills', async () => {
    const dir = new URL('../../../dotfiles/skills/', import.meta.url);
    const skills = [...new Bun.Glob('*/SKILL.md').scanSync(dir.pathname)];
    expect(skills.length).toBeGreaterThan(0);
  });

  // The sandbox image's mise config turns off tool management by naming every
  // tool, because mise has no wildcard for it. That list is a copy, and a tool
  // added to the repo's mise.toml without being added here is a tool mise
  // tries to resolve on every `mise run` — offline, that fails the run
  // outright, and the agent loses the task list AGENTS.md sends it to.
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

    // fsGroup leaves the emptyDir root uid 0 and git checks the worktree root,
    // so without safe.directory the clone lands and every command after it
    // dies of dubious ownership: opencode stops seeing a repository and the
    // agent's own git calls fail. The ident is the other half — the image's
    // agent user has none, so `git commit` would refuse to write one.
    for (const container of [pod.initContainers[0], pod.containers[0]]) {
      const env = envOf(container);
      expect(env.GIT_CONFIG_KEY_0.value).toBe('safe.directory');
      expect(env.GIT_CONFIG_VALUE_0.value).toBe(WORKSPACE);
      expect(env.GIT_CONFIG_KEY_1.value).toBe('user.name');
      expect(env.GIT_CONFIG_VALUE_1.value).toBe('rowbutt');
      expect(env.GIT_CONFIG_KEY_2.value).toBe('user.email');
      expect(env.GIT_CONFIG_VALUE_2.value).toBe(
        '22780844+rowbutt@users.noreply.github.com',
      );
    }
    // The checkout gets the ident and nothing else.
    const checkout = envOf(pod.initContainers[0]);
    expect(checkout.GIT_CONFIG_COUNT.value).toBe('3');
    expect(checkout.OP_CONNECT_TOKEN).toBeUndefined();
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
    expect(env.MATE_GITHUB_TOKEN_REF.value).toBe(
      'op://a-vault/an-item/password',
    );
    // Never both authentication paths.
    expect(env.OP_SERVICE_ACCOUNT_TOKEN).toBeUndefined();
    // Whether an unanswered credential blocks otherwise depends on whether the
    // agent's tool gave the command a terminal.
    expect(env.GIT_TERMINAL_PROMPT.value).toBe('0');
  });

  // The helper is a shell snippet git runs, so the only proof it is the right
  // shape is git running it. Everything below the fake `op` is what
  // `sandboxManifest` stamped, handed to git as the kubelet would hand it to
  // the container.
  test('git fills a github.com credential with what op printed', async () => {
    await sandboxes.mint(THREAD);
    const dir = fakeOp('echo "a-pat-for($3)"');

    const filled = credential(dir, 'fill', 'github.com');
    expect(filled.stdout.toString()).toContain('username=rowbutt');
    expect(filled.stdout.toString()).toContain(
      'password=a-pat-for(op://a-vault/an-item/password)',
    );

    // Scoped to the one URL: no other host reaches this helper.
    const other = credential(dir, 'fill', 'gitlab.com');
    expect(other.exitCode).not.toBe(0);
    expect(other.stdout.toString()).not.toContain('password=');

    // The reset earns its line, proven by a decoy that wins without it.
    const decoy = join(dir, 'decoy.gitconfig');
    writeFileSync(
      decoy,
      '[credential]\n\thelper = "!echo username=somebody; echo password=not-the-pat"\n',
    );
    const contested = credential(dir, 'fill', 'github.com', decoy);
    expect(contested.stdout.toString()).toContain('username=rowbutt');
  });

  // Both halves are about not hanging: a whole turn is what a stalled fill
  // costs, and with MATE_MAX_CONCURRENT at 2 that is half the capacity.
  test('a read that cannot answer fails the fill rather than stalling it', async () => {
    await sandboxes.mint(THREAD);

    const broken = fakeOp('exit 1');
    const failed = credential(broken, 'fill', 'github.com');
    expect(failed.exitCode).not.toBe(0);
    expect(failed.stdout.toString()).not.toContain('password=');

    // What this pins is that `op` is reached through a bound at all. That a
    // bound which expires kills the child is coreutils' business, so no test
    // here waits for one to fire.
    const slow = fakeOp('echo a-pat');
    expect(credential(slow, 'fill', 'github.com').exitCode).toBe(0);
    const bound = Number(readFileSync(join(slow, 'timeout.bound'), 'utf8'));
    expect(bound).toBeGreaterThan(0);
  });

  // `approve` and `reject` are git's names for the store and erase paths.
  test('storing and erasing a credential never reach op', async () => {
    await sandboxes.mint(THREAD);

    for (const operation of ['approve', 'reject'] as const) {
      const dir = fakeOp('echo a-pat');
      expect(credential(dir, operation, 'github.com').exitCode).toBe(0);
      expect(existsSync(join(dir, 'op.ran'))).toBe(false);
    }
  });

  // Only git consults a git credential helper, so the sandbox image puts a
  // wrapper on PATH in front of gh that resolves the same reference. That
  // wrapper spells the variable's name in a shell script two directories away,
  // and this is the only thing joining the two: renaming the constant here
  // leaves it reading something unset, exec'ing gh with no token, and meeting
  // `gh pr create` with gh's own login instructions one step short of the
  // pull request.
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

    // That wrapper is the whole of how gh gets a token, which is the point:
    // what the pod holds is a reference and the means to read it, never a
    // credential that outlives the command asking for one.
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
  });

  test('hands the harness no credential path when none is configured', async () => {
    sandboxes = new KubeSandboxes({
      kube: new Kube(fake.config()),
      config: { ...config, credentials: null },
      guildId: GUILD,
      log,
    });
    await sandboxes.mint(THREAD);
    const env = envOf(podTemplate().containers[0]);

    expect(env.GIT_CONFIG_COUNT.value).toBe('3');
    expect(env.OP_CONNECT_HOST).toBeUndefined();
    expect(env.OP_CONNECT_TOKEN).toBeUndefined();
    expect(env.MATE_GITHUB_TOKEN_REF).toBeUndefined();
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
    // The same news the status line carries, said again as the call itself:
    // a surface with cards of its own keeps the harness's id and follows it
    // to its end, and an update naming only a status keeps the title.
    expect(sink.cards).toEqual([
      { id: 'call-1', title: 'read AGENTS.md', state: 'in_progress' },
      { id: 'call-1', title: 'read AGENTS.md', state: 'complete' },
    ]);

    // opencode is the harness that reports USD, and the turn summary carries it.
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
    // The label the network policy selects on is the first one above; without
    // it a spare would run the same image with the LAN in reach.
    expect(spare.spec.podTemplate.metadata.labels).toEqual(
      spare.metadata.labels,
    );
    // Its own short TTL, because nothing but the sweep renews a spare.
    const ttl = Date.parse(spare.spec.shutdownTime) - Date.now();
    expect(ttl).toBeGreaterThan(25 * 60_000);
    expect(ttl).toBeLessThanOrEqual(30 * 60_000);

    // Nobody's thread, so rehydration must not take it for one — and it is
    // not the stray the warning is about either.
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
    // A thread's TTL from the same patch that claimed it, rather than the
    // half hour it was warming on.
    expect(Date.parse(adopted.spec.shutdownTime) - Date.now()).toBeGreaterThan(
      110 * 60_000,
    );
    // The clone it came up with is as old as the spare, so the workspace is
    // brought forward before anything attaches to it.
    expect(fake.lastExec?.container).toBe(HARNESS_CONTAINER);
    // The ref is an argument to the shell rather than part of the script, so
    // a branch name is a branch name and not something `sh` gets a vote on.
    expect(fake.lastExec?.command).toEqual([
      '/bin/sh',
      '-c',
      `set -e; cd ${WORKSPACE}; git fetch --depth 1 origin "$1"; git reset --hard FETCH_HEAD`,
      'mate',
      'main',
    ]);
    // The pod template takes the same labels in the same patch: v1.0.3
    // propagates those onto a running pod, so a thread can still be found
    // from its pod and the object does not disagree with itself.
    expect(adopted.spec.podTemplate.metadata.labels).toEqual(
      adopted.metadata.labels,
    );
    // From here it is an ordinary thread, whatever it is called.
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
    // Whichever lost built its own, named after its thread as ever.
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
    // And it says which of the two standing sandboxes it got: the pool is
    // still holding one, and this is not that.
    expect(again.source).toBe('reused');
    expect(log.of('sandbox already existed')).toHaveLength(1);
    expect(fake.sandboxes.has(sandboxName(THREAD))).toBe(false);
  });

  test('with no pool configured a mint is exactly what it was', async () => {
    await sandboxes.ensureSpares();
    // Not one request: a mate nobody configured a pool for should not be
    // asking the apiserver about one, on a timer or on a mint.
    expect(fake.requests).toEqual([]);

    const ref = await sandboxes.mint(THREAD);
    expect(ref).toEqual({ name: NAME, thread: THREAD, source: 'fresh' });
    expect([...fake.sandboxes.keys()]).toEqual([NAME]);
    // Objects are the easy half. The request shape is the claim: a mint that
    // asks one question more than it did is a mint with one more way to fail.
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
    // Nothing else slides a spare, so a pass that stopped renewing would hand
    // every spare back to the controller half an hour later in silence.
    expect(Date.parse(spare.spec.shutdownTime)).toBeGreaterThan(first);
    // Carried for the same reason adoption carries one: a sweep that listed a
    // spare microseconds before a thread took it must not write a spare's
    // half hour back over the thread's two hours.
    const slide = fake.patches.filter((p) => p.name === name).at(-1);
    const meta = (slide?.body.metadata ?? {}) as Record<string, unknown>;
    expect(meta.resourceVersion).toBeDefined();
  });

  test('a call that lands mid-pass gets a pass of its own', async () => {
    const pool = withSpares(1);
    fake.readyOnCreate = false;
    const first = pool.ensureSpares();
    await until(() => spareNames().length === 1);

    // Joining the pass in flight would answer about the pool as it was
    // counted before this call — which is exactly the state a thread that
    // just took the last spare is asking about.
    const second = pool.ensureSpares();
    fake.markReady(spareNames()[0] ?? '');
    await Promise.all([first, second]);

    // The pass that followed had a spare to renew where the first found none.
    expect(
      fake.patches.filter((p) => p.name.startsWith('mate-spare-')),
    ).toHaveLength(1);
  });

  test('keeps none of the spares an earlier mate left behind', async () => {
    const before = withSpares(1);
    await before.ensureSpares();
    const [inherited] = spareNames();

    // A roll is how the sandbox image, the model and the ref change, and
    // nothing on a spare records which of them it was built from.
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

    // There is a spare, and it is no use: the thread builds its own.
    const ref = await pool.mint(THREAD);
    expect(ref.name).toBe(NAME);
    expect(ref.source).toBe('fresh');
  });

  test('a refresh that fails takes the spare out rather than the thread', async () => {
    const pool = withSpares(1);
    await pool.ensureSpares();
    const [spare] = spareNames();
    fake.commandFails = 'fatal: could not read from remote repository';

    const ref = await pool.mint(THREAD);
    // The slow path, because a current checkout is the thing a spare is only
    // worth having if it can be given.
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
    // The delete is what is wanted and the labels are what is load-bearing:
    // a teardown that does not land must not leave a second object the next
    // message could be handed instead of the one that was just built for it.
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

    // The object still carries the thread's labels, and it is on its way out:
    // what the thread wants is a sandbox, not the one it is waiting to lose,
    // which is the hard failure `reuse` would raise on being handed it.
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
    // A whole TTL measured from the turn's own start, which the deadline the
    // attach slide left behind — five milliseconds older — cannot satisfy.
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
