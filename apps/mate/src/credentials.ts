/**
 * A turn's credentials in its sandbox: minted on the turn's first tool call,
 * written over the hands link with `writeFiles`, and blanked when the turn
 * ends. The thread's profile grants each one: a credential it does not grant
 * is written empty. Nothing
 * outlives the turn: the GitHub token is revoked whatever happens, and the
 * cluster token expires on its own.
 */
import { type Clock, type Handle, systemClock } from './clock.ts';
import type { SandboxConfig } from './config.ts';
import { HARNESS_CONTAINER, type HandsClient } from './hands.ts';
import type { HandsTarget } from './hands-env.ts';
import type { ExecClose, Kube } from './kube.ts';
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
// talosctl's default path under HOME, so no env points at it.
export const TALOSCONFIG_PATH = '.talos/config';
const SSH_DIR = '.ssh';
const SSH_KEY_PATH = `${SSH_DIR}/id_ed25519`;
const SSH_CONFIG_PATH = `${SSH_DIR}/config`;
// A one-shot command's output is a few small lines.
const OUTPUT_LIMIT_BYTES = 64 * 1024;

// folly's Anchor network has no route from offsite, so its hosts are reached through
// a jump host that offsite routes to and the folly firewall admits on 22:
// MATE_SANDBOX_LAB_JUMP. optiplex, folly's only control plane, is never it.
const LAB_NET_HOSTS = ['spore', 'capsule', 'forge', 'cloudpi4', 'homepi4'];
const LAB_DOMAIN = 'lolwtf.ca';

// `always` canonicalizes a short name before the Host blocks match, proxied
// or not. accept-new: home is a fresh emptyDir with no known hosts, so `yes`
// refuses every host, and `no` would accept a changed key.
export function sshClientConfig(home: string, jump: string): string {
  // A jump host on the Anchor network is reached directly, or ssh would jump through it
  // to reach itself.
  const proxied = LAB_NET_HOSTS.map((host) => `${host}.${LAB_DOMAIN}`).filter(
    (host) => host !== jump && host !== `${jump}.${LAB_DOMAIN}`,
  );
  return [
    'CanonicalizeHostname always',
    `CanonicalDomains ${LAB_DOMAIN}`,
    'CanonicalizeMaxDots 0',
    'CanonicalizeFallbackLocal yes',
    '',
    `Host ${proxied.join(' ')}`,
    `  ProxyJump ${jump}`,
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
    ca: `${workspace}/clusters/${peer}/config/kubernetes-ca.pem`,
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
  readonly clusterCa?: string | null;
  readonly sshKey?: string | null;
  /** The `os:reader` talosconfig, with a context per cluster; `null` until the Secret exists. */
  readonly talosconfig?: string | null;
  /** Where one-shot commands write, with no daemon to say where home is. */
  readonly home?: string;
}

interface Minted {
  github: string | null;
  cluster: string | null;
}

/** The credentials of every sandbox. */
export class Credentials {
  readonly clock: Clock;

  constructor(readonly deps: CredentialDeps) {
    this.clock = deps.clock ?? systemClock;
  }

  /** Whether a turn under `grants` has anything to write at all. */
  credentialled(grants: Grants): boolean {
    const { githubApp, config, sshKey, talosconfig } = this.deps;
    return Boolean(
      (grants.github && githubApp) ||
        kubeAccount(config, grants.kube) ||
        (grants.ssh && sshKey) ||
        (grants.talos && talosconfig),
    );
  }

  turn(profile: Profile): TurnCredentials {
    return new TurnCredentials(
      this,
      profile.grants,
      turnTimeoutMs(profile, this.deps.config.turnTimeoutMs),
    );
  }

  get home(): string {
    return this.deps.home ?? AGENT_HOME;
  }

  /**
   * Blanks every credential file with one command. Values go in argv, since
   * the stream cannot half-close stdin, so every one is empty: argv reaches
   * the apiserver audit log.
   */
  async blank(pod: string): Promise<void> {
    const home = this.home;
    await this.command(pod, [
      '/bin/sh',
      '-c',
      [
        'umask 077',
        `mkdir -p ${home}/${SSH_DIR} "$(dirname ${home}/${KUBECONFIG_PATH})" "$(dirname ${home}/${TALOSCONFIG_PATH})"`,
        `printf %s "$1" > ${home}/${TOKEN_PATH}`,
        `printf %s "$2" > ${home}/${KUBECONFIG_PATH}`,
        `printf %s "$3" > ${home}/${SSH_KEY_PATH}`,
        `printf %s "$4" > ${home}/${SSH_CONFIG_PATH}`,
        `printf %s "$5" > ${home}/${TALOSCONFIG_PATH}`,
      ].join('; '),
      'mate',
      '',
      '',
      '',
      '',
      '',
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
        if (size > OUTPUT_LIMIT_BYTES) {
          stream.close();
          throw new Error(
            `${command[0]} printed more than ${OUTPUT_LIMIT_BYTES} bytes`,
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
        const ssh = grants.ssh ? (creds.deps.sshKey ?? '') : '';
        const talos = grants.talos ? (creds.deps.talosconfig ?? '') : '';
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
                sshConfig: ssh
                  ? sshClientConfig(home, creds.deps.config.labJump)
                  : '',
                talos,
              }),
            ],
            dirMode: DIR_MODE,
          },
          { signal },
        );
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
   * one-shot command carrying no secret. Never throws.
   */
  async retire(target: HandsTarget, client: HandsClient | null): Promise<void> {
    const { creds } = this;
    if (!this.stamped) return;
    try {
      await bounded(creds.clock, 'blanking credentials', async (signal) => {
        if (client && !client.isClosed) {
          const { home } = client.hello;
          await client.call(
            'writeFiles',
            {
              files: [
                ...credentialFiles(home, {
                  github: '',
                  kube: '',
                  ssh: '',
                  sshConfig: '',
                  talos: '',
                }),
              ],
              dirMode: DIR_MODE,
            },
            { signal },
          );
          return;
        }
        await creds.blank(target.pod);
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
  talos: string;
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
    file(`${home}/${TALOSCONFIG_PATH}`, values.talos),
  ];
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
