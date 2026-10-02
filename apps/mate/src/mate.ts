/**
 * One mate process: the core every chat surface shares, its timers, and the
 * order it all stops in. The caller brings the process's edges: the parsed
 * config, the clock, the log, the metrics, the cluster, the database, each
 * chat surface's listener and pi's providers.
 */
import { fileURLToPath } from 'node:url';
import type { Provider } from '@earendil-works/pi-ai';
import {
  PiBrain,
  type PiBrainDeps,
  postgresSessions,
  type SessionSource,
} from './brain.ts';
import type { McpBridge, ModelSetup } from './brain-inputs.ts';
import { ChatgptAccount, ChatgptKeeper } from './chatgpt.ts';
import type { Clock, Handle } from './clock.ts';
import type { Config, GithubAppConfig } from './config.ts';
import { PostgresCredentialStore } from './credential-store.ts';
import { Custodian, PostgresCustodianLedger } from './custodian.ts';
import { GithubApp } from './github-app.ts';
import { KthxSites } from './kthx-sites.ts';
import { Kube, type KubeConfig } from './kube.ts';
import { type KubeHandsDeps, WORKSPACE } from './lease.ts';
import { type Log, plain } from './log.ts';
import { combineMcp, createMcpBridge } from './mcp.ts';
import type { Instruments } from './metrics.ts';
import { CHATGPT_PROVIDER, chatgptModel, createModelSetup } from './model.ts';
import { brainProfiles, loadSystemPrompts } from './profile.ts';
import { PROFILES } from './profiles.ts';
import { type HandsLayout, KubeHands, SPARE_SWEEP_MS } from './sandboxes.ts';
import type { SlackApi } from './slack.ts';
import { opensshKey } from './ssh-key.ts';
import {
  type Database,
  MemoryThreadStore,
  PostgresThreadStore,
} from './store.ts';
import type { SurfaceListener } from './surface.ts';
import { DRAIN_MS, Threads, type ThreadsDeps } from './threads.ts';

const DAY_MS = 86_400_000;
const RETENTION_SWEEP_MS = 3_600_000;
// A real mint at boot and on a timer keeps `mate_github_app_ready` current
// even when no turn has pushed.
const PREFLIGHT_MS = 15 * 60_000;
// The profile beside the source: the repo root, or /app in the image.
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

export interface SlackSide {
  /** Where the custodian posts its daily root. */
  readonly api: SlackApi;
  readonly listener: SurfaceListener;
}

export interface MateSurfaces {
  readonly discord: SurfaceListener;
  /** Opens Slack, or `null` when mate answers on Discord alone. */
  readonly slack: (() => Promise<SlackSide>) | null;
}

/** Test-only timings and sandbox layout; production leaves every one out. */
export interface MateTuning {
  readonly threads?: Pick<
    ThreadsDeps,
    'editCadenceMs' | 'runGraceMs' | 'progressCadenceMs'
  >;
  readonly brain?: Pick<PiBrainDeps, 'retry' | 'timeouts'>;
  readonly hands?: Pick<
    KubeHandsDeps,
    'ttlMs' | 'readyTimeoutMs' | 'goneTimeoutMs'
  > & { readonly layout?: HandsLayout };
  /** How long `stop` lets running turns finish. */
  readonly drainMs?: number;
  /** A GitHub of the test's own. */
  readonly githubApiBase?: string;
}

export interface MateEdges {
  readonly config: Config;
  readonly clock: Clock;
  readonly log: Log;
  readonly metrics: Instruments;
  /** The cluster the sandboxes run in, with the CA a sandbox's kubeconfig names. */
  readonly kube: KubeConfig;
  /** mate closes it last, when it stops. */
  readonly database: Database;
  readonly surfaces: MateSurfaces;
  /** What MATE_MODEL and the fallback may name; OpenCode Go's and ChatGPT's when absent. */
  readonly providers?: readonly Provider[];
  readonly tuning?: MateTuning;
}

interface Chatgpt {
  account: ChatgptAccount;
  keeper: ChatgptKeeper;
  credentials: PostgresCredentialStore;
}

