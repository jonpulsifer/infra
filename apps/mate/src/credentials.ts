/**
 * A turn's credentials in its sandbox: minted on the turn's first tool call,
 * written over the hands link with `writeFiles`, and blanked when the turn
 * ends. The thread's profile grants each one: a credential it does not grant
 * is written empty, and its kthx sites file is never read or folded. Nothing
 * outlives the turn: the GitHub token is revoked whatever happens, and the
 * cluster token expires on its own.
 */
import { HandsError } from '@repo/mate-hands/protocol';
import { type Clock, type Handle, systemClock } from './clock.ts';
import type { SandboxConfig } from './config.ts';
import { HARNESS_CONTAINER, type HandsClient } from './hands.ts';
import type { HandsTarget } from './hands-env.ts';
import {
  type KthxSites,
  parseSites,
  SITES_LIMIT_BYTES,
  type Sites,
  serialize,
} from './kthx-sites.ts';
import { type ExecClose, type Kube, KubeError } from './kube.ts';
import {
  AGENT_HOME,
  type HandsInstruments,
  type TokenSource,
} from './lease.ts';
import { type Log, plain } from './log.ts';
import { type Grants, type Profile, turnTimeoutMs } from './profiles.ts';

/** Bounds a stamp or a retire: a few small files on a live pod. */
export const STAMP_TIMEOUT_MS = 15_000;
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

// Under the sandbox home. The pod's env names the first two, so the
// credential helper, `gh` and kubectl find them.
export const TOKEN_PATH = '.github-token';
export const KUBECONFIG_PATH = '.kube/config';
const SSH_DIR = '.ssh';
const SSH_KEY_PATH = `${SSH_DIR}/id_ed25519`;
const SSH_CONFIG_PATH = `${SSH_DIR}/config`;
// Where the kthx CLI keeps its site tokens under the image's XDG_CONFIG_HOME.
const SITES_PATH = '.config/kthx/sites.json';

// folly's Lab Net has no route from offsite, but folly's nodes do, and the
// Lab zone admits them. optiplex, folly's only control plane, is not the hop.
const LAB_NET_HOSTS = ['spore', 'capsule', 'forge', 'cloudpi4', 'homepi4'];
const LAB_NET_JUMP = 'riptide.lolwtf.ca';

// `always` canonicalizes a short name before the Host blocks match, proxied
// or not. accept-new: home is a fresh emptyDir with no known hosts, so `yes`
// refuses every host, and `no` would accept a changed key.
export function sshClientConfig(home: string): string {
  return [
    'CanonicalizeHostname always',
    'CanonicalDomains lolwtf.ca',
    'CanonicalizeMaxDots 0',
    'CanonicalizeFallbackLocal yes',
    '',
    `Host ${LAB_NET_HOSTS.map((host) => `${host}.lolwtf.ca`).join(' ')}`,
    `  ProxyJump ${LAB_NET_JUMP}`,
    '',
    // Its wired port has no link; it answers on the lab WLAN.
    'Host homepi4.lolwtf.ca',
    '  HostName homepi4-wifi.lolwtf.ca',
    '',
    'Host *',
    '  User rowbutt',
    `  IdentityFile ${home}/${SSH_KEY_PATH}`,
    '  IdentitiesOnly yes',
    '  StrictHostKeyChecking accept-new',
    `  UserKnownHostsFile ${home}/${SSH_DIR}/known_hosts`,
    '',
  ].join('\n');
}

export const SSH_CLIENT_CONFIG = sshClientConfig(AGENT_HOME);

const CLUSTER_URL = 'https://kubernetes.default.svc:443';
// Both apiservers list `api` in --api-audiences, and folly's federation admits
// an offsite token for no other audience. A bound token is refused by any
// audience it was not minted for, compared as exact strings.
const TOKEN_AUDIENCE = 'api';
// Outlives the turn, so the token never expires under a running `kubectl`.
const TOKEN_SLACK_SECONDS = 5 * 60;
// The apiserver refuses a TokenRequest under ten minutes.
const TOKEN_FLOOR_SECONDS = 600;

