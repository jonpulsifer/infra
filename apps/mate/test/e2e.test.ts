/**
 * mate end to end: the whole process as `Mate` composes it, on pi-ai's faux
 * model, with its sessions in Postgres, its Discord listener on a fake
 * gateway, and its sandboxes on a fake apiserver whose pods run the real
 * mate-hands daemon.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Message } from '@earendil-works/pi-ai';
import {
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux';
import type { Server } from 'bun';
import type { McpServerConfig } from '../src/config.ts';
import { HANDS_BINARY } from '../src/hands.ts';
import { Epochs } from '../src/hands-env.ts';
import { serialize } from '../src/kthx-sites.ts';
import { Mate } from '../src/mate.ts';
import { HARNESS_FAILED, RESUMING, RUNS_AS } from '../src/notices.ts';
import {
  CHECKOUT_LABEL,
  sandboxName,
  sandboxNameFor,
} from '../src/sandboxes.ts';
import { PostgresThreadStore } from '../src/store.ts';
import { type ThreadRef, threadKey } from '../src/surface.ts';
import type { ThreadRow } from '../src/thread-store.ts';
import { withDatabase } from './db.ts';
import { FakeMcp } from './fake-mcp.ts';
import type { ExecRecord } from './fakeapi.ts';
import {
  alive,
  cleanUp,
  INVESTIGATOR,
  pidsIn,
  type Rig,
  rig,
  tempDir,
  until,
} from './hands-support.ts';
import {
  CHANNEL,
  type ConfigOverrides,
  DiscordDriver,
  eventually,
  fauxModel,
  ME,
  mateConfig,
  OWNER,
  RealClock,
  testDatabase,
} from './mate-support.ts';
import { toolText, transcript } from './stored.ts';
import {
  discordRef,
  FakeDiscord,
  RecordingInstruments,
  RecordingLog,
} from './support.ts';

const database = withDatabase();
const INTERRUPTED = 'was interrupted and may have partially run';
const TOKEN = 'kthx_agent_0123456789abcdef0123456789abcdef';
// Every e2e test runs real daemons, Postgres and several turns.
const SLOW = 30_000;

let snowflake = 1509024937422357000n;

/** Discord whose threads get snowflake ids, which a Sandbox's name is built from. */
class SnowflakeDiscord extends FakeDiscord {
  override async createThread(
    channelId: string,
    messageId: string,
    name: string,
  ): Promise<string> {
    snowflake += 1n;
    const id = String(snowflake);
    this.threads.push({ channelId, messageId, name, id });
    return id;
  }
}

/** GitHub's App endpoints, minting `ghs-token-<n>` and recording revokes. */
class FakeGitHub {
  minted = 0;
  readonly revoked: string[] = [];
  private readonly server: Server<never>;

  constructor() {
    const fake = this;
    this.server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        const { pathname } = new URL(request.url);
        if (request.method === 'GET' && pathname.endsWith('/installation')) {
          return Response.json({ id: 42, app_slug: 'clanky-bot' });
        }
        if (request.method === 'POST' && pathname.endsWith('/access_tokens')) {
          fake.minted += 1;
          return Response.json({
            token: `ghs-token-${fake.minted}`,
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          });
        }
        if (request.method === 'DELETE') {
          const bearer = request.headers.get('authorization') ?? '';
          fake.revoked.push(bearer.replace(/^Bearer /, ''));
          return new Response(null, { status: 204 });
        }
        return Response.json({ message: 'nope' }, { status: 418 });
      },
    });
  }

  get base(): string {
    return `http://127.0.0.1:${this.server.port}`;
  }

  stop(): void {
    this.server.stop(true);
  }
}

/** The App's id and key file, and the SSH key file, as mate's pod mounts them. */
function keys(): Pick<ConfigOverrides, 'githubApp' | 'sshKeyFile'> {
  const dir = tempDir('keys');
  const app = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  writeFileSync(join(dir, 'app.pem'), app.privateKey);
  const ssh = generateKeyPairSync('ed25519');
  writeFileSync(
    join(dir, 'ssh.pem'),
    ssh.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
  );
  return {
    githubApp: {
      appId: '5027196',
      keyFile: join(dir, 'app.pem'),
      owner: 'jonpulsifer',
      repo: 'infra',
    },
    sshKeyFile: join(dir, 'ssh.pem'),
  };
}