/** What a start built, and so what a stop takes down. */
interface Running {
  threads: Threads;
  hands: KubeHands;
  brain: PiBrain;
  mcp: McpBridge | null;
  chatgpt: Chatgpt | null;
  githubApp: GithubApp | null;
  slack: SlackSide | null;
  custodian: Custodian | null;
  timers: (() => void)[];
}

/** A store with no pool never comes up: its URL or CA is missing. */
function storeState(db: Database): string {
  if (db.sql === null) return 'down';
  return db.up() ? 'up' : 'migrating';
}

function every(clock: Clock, ms: number, fn: () => void): () => void {
  let handle: Handle = clock.after(ms, tick);
  function tick() {
    handle = clock.after(ms, tick);
    fn();
  }
  return () => clock.cancel(handle);
}

export class Mate {
  private starting: Promise<Running> | null = null;
  private stopping: Promise<void> | null = null;

  constructor(private readonly edges: MateEdges) {}

  /**
   * Builds the core, starts Slack, then connects Discord. Throws
   * `ConfigError` for a model or profile model pi's catalog lacks.
   */
  async start(): Promise<void> {
    if (this.starting || this.stopping) {
      throw new Error('mate starts once, before it stops');
    }
    this.starting = this.build();
    const running = await this.starting;
    if (this.stopping) return;
    this.arm(running);
    const { config, log, database } = this.edges;
    log.info('mate starting', {
      guildId: config.guildId,
      allowedUsers: config.allowedUserIds.size,
      allowedChannels: [...config.allowedChannelIds],
      slack: Boolean(config.slack),
      model: config.brain.model,
      thinking: config.brain.thinking,
      fallback: config.brain.fallbackModel,
      maxConcurrent: config.maxConcurrent,
      maxSandboxes: config.maxSandboxes,
      store: storeState(database),
      chatgpt: Boolean(running.chatgpt),
      quietMinutes: config.quietMs / 60_000,
      turnMinutes: config.sandbox.turnTimeoutMs / 60_000,
      port: config.port,
    });
    await this.edges.surfaces.discord.start(running.threads);
  }

  /** Waits for a start under way, then stops everything in order. Never throws. */
  stop(): Promise<void> {
    this.stopping ??= this.shutdown();
    return this.stopping;
  }