export interface KubeCluster {
  name: string;
  server: string;
  ca: string | null;
}

// JSON is YAML, so kubectl reads it and no indentation can slip. The first
// cluster is the current context. With no CA the sandbox trusts the system
// store, as mate does; it never gets `insecure-skip-tls-verify`.
export function kubeconfig(token: string, clusters: KubeCluster[]): string {
  return `${JSON.stringify(
    {
      apiVersion: 'v1',
      kind: 'Config',
      clusters: clusters.map(({ name, server, ca }) => ({
        name,
        cluster: {
          server,
          ...(ca
            ? {
                'certificate-authority-data':
                  Buffer.from(ca).toString('base64'),
              }
            : {}),
        },
      })),
      users: [{ name: 'sandbox', user: { token } }],
      contexts: clusters.map(({ name }) => ({
        name,
        context: { cluster: name, user: 'sandbox' },
      })),
      'current-context': clusters[0]?.name ?? '',
    },
    null,
    2,
  )}\n`;
}

const PEER_SERVER = /^https:\/\/[a-z0-9.-]+:\d{1,5}$/;
const PEM_CERTIFICATE = '-----BEGIN CERTIFICATE-----';

/** Where the checkout says a peer cluster's apiserver is, and the CA it chains to. */
export function peerPaths(
  workspace: string,
  peer: string,
): { topology: string; ca: string } {
  return {
    topology: `${workspace}/clusters/${peer}/config/cluster-topology.json`,
    ca: `${workspace}/terraform/pki/certs/${peer}-ca-bundle.pem`,
  };
}

/**
 * A peer from its topology ConfigMap and CA bundle, the way the Atlantis
 * kubeconfig hook reads them. Throws saying what is wrong with either.
 */
export function parsePeer(
  name: string,
  topology: string,
  bundle: string,
): KubeCluster {
  const data = (JSON.parse(topology) as { data?: Record<string, unknown> })
    ?.data;
  const host = data?.API_SERVER_HOSTNAME;
  const port = data?.API_SERVER_PORT;
  const server = `https://${String(host)}:${String(port)}`;
  if (
    typeof host !== 'string' ||
    typeof port !== 'string' ||
    !PEER_SERVER.test(server)
  ) {
    throw new Error(`the topology names no apiserver, only ${server}`);
  }
  if (!bundle.includes(PEM_CERTIFICATE)) {
    throw new Error('the CA bundle holds no certificate');
  }
  return { name, server, ca: bundle };
}

/** The ServiceAccount a kube grant mints for, or `null` for no cluster access. */
export function kubeAccount(
  config: SandboxConfig,
  grant: Grants['kube'],
): string | null {
  if (grant === 'admin') return config.kubeServiceAccount;
  if (grant === 'reader') return config.kubeReaderServiceAccount;
  return null;
}

export interface CredentialDeps {
  readonly kube: Kube;
  readonly namespace: string;
  readonly config: SandboxConfig;
  readonly log: Log;
  readonly clock?: Clock;
  readonly metrics?: HandsInstruments;
  readonly githubApp?: TokenSource | null;
  readonly kthxSites?: KthxSites | null;
  readonly clusterCa?: string | null;
  readonly sshKey?: string | null;
  /** Where one-shot commands write, with no daemon to say where home is. */
  readonly home?: string;
}

interface Minted {
  github: string | null;
  cluster: string | null;
}

/**
 * The credentials of every sandbox, and the kthx sites ledger's view of each:
 * what a sandbox's sites file holds that the ledger also holds, so a name
 * missing from the file is a removal only against this. Empty after a
 * restart, which folds every site as new.
 */
export class Credentials {
  private readonly stamped = new Map<string, Sites>();
  readonly clock: Clock;

  constructor(readonly deps: CredentialDeps) {
    this.clock = deps.clock ?? systemClock;
  }

  /** Whether a turn under `grants` has anything to write at all. */
  credentialled(grants: Grants): boolean {
    const { githubApp, config, sshKey } = this.deps;
    return Boolean(
      (grants.github && githubApp) ||
        kubeAccount(config, grants.kube) ||
        (grants.ssh && sshKey) ||
        (grants.kthxSites && this.kthx),
    );
  }