const tool = (
  name: string,
  args: Parameters<typeof fauxToolCall>[1],
  id: string,
) =>
  fauxAssistantMessage(fauxToolCall(name, args, { id }), {
    stopReason: 'toolUse',
  });

/** One mate process over a shared cluster and database. */
interface Booted {
  readonly mate: Mate;
  readonly discord: DiscordDriver;
  readonly clock: RealClock;
  readonly log: RecordingLog;
  readonly metrics: RecordingInstruments;
}

const booted: Booted[] = [];
const servers: { stop(): unknown }[] = [];

afterEach(async () => {
  for (const one of booted.splice(0)) {
    await one.mate.stop();
    one.clock.stop();
  }
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  await cleanUp();
});

async function boot(
  api: FakeDiscord,
  cluster: Rig,
  steps: FauxResponseStep[],
  overrides: ConfigOverrides & { githubApiBase?: string } = {},
): Promise<Booted> {
  const { githubApiBase, ...config } = overrides;
  const clock = new RealClock();
  const log = new RecordingLog();
  const metrics = new RecordingInstruments();
  const model = fauxModel();
  model.respond(...steps);
  const discord = new DiscordDriver(api, clock, log);
  const mate = new Mate({
    config: mateConfig(config),
    clock,
    log,
    metrics,
    kube: cluster.fake.config(),
    database: testDatabase(database().sql),
    surfaces: { discord: discord.listener, slack: null },
    providers: [model.provider],
    tuning: {
      threads: { editCadenceMs: 20, runGraceMs: 20 },
      brain: {
        retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
        timeouts: { mcpBootWait: 5_000 },
      },
      hands: {
        readyTimeoutMs: 4000,
        goneTimeoutMs: 4000,
        layout: {
          workspace: cluster.workspace,
          home: cluster.home,
          expectHome: cluster.home,
          epochs: new Epochs(),
          checkout: { closeMs: 2_000, pollMs: 20 },
        },
      },
      drainMs: 0,
      ...(githubApiBase ? { githubApiBase } : {}),
    },
  });
  const one = { mate, discord, clock, log, metrics };
  booted.push(one);
  await mate.start();
  await discord.ready();
  await eventually(() => log.of('ready').length > 0, 'the Discord surface');
  return one;
}

/** SIGTERM as main runs it, with no time left for turns to finish. */
const sigterm = (one: Booted) => one.mate.stop();

/** Opens a thread with a mention and returns the message and where it lives. */
async function start(one: Booted, content: string) {
  const before = one.discord.api.threads.length;
  const message = one.discord.mention(content);
  await eventually(
    () => one.discord.api.threads.length > before,
    'the thread to open',
  );
  const threadId = one.discord.api.threads[before]?.id as string;
  const ref: ThreadRef = discordRef(threadId, CHANNEL);
  return { message, threadId, ref, key: threadKey(ref) };
}

async function row(key: string): Promise<ThreadRow> {
  const found = await new PostgresThreadStore(database().sql).get(key);
  if (!found) throw new Error(`no row for ${key}`);
  return found;
}

/** The turn is marked on its message, and every write after it is done. */
async function settled(
  api: FakeDiscord,
  where: { channelId: string; message: string },
  key: string,
  mark = '✅',
): Promise<void> {
  await eventually(
    async () =>
      api.reactionsOn(where.channelId, where.message).includes(mark) &&
      (await row(key)).turn === null,
    `${key} to settle`,
  );
}

/** What the thread shows, message by message. */
function shown(discord: FakeDiscord, threadId: string) {
  return discord.inThread(threadId).map((message) => ({
    id: message.id,
    content: message.content,
    subtext: [...message.subtext],
    hasStop: message.hasStop,
    edits: message.edits,
  }));
}

/** The JSON-RPC methods mate wrote to one mate-hands exec, in order. */
function methods(exec: ExecRecord): string[] {
  return exec.stdin.map(
    (line) => (JSON.parse(line) as { method?: string }).method ?? '',
  );
}