  private async build(): Promise<Running> {
    const { config, clock, log, metrics, database: db, tuning } = this.edges;
    const { brain: brainConfig, sandbox } = config;
    // An unreadable key is not fatal: with one replica, refusing to boot would
    // take both chat surfaces down over the credential for pushing.
    const githubApp = config.githubApp
      ? await this.openGithubApp(config.githubApp)
      : null;
    const kube = new Kube(this.edges.kube);
    // Only a ChatGPT primary holds the sign-in, so a process answering on
    // another model can never spend mate's refresh token.
    const credentials =
      this.chatgptPrimary() && db.sql
        ? new PostgresCredentialStore({ db, log, clock, metrics })
        : null;
    const setup = createModelSetup({
      spec: brainConfig.model,
      thinking: brainConfig.thinking,
      fallbackSpec: brainConfig.fallbackModel,
      fallbackThinking: brainConfig.fallbackThinking,
      keyFile: brainConfig.modelKeyFile,
      credentials: credentials ?? undefined,
      ...(this.edges.providers ? { providers: this.edges.providers } : {}),
      log,
      clock,
      metrics,
    });
    const prompts = await loadSystemPrompts(
      {
        root: brainConfig.profileRoot ?? REPO_ROOT,
        workspace: WORKSPACE,
        checkoutRef: sandbox.checkoutRef,
        log,
      },
      PROFILES.values(),
    );
    const profiles = brainProfiles(setup, prompts, sandbox.turnTimeoutMs);
    const mcp = this.openMcp();
    const { layout, ...handsTuning } = tuning?.hands ?? {};
    const hands = new KubeHands(
      {
        kube,
        config: sandbox,
        guildId: config.guildId,
        maxSandboxes: config.maxSandboxes,
        log,
        clock,
        metrics,
        githubApp,
        kthxSites: this.openKthxSites(kube),
        clusterCa: this.edges.kube.ca ?? null,
        sshKey: await this.readSshKey(config.sshKeyFile),
        ...handsTuning,
      },
      layout,
    );
    const inherited = await hands.start().catch((error) => {
      log.error('the hands could not start', { error: plain(error) });
      return [];
    });
    // With no database the rows live in memory, and every open is refused.
    const threadStore = db.sql
      ? new PostgresThreadStore(db.sql)
      : new MemoryThreadStore();
    const sessions: SessionSource = db.sql
      ? postgresSessions(db.sql)
      : {
          open: () => Promise.reject(new Error('mate has no database')),
          delete: async () => {},
        };
    const brain = new PiBrain({
      db,
      store: threadStore,
      sessions,
      hands,
      setup,
      profiles,
      mcp,
      log,
      clock,
      metrics,
      ...tuning?.brain,
    });
    const chatgpt = credentials ? this.openChatgpt(setup, credentials) : null;
    // A Slack failure is not fatal: a crash loop would take Discord down with it.
    const { surfaces } = this.edges;
    const slack = surfaces.slack
      ? await surfaces.slack().catch((error) => {
          log.error('slack could not be opened; answering on Discord alone', {
            error: plain(error),
          });
          return null;
        })
      : null;
    const threads = new Threads({
      surfaces: [],
      brain,
      store: threadStore,
      storeReady: db.ready,
      inherited,
      clock,
      log,
      config,
      metrics,
      commands: chatgpt?.account,
      ...tuning?.threads,
    });
    chatgpt?.keeper.start(db.ready);
    const custodian =
      config.custodianChannel && slack && db.sql
        ? new Custodian({
            ledger: new PostgresCustodianLedger(db.sql),
            slack: slack.api,
            threads,
            channel: config.custodianChannel,
            owner: [...(config.slack?.allowedUserIds ?? [])][0] ?? '',
            log,
            clock,
          })
        : null;
    if (custodian) void db.ready.then(() => custodian.start());
    else if (config.custodianChannel)
      log.warn('custodian disabled: Slack or database unavailable');
    // Before the gateway: a revoked or rate-limited Discord token, or a wait on
    // the identify budget, must not hold Slack back.
    if (slack) await slack.listener.start(threads);
    return {
      threads,
      hands,
      brain,
      mcp,
      chatgpt,
      githubApp,
      slack,
      custodian,
      timers: [],
    };
  }

  private arm(running: Running): void {
    const { config, clock, log, metrics } = this.edges;
    const { hands, brain, githubApp, timers } = running;
    const spares = () =>
      void hands
        .ensureSpares()
        .catch((error) =>
          log.warn('spare sweep failed', { error: plain(error) }),
        );
    timers.push(every(clock, SPARE_SWEEP_MS, spares));
    spares();

    const retentionDays = config.brain.sessionRetentionDays;
    const retain = () =>
      void brain
        .sweep(clock.now() - retentionDays * DAY_MS)
        .catch((error) =>
          log.warn('the retention sweep failed', { error: plain(error) }),
        );
    if (retentionDays > 0)
      timers.push(every(clock, RETENTION_SWEEP_MS, retain));

    if (!githubApp) return;
    const preflight = () =>
      void githubApp
        .preflight()
        .then((status) => {
          metrics.githubAppReady(true);
          log.info('github app ready', {
            installationId: status.installationId,
            login: status.login,
            expiresAt: new Date(status.expiresAt).toISOString(),
          });
        })
        .catch((error) => {
          metrics.githubAppReady(false);
          log.error('github app NOT ready', { error: plain(error) });
        });
    timers.push(every(clock, PREFLIGHT_MS, preflight));
    preflight();
  }

