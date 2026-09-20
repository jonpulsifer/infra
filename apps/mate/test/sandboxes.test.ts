/**
 * The sandbox side against a fake apiserver: what mate stamps, how it waits,
 * how it attaches and prompts, what it patches, and what it deletes.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { SandboxConfig } from '../src/config.ts';
import { Kube } from '../src/kube.ts';
import type { PromptSink, SandboxRef, Update } from '../src/sandbox.ts';
import {
  HARNESS_CONTAINER,
  KubeSandboxes,
  SESSION_ANNOTATION,
  sandboxName,
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

const config: SandboxConfig = {
  image:
    'ghcr.io/jonpulsifer/mate-sandbox:latest@sha256:6f135be2df9ddf2cca529e845b3325cba5c6e72c8587c1ce48ec30bd5b10cbac',
  runtimeClass: 'kata-clh',
  namespace: 'mate',
  secret: 'mate-opencode',
  checkoutRepo: 'https://github.com/jonpulsifer/infra',
  checkoutRef: 'main',
  model: 'opencode-go/qwen3.8-flash',
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
    turnTimeoutMs: 4000,
  });
});

afterEach(() => {
  fake.stop();
});

function podTemplate(): Record<string, any> {
  const spec = fake.sandboxes.get(NAME)?.spec as Record<string, any>;
  return spec.podTemplate.spec;
}

function envOf(container: Record<string, any>): Record<string, any> {
  return Object.fromEntries(
    (container.env ?? []).map((e: Record<string, unknown>) => [e.name, e]),
  );
}

async function attach(): Promise<SandboxRef> {
  const ref = await sandboxes.mint(THREAD);
  await sandboxes.attach(ref);
  return ref;
}

describe('mint', () => {
  test('stamps the sandbox a thread gets', async () => {
    const ref = await sandboxes.mint(THREAD);
    expect(ref).toEqual({ name: NAME, thread: THREAD });

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
      '1',
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
      expect(env.GIT_CONFIG_COUNT.value).toBe('3');
      expect(env.GIT_CONFIG_KEY_0.value).toBe('safe.directory');
      expect(env.GIT_CONFIG_VALUE_0.value).toBe(WORKSPACE);
      expect(env.GIT_CONFIG_KEY_1.value).toBe('user.name');
      expect(env.GIT_CONFIG_VALUE_1.value).toBe('rowbutt');
      expect(env.GIT_CONFIG_KEY_2.value).toBe('user.email');
      expect(env.GIT_CONFIG_VALUE_2.value).toBe(
        '22780844+rowbutt@users.noreply.github.com',
      );
    }
  });

  test('waits for the controller to report Ready', async () => {
    fake.readyOnCreate = false;
    const minted = sandboxes.mint(THREAD);
    setTimeout(() => fake.markReady(NAME), 60);
    await minted;
    expect(fake.pods.has(NAME)).toBe(true);
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