  get kthx(): KthxSites | null {
    return this.deps.config.kthx.origin ? (this.deps.kthxSites ?? null) : null;
  }

  turn(profile: Profile): TurnCredentials {
    return new TurnCredentials(
      this,
      profile.grants,
      turnTimeoutMs(profile, this.deps.config.turnTimeoutMs),
    );
  }

  /**
   * Before a sandbox is deleted: folds its sites file into the ledger over a
   * one-shot command, since no link is open. Never throws.
   */
  async keepSites(sandbox: string, pod: string): Promise<void> {
    if (!this.kthx) return;
    try {
      await bounded(this.clock, 'keeping the kthx sites', () =>
        this.syncSites(sandbox, () =>
          this.command(pod, ['/bin/sh', '-c', readSitesScript(this.home)]),
        ),
      );
    } catch (error) {
      // 404: gone already, and its home with it.
      if (error instanceof KubeError && error.status === 404) return;
      this.deps.log.warn('could not keep the sandbox kthx sites', {
        sandbox,
        error: plain(error),
      });
    }
  }

  forget(sandbox: string): void {
    this.stamped.delete(sandbox);
  }

  get home(): string {
    return this.deps.home ?? AGENT_HOME;
  }

  /**
   * Reads a sandbox's kthx site tokens back into the ledger. Answers what the
   * file should hold now, or `null` to leave it alone: an unreadable file may
   * hold tokens nobody else has, and after a failed save it is their only
   * copy. `read-failed` is the file, `save-failed` the Secret.
   */
  async syncSites(
    sandbox: string,
    read: () => Promise<string>,
  ): Promise<Sites | null> {
    const { log, metrics } = this.deps;
    const ledger = this.kthx;
    if (!ledger) return null;
    const before = this.stamped.get(sandbox) ?? {};
    let harvested: Sites;
    try {
      // Only absence is tolerated: a file that is there but cannot be read
      // is not a file with nothing in it.
      harvested = parseSites(await read());
    } catch (error) {
      metrics?.kthxSitesSynced('read-failed');
      log.error('could not read the sandbox kthx sites file', {
        sandbox,
        error: plain(error),
      });
      // Unknown: a fold against nothing stamped can only add, never remove.
      this.stamped.set(sandbox, {});
      return null;
    }
    try {
      const sites = await ledger.merge(before, harvested);
      metrics?.kthxSitesSynced('ok');
      // The file holds this, and now so does the ledger.
      this.stamped.set(sandbox, harvested);
      return sites;
    } catch (error) {
      metrics?.kthxSitesSynced('save-failed');
      log.error('could not save the sandbox kthx sites into the ledger', {
        sandbox,
        secret: ledger.secret,
        error: plain(error),
      });
      // The file holds what the ledger does not; the next fold must add it.
      this.stamped.set(sandbox, {});
      return null;
    }
  }

  /** The file now holds what `sites` does. */
  wrote(sandbox: string, sites: Sites): void {
    this.stamped.set(sandbox, sites);
  }

  /**
   * Blanks every credential file with one command. Values go in argv, since
   * the stream cannot half-close stdin, so every one is empty: argv reaches
   * the apiserver audit log.
   */
  async blank(pod: string, sites: boolean): Promise<void> {
    const home = this.home;
    const sitesFile = `${home}/${SITES_PATH}`;
    await this.command(pod, [
      '/bin/sh',
      '-c',
      [
        'umask 077',
        `mkdir -p ${home}/${SSH_DIR} "$(dirname ${home}/${KUBECONFIG_PATH})"${
          sites ? ` "$(dirname ${sitesFile})"` : ''
        }`,
        `printf %s "$1" > ${home}/${TOKEN_PATH}`,
        `printf %s "$2" > ${home}/${KUBECONFIG_PATH}`,
        `printf %s "$3" > ${home}/${SSH_KEY_PATH}`,
        `printf %s "$4" > ${home}/${SSH_CONFIG_PATH}`,
        ...(sites ? [`printf %s "$5" > ${sitesFile}`] : []),
      ].join('; '),
      'mate',
      '',
      '',
      '',
      '',
      ...(sites ? [serialize({})] : []),
    ]);
  }