  private async shutdown(): Promise<void> {
    const running = await this.starting?.catch(() => null);
    if (!running) return;
    const { log, database, surfaces, tuning } = this.edges;
    const { threads, hands, chatgpt, slack, custodian, mcp } = running;
    // First: envelopes are acked on receipt, so one taken during the drain is
    // lost for good.
    slack?.listener.stop();
    custodian?.stop();
    for (const cancel of running.timers) cancel();
    // While both surfaces can still post: running turns finish or stay open for
    // the next process to resume, and queued prompts are told they never started.
    await threads
      .drain(tuning?.drainMs ?? DRAIN_MS)
      .catch((error) => log.warn('drain failed', { error: plain(error) }));
    await hands.shutdown();
    chatgpt?.keeper.stop();
    // While the surfaces can still post: a sign-in waiting for its code tells
    // its thread that the code no longer works.
    await chatgpt?.account.stop();
    surfaces.discord.stop();
    try {
      await surfaces.discord.close();
    } catch (error) {
      log.warn('gateway destroy failed', { error: plain(error) });
    }
    await slack?.listener.close();
    await mcp?.close().catch(() => {});
    // Before the pool closes: a refresh still running saves its rotated token,
    // and one that did not save gets a last try.
    await chatgpt?.credentials.close().catch(() => {});
    await database
      .close()
      .catch((error) =>
        log.warn('database close failed', { error: plain(error) }),
      );
  }

  private chatgptPrimary(): boolean {
    const { model } = this.edges.config.brain;
    return model.slice(0, model.indexOf('/')) === CHATGPT_PROVIDER;
  }

  private async openGithubApp(app: GithubAppConfig): Promise<GithubApp | null> {
    const { config, clock, log, metrics, tuning } = this.edges;
    try {
      if (!/^\d+$/.test(app.appId)) {
        throw new Error('MATE_GITHUB_APP_ID is not a numeric App id');
      }
      const privateKey = await Bun.file(app.keyFile).text();
      return new GithubApp({
        appId: app.appId,
        privateKey,
        owner: app.owner,
        repo: app.repo,
        turnTimeoutMs: config.sandbox.turnTimeoutMs,
        clock,
        log,
        ...(tuning?.githubApiBase ? { apiBase: tuning.githubApiBase } : {}),
      });
    } catch (error) {
      // An App id is set, so a key that fails to open reports not ready.
      metrics.githubAppReady(false);
      log.error('the GitHub App could not be opened', {
        keyFile: app.keyFile,
        error: plain(error),
      });
      return null;
    }
  }

  // Read once at boot, so a failure is one log line. Unreadable is not fatal,
  // for the same reason as the App key.
  private async readSshKey(path: string | null): Promise<string | null> {
    if (!path) return null;
    try {
      return opensshKey(await Bun.file(path).text());
    } catch (error) {
      this.edges.log.error('the sandbox SSH key could not be read', {
        keyFile: path,
        error: plain(error),
      });
      return null;
    }
  }

  // The ledger lives in mate's own namespace, whichever one holds the sandboxes.
  private openKthxSites(kube: Kube): KthxSites | null {
    const { config, log } = this.edges;
    const { kthx } = config.sandbox;
    if (!kthx.origin) return null;
    log.info('kthx sites ledger on', {
      origin: kthx.origin,
      secret: kthx.sitesSecret,
    });
    return new KthxSites({
      kube,
      namespace: kube.namespace,
      secret: kthx.sitesSecret,
      log,
    });
  }

  private openMcp(): McpBridge | null {
    const { config, clock, log, metrics } = this.edges;
    const { mcpServers } = config.brain;
    if (mcpServers.length === 0) return null;
    const bridge = combineMcp(
      mcpServers.map((server) => {
        log.info(`${server.name} mcp on`, { url: server.url });
        return createMcpBridge({
          name: server.name,
          prefix: `${server.name}_`,
          url: server.url,
          ...(server.token ? { token: server.token } : {}),
          log,
          clock,
          metrics,
        });
      }),
    );
    bridge.start();
    return bridge;
  }

  // Signed in from chat and kept fresh by the keeper, which tells the router of
  // each sign-in and refusal.
  private openChatgpt(
    setup: ModelSetup,
    credentials: PostgresCredentialStore,
  ): Chatgpt {
    const { clock, log, metrics } = this.edges;
    const keeper = new ChatgptKeeper({
      models: setup.direct,
      credentials,
      clock,
      log,
      metrics,
      router: setup.router,
    });
    const account = new ChatgptAccount({
      models: setup.direct,
      keeper,
      credentials,
      model: chatgptModel(setup),
      lane: { model: setup.model, thinking: setup.thinking },
      router: setup.router,
      clock,
      log,
    });
    return { account, keeper, credentials };
  }
}