function epochOf(exec: ExecRecord): number {
  return Number(exec.command[exec.command.indexOf('--epoch') + 1]);
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

function gate() {
  let open = () => {};
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

function mcpServer(name: McpServerConfig['name'], server: FakeMcp) {
  return { name, url: server.url, token: name === 'kthx' ? TOKEN : null };
}

describe('a turn', () => {
  test(
    'a chat-only turn answers and creates no Sandbox',
    async () => {
      const r = rig();
      const discord = new SnowflakeDiscord(ME);
      const mate = await boot(discord, r, [
        fauxAssistantMessage('hello there'),
      ]);
      const { message, threadId, key } = await start(mate, 'hi');
      await settled(discord, { channelId: CHANNEL, message }, key);

      expect(discord.contentsIn(threadId).at(-1)).toBe('hello there');
      expect(discord.reactionsOn(CHANNEL, message)).toEqual(['✅']);
      expect(r.fake.sandboxes.size).toBe(0);
      expect(r.fake.execs).toEqual([]);
      expect(
        r.fake.requests.filter((request) => request.method === 'POST'),
      ).toEqual([]);
      expect(mate.metrics.turnSandboxes).toEqual(['none']);
    },
    SLOW,
  );

  test(
    'a tool turn creates one Sandbox and one hands exec, and leaves each stamped file blank at 0600',
    async () => {
      const github = new FakeGitHub();
      servers.push(github);
      const r = rig();
      const discord = new SnowflakeDiscord(ME);
      const mate = await boot(
        discord,
        r,
        [
          tool('bash', { command: 'cat ~/.github-token' }, 'c-cat'),
          fauxAssistantMessage('the token is there'),
        ],
        {
          ...keys(),
          sandbox: { github: true, kubeServiceAccount: 'mate-sandbox-admin' },
          githubApiBase: github.base,
        },
      );
      // The boot preflight mints the token a turn then reuses.
      await eventually(
        () => mate.log.of('github app ready').length > 0,
        'the preflight',
      );
      const { message, threadId, key } = await start(mate, 'check the token');
      await settled(discord, { channelId: CHANNEL, message }, key);

      expect(discord.contentsIn(threadId).at(-1)).toBe('the token is there');
      expect(discord.reactionsOn(CHANNEL, message)).toEqual(['✅']);
      expect(r.fake.sandboxes.size).toBe(1);
      expect(r.fake.handsExecs).toHaveLength(1);
      const [name] = [...r.fake.sandboxes.keys()];
      expect((await row(key)).sandbox).toBe(name ?? null);
      // The command saw the token the turn stamped.
      const said = await transcript(database().sql, (await row(key)).sessionId);
      expect(toolText(said, 'c-cat')).toContain('ghs-token-1');

      for (const file of [
        '.github-token',
        '.kube/config',
        '.ssh/id_ed25519',
        '.ssh/config',
      ]) {
        const path = join(r.home, file);
        expect(readFileSync(path, 'utf8')).toBe('');
        expect(mode(path)).toBe(0o600);
      }
      expect(github.minted).toBe(1);
      expect(github.revoked).toEqual(['ghs-token-1']);
      expect(mate.metrics.turnSandboxes).toEqual(['fresh']);
    },
    SLOW,
  );
});

describe('a restart mid-turn', () => {
  test(
    'SIGTERM mid-bash leaves the turn for the next mate, which resumes it with the command interrupted',
    async () => {
      const r = rig();
      const discord = new SnowflakeDiscord(ME);
      const pidFile = join(r.workspace, 'sleep.pid');
      const first = await boot(discord, r, [
        tool(
          'bash',
          { command: 'echo $$ > sleep.pid; exec sleep 300' },
          'c-sleep',
        ),
      ]);
      const { message, threadId, key } = await start(first, 'run the long job');
      const [pid] = await pidsIn(pidFile, 1);
      if (pid === undefined) throw new Error('no sleep pid');
      await eventually(
        () =>
          shown(discord, threadId).some((m) =>
            m.subtext.some((line) => line.includes('sleep 300')),
          ),
        'the bash card',
      );
      // Past the edit cadence, so no repaint is still due.
      await Bun.sleep(200);
      const card = shown(discord, threadId);

      await sigterm(first);
      await Bun.sleep(200);

      // Nothing posted, and the card keeps its partial state and Stop button.
      expect(shown(discord, threadId)).toEqual(card);
      expect(card.at(-1)?.hasStop).toBe(true);
      expect(discord.reactionsOn(CHANNEL, message)).toEqual(['👀']);
      expect(first.metrics.turns).toEqual([]);
      expect((await row(key)).turn).toMatchObject({
        asker: OWNER,
        message: { channelId: CHANNEL, id: message },
        resumes: 0,
      });
      // The daemon was told to cancel before the link closed, and nothing
      // reconnected once the lease was abandoned.
      expect(r.fake.handsExecs).toHaveLength(1);
      const link = r.fake.handsExecs[0] as ExecRecord;
      const sent = methods(link);
      expect(sent).toContain('cancel');
      expect(sent.indexOf('cancel')).toBeLessThan(sent.indexOf('shutdown'));
      expect(link.clientClosed).toBe(true);
      expect(first.discord.gateway.destroys).toBe(1);

      const second = await boot(discord, r, [
        fauxAssistantMessage('picked it back up'),
      ]);
      await settled(discord, { channelId: CHANNEL, message }, key);

      const said = discord.contentsIn(threadId);
      expect(said.slice(card.length)).toEqual([RESUMING, 'picked it back up']);
      expect(discord.reactionsOn(CHANNEL, message)).toEqual(['✅']);
      expect(second.metrics.resumes).toEqual(['resumed']);
      expect(second.metrics.turns).toEqual(['end_turn']);
      // The new mate reconnected with a newer epoch, and no sleep survived.
      expect(r.fake.handsExecs).toHaveLength(2);
      const [old, fresh] = r.fake.handsExecs as [ExecRecord, ExecRecord];
      expect(fresh.pod).toBe(old.pod);
      expect(epochOf(fresh)).toBeGreaterThan(epochOf(old));
      await until(() => !alive(pid));
      const stored = await transcript(
        database().sql,
        (await row(key)).sessionId,
      );
      expect(toolText(stored, 'c-sleep')).toContain(INTERRUPTED);
    },
    SLOW,
  );

  test(
    'a resume while the MCP bridge lists nothing completes',
    async () => {
      const r = rig();
      const discord = new SnowflakeDiscord(ME);
      const held = gate();
      const deploy = new FakeMcp({
        tools: [
          {
            name: 'deploy',
            description: 'Deploys an app',
            inputSchema: {
              type: 'object',
              properties: { app: { type: 'string' } },
              required: ['app'],
            },
          },
        ],
      }).start();
      servers.push(deploy);
      deploy.handlers.set('deploy', async () => {
        await held.wait;
        return { content: [{ type: 'text', text: 'too late' }] };
      });
      const first = await boot(
        discord,
        r,
        [tool('kthx_deploy', { app: 'wishin' }, 'c-kthx')],
        { brain: { mcpServers: [mcpServer('kthx', deploy)] } },
      );
      const { message, threadId, key } = await start(first, 'deploy wishin');
      await eventually(
        () => deploy.calls('tools/call').length === 1,
        'the kthx call',
      );
      await sigterm(first);
      held.open();

      const empty = new FakeMcp({ tools: [] }).start();
      servers.push(empty);
      const second = await boot(
        discord,
        r,
        [fauxAssistantMessage('kthx went quiet; try again later')],
        { brain: { mcpServers: [mcpServer('kthx', empty)] } },
      );
      await settled(discord, { channelId: CHANNEL, message }, key);

      expect(second.metrics.turns).toEqual(['end_turn']);
      const said = discord.contentsIn(threadId);
      expect(said).toContain(RESUMING);
      expect(said.at(-1)).toBe('kthx went quiet; try again later');
      expect(said.some((line) => line.startsWith(HARNESS_FAILED))).toBe(false);
      expect(
        JSON.stringify([...second.log.entries, ...said]).includes(
          'configured_tools_unavailable',
        ),
      ).toBe(false);
      expect(discord.reactionsOn(CHANNEL, message)).toEqual(['✅']);
      const stored = await transcript(
        database().sql,
        (await row(key)).sessionId,
      );
      expect(toolText(stored, 'c-kthx')).toContain(INTERRUPTED);
      // The turn never needed a sandbox.
      expect(r.fake.sandboxes.size).toBe(0);
    },
    SLOW,
  );
});

describe('Stop', () => {
  test(
    'during a mint ends the turn at once; the mint lands against the thread, and its next turn reuses it',
    async () => {
      const r = rig();
      r.fake.readyOnCreate = false;
      const discord = new SnowflakeDiscord(ME);
      const mate = await boot(discord, r, [
        tool('bash', { command: 'true' }, 'c-first'),
        tool('bash', { command: 'echo again' }, 'c-again'),
        fauxAssistantMessage('ran it again'),
      ]);
      const { message, threadId, key } = await start(mate, 'run it');
      await eventually(() => r.fake.sandboxes.size === 1, 'the mint');
      const [name] = [...r.fake.sandboxes.keys()] as [string];

      mate.discord.stop(key);
      // Well inside the 4 s wait for Ready: Stop never waits out a mint.
      await eventually(
        async () =>
          discord.reactionsOn(CHANNEL, message).includes('⏹️') &&
          (await row(key)).turn === null,
        'the stopped turn',
        2_000,
      );
      expect(mate.metrics.turns).toEqual(['cancelled']);
      expect(r.fake.handsExecs).toEqual([]);

      r.fake.markReady(name);
      await eventually(
        async () => (await row(key)).sandbox === name,
        'the mint to land against the thread',
      );

      const again = mate.discord.say(threadId, 'try again');
      await settled(discord, { channelId: threadId, message: again }, key);
      expect(discord.contentsIn(threadId).at(-1)).toBe('ran it again');
      expect(r.fake.sandboxes.size).toBe(1);
      expect(
        r.fake.requests.filter(
          (request) =>
            request.method === 'POST' && request.path.endsWith('/sandboxes'),
        ),
      ).toHaveLength(1);
      expect(r.fake.handsExecs).toHaveLength(1);
      expect(r.fake.handsExecs[0]?.command[0]).toBe(HANDS_BINARY);
      expect(mate.metrics.turnSandboxes).toEqual(['failed', 'reused']);
    },
    SLOW,
  );
});

describe('profiles', () => {
  const ORIGIN = 'https://kthx.example.test';
  const SITES_SECRET = 'mate-kthx-sites';
  const LEDGER = serialize({ [ORIGIN]: { blog: 'tok-blog' } });
  const BASE = ['bash', 'edit', 'read', 'write'];

  /** The tool names pi sent the model, replayed from the system messages in order. */
  function toolsHeard(messages: readonly Message[]): string[] {
    const tools = new Set<string>();
    for (const message of messages) {
      if (message.role !== 'system') continue;
      for (const added of message.toolsAdded ?? []) tools.add(added.name);
      for (const removed of message.toolsRemoved ?? []) {
        tools.delete(removed.name);
      }
    }
    return [...tools].sort();
  }

  function serving(toolName: string): FakeMcp {
    const server = new FakeMcp({
      tools: [
        {
          name: toolName,
          description: toolName,
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    }).start();
    servers.push(server);
    return server;
  }

  function envNames(sandbox: unknown): string[] {
    const spec = (sandbox as { spec: { podTemplate: { spec: unknown } } }).spec
      .podTemplate.spec as { containers: { env?: { name: string }[] }[] };
    return (spec.containers[0]?.env ?? []).map((entry) => entry.name);
  }

  function labelsOf(sandbox: unknown): Record<string, string> {
    return (sandbox as { metadata: { labels: Record<string, string> } })
      .metadata.labels;
  }

  test(
    'an investigator thread runs read-only, refuses another profile, and an operator thread mints its own sandbox',
    async () => {
      const github = new FakeGitHub();
      servers.push(github);
      const r = rig();
      r.fake.putSecret(SITES_SECRET, { 'sites.json': LEDGER });
      const heard: string[][] = [];
      const discord = new SnowflakeDiscord(ME);
      const mate = await boot(
        discord,
        r,
        [
          (context) => {
            heard.push(toolsHeard(context.messages));
            return tool(
              'bash',
              {
                command:
                  'env; cat ~/.github-token ~/.kube/config ~/.ssh/id_ed25519 ~/.config/kthx/sites.json',
              },
              'c-look',
            );
          },
          fauxAssistantMessage('nothing to see'),
          (context) => {
            heard.push(toolsHeard(context.messages));
            return tool('bash', { command: 'true' }, 'c-fix');
          },
          fauxAssistantMessage('fixed'),
        ],
        {
          ...keys(),
          sandbox: {
            github: true,
            kubeServiceAccount: 'mate-sandbox-admin',
            kubeReaderServiceAccount: 'mate-sandbox-reader',
            kthx: { origin: ORIGIN, sitesSecret: SITES_SECRET },
          },
          brain: {
            mcpServers: [
              mcpServer('kthx', serving('deploy')),
              mcpServer('weather', serving('now')),
            ],
          },
          githubApiBase: github.base,
        },
      );
      await eventually(
        () => mate.log.of('github app ready').length > 0,
        'the preflight',
      );

      const investigating = await start(mate, '+investigator check');
      await settled(
        discord,
        { channelId: CHANNEL, message: investigating.message },
        investigating.key,
      );

      expect(discord.contentsIn(investigating.threadId)).toEqual([
        `${RUNS_AS} investigator`,
        'nothing to see',
      ]);
      expect(discord.reactionsOn(CHANNEL, investigating.message)).toEqual([
        '✅',
      ]);
      expect((await row(investigating.key)).profile).toBe('investigator');
      const readerName = sandboxNameFor(investigating.ref, INVESTIGATOR);
      expect(readerName).toBe(`${sandboxName(investigating.ref)}-r`);
      expect([...r.fake.sandboxes.keys()]).toEqual([readerName]);
      const readerSandbox = r.fake.sandboxes.get(readerName);
      expect(labelsOf(readerSandbox)).toMatchObject({
        'app.kubernetes.io/name': 'mate-sandbox-reader',
        'lolwtf.ca/minted-by': 'mate-reader',
        'lolwtf.ca/profile': 'investigator',
      });
      const env = envNames(readerSandbox);
      expect(env).toContain('KUBECONFIG');
      for (const name of env) {
        expect(name).not.toMatch(
          /^(SWITCHBOARD_|OP_|KTHX_ORIGIN$|MATE_GITHUB_TOKEN_FILE$)/,
        );
      }
      // The window was shut before mate ran anything in the pod.
      const readerExecs = r.fake.execs.filter((e) => e.pod === readerName);
      expect(readerExecs[0]?.command[0]).toBe(HANDS_BINARY);
      for (const exec of readerExecs) {
        expect(exec.podLabels[CHECKOUT_LABEL]).toBe('closed');
      }
      expect(r.fake.tokenRequests).toEqual([
        {
          account: 'mate-sandbox-reader',
          expirationSeconds: 1500,
          audiences: expect.any(Array),
        },
      ]);
      // Only the boot preflight minted, and nothing was revoked.
      expect(github.minted).toBe(1);
      expect(github.revoked).toEqual([]);
      const said = toolText(
        await transcript(
          database().sql,
          (await row(investigating.key)).sessionId,
        ),
        'c-look',
      );
      // The command ran with the reader's kubeconfig and nothing else.
      expect(said).toContain('sa-token-1');
      expect(said).not.toContain('ghs-token');
      expect(said).not.toContain('OPENSSH PRIVATE KEY');
      expect(said).not.toContain('tok-blog');
      for (const file of ['.github-token', '.ssh/id_ed25519', '.ssh/config']) {
        expect(readFileSync(join(r.home, file), 'utf8')).toBe('');
      }
      expect(existsSync(join(r.home, '.config/kthx/sites.json'))).toBe(false);
      expect(r.fake.patches.filter((p) => p.name === SITES_SECRET)).toEqual([]);
      expect(r.fake.secretValue(SITES_SECRET, 'sites.json')).toBe(LEDGER);
      expect(heard[0]).toEqual([...BASE, 'weather_now'].sort());

      const fix = mate.discord.say(investigating.threadId, '+operator do it');
      await eventually(
        () => discord.reactionsOn(investigating.threadId, fix).length > 0,
        'the refusal',
      );
      expect(discord.contentsIn(investigating.threadId).at(-1)).toBe(
        `${RUNS_AS} investigator — a thread keeps the profile it opened with; start a new thread for +operator`,
      );
      expect(discord.reactionsOn(investigating.threadId, fix)).toEqual(['⚠️']);
      expect(heard).toHaveLength(1);

      const operating = await start(mate, 'fix it');
      await settled(
        discord,
        { channelId: CHANNEL, message: operating.message },
        operating.key,
      );

      expect(discord.contentsIn(operating.threadId).at(-1)).toBe('fixed');
      expect((await row(operating.key)).profile).toBe('operator');
      const operatorName = sandboxName(operating.ref);
      expect([...r.fake.sandboxes.keys()].sort()).toEqual(
        [operatorName, readerName].sort(),
      );
      expect(labelsOf(r.fake.sandboxes.get(operatorName))).toMatchObject({
        'app.kubernetes.io/name': 'mate-sandbox',
        'lolwtf.ca/minted-by': 'mate',
        'lolwtf.ca/profile': 'operator',
      });
      expect(r.fake.tokenRequests.map((t) => t.account)).toEqual([
        'mate-sandbox-reader',
        'mate-sandbox-admin',
      ]);
      // The operator turn stamped the preflight's token, then revoked it.
      expect(github.minted).toBe(1);
      expect(github.revoked).toEqual(['ghs-token-1']);
      expect(heard[1]).toEqual([...BASE, 'kthx_deploy', 'weather_now'].sort());
    },
    SLOW,
  );
});