  /**
   * A one-shot command's output. stdin is never closed: the stream has no
   * half-close, and kata-clh drops stdout after an EOF on it.
   */
  async command(pod: string, command: string[]): Promise<string> {
    const stream = await this.deps.kube.exec({
      namespace: this.deps.namespace,
      pod,
      container: HARNESS_CONTAINER,
      command,
      timeoutMs: STAMP_TIMEOUT_MS,
    });
    const timer = this.clock.after(STAMP_TIMEOUT_MS, () => stream.close());
    const chunks: Uint8Array[] = [];
    let size = 0;
    let close: ExecClose;
    try {
      const reader = stream.stdout.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > SITES_LIMIT_BYTES) {
          stream.close();
          throw new Error(
            `${command[0]} printed more than ${SITES_LIMIT_BYTES} bytes`,
          );
        }
        chunks.push(value);
      }
      close = await stream.closed;
    } finally {
      this.clock.cancel(timer);
    }
    // No status means nobody saw the exit, and the files may be untouched.
    if (close.status?.status !== 'Success') {
      throw new Error(
        `${command[0]} said ${close.status?.message || close.reason}`,
      );
    }
    return Buffer.concat(chunks).toString('utf8');
  }
}

/**
 * One turn's credentials. The tokens are minted once, on the first stamp;
 * each pod the turn uses is stamped once.
 */
export class TurnCredentials {
  /** Something was written this turn, so the turn's end blanks it. */
  stamped = false;
  private minted: Promise<Minted> | null = null;
  /** Moves on when a stamp gives up on its mint, which still runs. */
  private round = 0;
  private github: string | null = null;
  private sealed = false;

  constructor(
    private readonly creds: Credentials,
    private readonly grants: Grants,
    /** Bounds the cluster token's lifetime. */
    private readonly turnMs: number,
  ) {}

  /**
   * The turn is over: nothing is written after this, and a token whose mint
   * lands later is revoked as it lands.
   */
  seal(): void {
    this.sealed = true;
  }

  /** Never throws, and never fails the turn: a thread that cannot push can still answer. */
  async stamp(target: HandsTarget, client: HandsClient): Promise<void> {
    const { creds, grants } = this;
    const { log, metrics } = creds.deps;
    const githubApp = grants.github ? creds.deps.githubApp : null;
    if (!creds.credentialled(grants) || this.sealed) return;
    this.stamped = true;
    try {
      await bounded(creds.clock, 'stamping credentials', async (signal) => {
        const { github, cluster } = await this.mint(signal);
        const { home, cwd } = client.hello;
        const kube = cluster
          ? kubeconfig(cluster, [
              {
                name: creds.deps.config.kubeContext,
                server: CLUSTER_URL,
                ca: creds.deps.clusterCa ?? null,
              },
              ...(await this.peers(target, client, cwd, signal)),
            ])
          : '';
        // First, so a save the last turn's end could not make is retried now.
        const sites = grants.kthxSites
          ? await creds.syncSites(target.sandbox, () =>
              readSites(client, home, signal),
            )
          : null;
        const ssh = grants.ssh ? (creds.deps.sshKey ?? '') : '';
        if (this.sealed) return;
        await client.call(
          'writeFiles',
          {
            files: [
              ...credentialFiles(home, {
                github: github ?? '',
                kube,
                ssh,
                // No key, no client config pointing ssh at one.
                sshConfig: ssh ? sshClientConfig(home) : '',
              }),
              ...(sites
                ? [file(`${home}/${SITES_PATH}`, serialize(sites))]
                : []),
            ],
            dirMode: DIR_MODE,
          },
          { signal },
        );
        // Only now: a write that failed left the file as the fold read it.
        if (sites) creds.wrote(target.sandbox, sites);
        if (githubApp) {
          metrics?.githubTokenStamped(github ? 'ok' : 'mint-failed');
        }
      });
    } catch (error) {
      if (githubApp) metrics?.githubTokenStamped('stamp-failed');
      log.error("could not stamp the turn's credentials into the sandbox", {
        sandbox: target.sandbox,
        error: plain(error),
      });
      // Revoked now, since it reached nobody; a later pod mints its own. A
      // mint still running revokes its token when it lands.
      this.minted = null;
      this.round += 1;
      await this.revoke();
    }
  }

  /**
   * Blanks what `stamp` wrote: over the link while it is open, else with a
   * one-shot command carrying no secret. The sites file becomes `{}` only
   * once the ledger holds what it said. Never throws.
   */
  async retire(target: HandsTarget, client: HandsClient | null): Promise<void> {
    const { creds, grants } = this;
    if (!this.stamped) return;
    try {
      await bounded(creds.clock, 'blanking credentials', async (signal) => {
        if (client && !client.isClosed) {
          const { home } = client.hello;
          const synced = grants.kthxSites
            ? await creds.syncSites(target.sandbox, () =>
                readSites(client, home, signal),
              )
            : null;
          await client.call(
            'writeFiles',
            {
              files: [
                ...credentialFiles(home, {
                  github: '',
                  kube: '',
                  ssh: '',
                  sshConfig: '',
                }),
                // `{}` and not nothing: the CLI reads an empty file as corrupt.
                ...(synced
                  ? [file(`${home}/${SITES_PATH}`, serialize({}))]
                  : []),
              ],
              dirMode: DIR_MODE,
            },
            { signal },
          );
          // What the next turn reads first, and it folds in as nothing
          // claimed, not as every site removed.
          if (synced) creds.wrote(target.sandbox, {});
          return;
        }
        const synced = grants.kthxSites
          ? await creds.syncSites(target.sandbox, () =>
              creds.command(target.pod, [
                '/bin/sh',
                '-c',
                readSitesScript(creds.home),
              ]),
            )
          : null;
        await creds.blank(target.pod, synced !== null);
        if (synced) creds.wrote(target.sandbox, {});
      });
    } catch (error) {
      creds.deps.log.warn("could not clear the turn's credentials", {
        sandbox: target.sandbox,
        error: plain(error),
      });
    }
  }

  /** Revokes the GitHub token, if one was minted. Never throws. */
  async revoke(): Promise<void> {
    const token = this.github;
    this.github = null;
    await this.revokeToken(token);
  }

  private async revokeToken(token: string | null): Promise<void> {
    if (!token) return;
    const { githubApp, log } = this.creds.deps;
    await githubApp
      ?.revoke(token)
      .catch((error: unknown) =>
        log.warn('could not revoke the GitHub token', { error: plain(error) }),
      );
  }

  private mint(signal: AbortSignal): Promise<Minted> {
    this.minted ??= this.mintOnce(signal);
    return this.minted;
  }

  private async mintOnce(signal: AbortSignal): Promise<Minted> {
    const round = this.round;
    const [github, cluster] = await Promise.all([
      this.mintGithub(),
      this.mintCluster(signal),
    ]);
    // The stamp that asked gave up, or the turn ended: nobody writes it.
    if (this.sealed || this.round !== round) {
      await this.revokeToken(github);
      return { github: null, cluster };
    }
    this.github = github;
    return { github, cluster };
  }

  /** `null` when minting failed; the reason is already logged. */
  private async mintGithub(): Promise<string | null> {
    const { githubApp, log, metrics } = this.creds.deps;
    if (!githubApp || !this.grants.github) return null;
    try {
      const { token } = await githubApp.token();
      metrics?.githubTokenMinted('ok');
      return token;
    } catch (error) {
      metrics?.githubTokenMinted('mint-failed');
      log.error('could not mint a GitHub token for this turn', {
        error: plain(error),
      });
      return null;
    }
  }

  /**
   * `null` means no cluster access. A bound token cannot be revoked, so its
   * expiry bounds any copy taken during the turn.
   */
  private async mintCluster(signal: AbortSignal): Promise<string | null> {
    const { config, kube, log, namespace } = this.creds.deps;
    const account = kubeAccount(config, this.grants.kube);
    if (!account) return null;
    const seconds = Math.max(
      TOKEN_FLOOR_SECONDS,
      Math.ceil(this.turnMs / 1000) + TOKEN_SLACK_SECONDS,
    );
    try {
      const minted = await kube.json<{ status?: { token?: string } }>(
        `/api/v1/namespaces/${namespace}/serviceaccounts/${account}/token`,
        {
          method: 'POST',
          body: {
            apiVersion: 'authentication.k8s.io/v1',
            kind: 'TokenRequest',
            spec: { audiences: [TOKEN_AUDIENCE], expirationSeconds: seconds },
          },
          signal,
        },
      );
      const token = minted.status?.token;
      if (!token) throw new Error('TokenRequest answered no token');
      return token;
    } catch (error) {
      log.error('could not mint cluster access for this turn', {
        serviceAccount: account,
        error: plain(error),
      });
      return null;
    }
  }

  /** Never fails the stamp: without a peer the kubeconfig still reaches this cluster. */
  private async peers(
    target: HandsTarget,
    client: HandsClient,
    workspace: string,
    signal: AbortSignal,
  ): Promise<KubeCluster[]> {
    const found: KubeCluster[] = [];
    for (const peer of this.creds.deps.config.kubePeers) {
      const paths = peerPaths(workspace, peer);
      try {
        const [topology, bundle] = await Promise.all([
          client.call('readTextFile', { path: paths.topology }, { signal }),
          client.call('readTextFile', { path: paths.ca }, { signal }),
        ]);
        found.push(parsePeer(peer, topology, bundle));
      } catch (error) {
        this.creds.deps.log.warn(
          'the checkout does not say where this cluster is',
          { sandbox: target.sandbox, peer, error: plain(error) },
        );
      }
    }
    return found;
  }
}

interface CredentialValues {
  github: string;
  kube: string;
  ssh: string;
  sshConfig: string;
}

function file(path: string, content: string) {
  return { path, content, mode: FILE_MODE };
}

function credentialFiles(home: string, values: CredentialValues) {
  return [
    file(`${home}/${TOKEN_PATH}`, values.github),
    file(`${home}/${KUBECONFIG_PATH}`, values.kube),
    file(`${home}/${SSH_KEY_PATH}`, values.ssh),
    file(`${home}/${SSH_CONFIG_PATH}`, values.sshConfig),
  ];
}

/** Absent is empty; anything else unreadable, or over the limit, throws. */
async function readSites(
  client: HandsClient,
  home: string,
  signal: AbortSignal,
): Promise<string> {
  let text: string;
  try {
    text = await client.call(
      'readTextFile',
      { path: `${home}/${SITES_PATH}` },
      { signal },
    );
  } catch (error) {
    const missing =
      error instanceof HandsError &&
      error.detail.kind === 'file' &&
      error.detail.code === 'not_found';
    if (missing) return '';
    throw error;
  }
  if (Buffer.byteLength(text) > SITES_LIMIT_BYTES) {
    throw new Error(`sites.json holds more than ${SITES_LIMIT_BYTES} bytes`);
  }
  return text;
}

function readSitesScript(home: string): string {
  const path = `${home}/${SITES_PATH}`;
  return `[ ! -e ${path} ] || head -c ${SITES_LIMIT_BYTES + 1} ${path}`;
}

/** `work`, given up on after `STAMP_TIMEOUT_MS`, its calls cancelled. */
async function bounded<T>(
  clock: Clock,
  what: string,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: Handle | null = null;
  const expired = new Promise<never>((_, reject) => {
    timer = clock.after(STAMP_TIMEOUT_MS, () => {
      const error = new Error(`${what} took over ${STAMP_TIMEOUT_MS / 1000}s`);
      controller.abort(error);
      reject(error);
    });
  });
  try {
    return await Promise.race([work(controller.signal), expired]);
  } finally {
    if (timer) clock.cancel(timer);
  }
}
