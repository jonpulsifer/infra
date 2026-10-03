/**
 * A turn's credentials in its sandbox, through KubeHands on a fake apiserver
 * whose pods run the real daemon under a permissive umask.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { parsePeer, STAMP_TIMEOUT_MS } from '../src/credentials.ts';
import {
  KthxSites,
  parseSites,
  type Sites,
  serialize,
} from '../src/kthx-sites.ts';
import { HANDS_LABEL } from '../src/lease.ts';
import { sandboxLabels, sandboxManifest } from '../src/sandboxes.ts';
import {
  begin,
  cleanUp,
  FakeApp,
  GUILD,
  Hooks,
  INVESTIGATOR,
  OPERATOR,
  type Rig,
  rig,
  SANDBOX_CONFIG,
  THREAD,
  until,
} from './hands-support.ts';
import { FakeClock } from './support.ts';

afterEach(cleanUp);

const C = BACKGROUND_CONTEXT;
const ORIGIN = 'https://kthx.example.test';
const SECRET = 'mate-kthx-sites';
const CA = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n';

interface KubeconfigShape {
  clusters: {
    name: string;
    cluster: { server: string; 'certificate-authority-data'?: string };
  }[];
  users: { name: string; user: { token: string } }[];
  contexts: { name: string; context: { cluster: string; user: string } }[];
  'current-context': string;
}

interface Options {
  app?: FakeApp | null;
  cluster?: boolean;
  reader?: string | null;
  ssh?: string | null;
  talos?: string | null;
  jump?: string;
  peers?: string[];
  kthx?: boolean;
}

function credentialled(opts: Options = {}): Rig & { app: FakeApp | null } {
  const app = opts.app === undefined ? new FakeApp() : opts.app;
  const r = rig({
    config: {
      github: Boolean(app),
      kubeServiceAccount: opts.cluster === false ? null : 'mate-sandbox-admin',
      kubeReaderServiceAccount: opts.reader ?? null,
      kubePeers: opts.peers ?? [],
      ...(opts.jump ? { labJump: opts.jump } : {}),
      kthx: {
        origin: opts.kthx ? ORIGIN : null,
        sitesSecret: SECRET,
      },
    },
    deps: {
      githubApp: app,
      sshKey: opts.ssh ?? null,
      talosconfig: opts.talos ?? null,
    },
  });
  if (opts.kthx) {
    r.hands = r.another({
      kthxSites: new KthxSites({
        kube: r.kube,
        namespace: 'mate',
        secret: SECRET,
        log: r.log,
      }),
    });
  }
  return Object.assign(r, { app });
}

function home(r: Rig, path: string): string {
  return join(r.home, path);
}

function read(r: Rig, path: string): string {
  return readFileSync(home(r, path), 'utf8');
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

/** The hands execs' `writeFiles` calls, oldest first. */
function writes(r: Rig): string[] {
  return r.fake.handsExecs.flatMap((e) =>
    e.stdin.filter((line) => line.includes('"writeFiles"')),
  );
}

async function turn(r: Rig, during?: () => void, profile = OPERATOR) {
  const t = begin(r.hands.thread(THREAD, new Hooks(), profile));
  const result = await t.env.exec('true', undefined, C);
  during?.();
  const summary = await t.lease.finish();
  t.end();
  return { result, summary };
}

describe('the stamp', () => {
  test('writes each file at 0600 in directories at 0700, whatever the umask', async () => {
    const r = credentialled();
    const t = begin(r.hands.thread(THREAD, new Hooks(), OPERATOR));
    expect((await t.env.exec('true', undefined, C)).ok).toBe(true);

    expect(read(r, '.github-token')).toBe('ghs-token-1');
    for (const file of ['.github-token', '.kube/config', '.ssh/id_ed25519']) {
      expect(mode(home(r, file))).toBe(0o600);
    }
    for (const dir of ['.kube', '.ssh']) expect(mode(home(r, dir))).toBe(0o700);

    const kubeconfig = Bun.YAML.parse(
      read(r, '.kube/config'),
    ) as KubeconfigShape;
    expect(kubeconfig['current-context']).toBe('offsite');
    expect(kubeconfig.users).toEqual([
      { name: 'sandbox', user: { token: 'sa-token-1' } },
    ]);
    expect(kubeconfig.clusters.map((c) => c.cluster.server)).toEqual([
      'https://kubernetes.default.svc:443',
    ]);
    expect(read(r, '.kube/config')).not.toContain('insecure-skip-tls-verify');
    const [asked] = r.fake.tokenRequests;
    expect(asked?.audiences).toEqual(['api']);
    expect(asked?.expirationSeconds).toBeGreaterThanOrEqual(600);
    expect(r.metrics.tokenMints).toEqual(['ok']);
    expect(r.metrics.tokenStamps).toEqual(['ok']);
    // Over the hands link, never in an exec's argv.
    for (const exec of r.fake.execs) {
      expect(exec.command.join(' ')).not.toContain('ghs-token-1');
    }
    await t.lease.finish();
  });

  test('replaces a symlink rather than following it, and overwrites a turn later', async () => {
    const r = credentialled();
    const victim = join(r.workspace, 'victim');
    writeFileSync(victim, 'keep me');
    symlinkSync(victim, home(r, '.github-token'));
    await turn(r, () => {
      expect(lstatSync(home(r, '.github-token')).isSymbolicLink()).toBe(false);
      expect(read(r, '.github-token')).toBe('ghs-token-1');
    });
    expect(readFileSync(victim, 'utf8')).toBe('keep me');
    await turn(r, () => {
      expect(read(r, '.github-token')).toBe('ghs-token-2');
    });
  });

  test('an SSH key comes with the client config that finds it', async () => {
    const r = credentialled({ ssh: 'PRIVATE-KEY-BYTES' });
    await turn(r, () => {
      expect(read(r, '.ssh/id_ed25519')).toBe('PRIVATE-KEY-BYTES');
      const config = read(r, '.ssh/config');
      expect(config).toContain('User rowbutt');
      expect(config).toContain(`IdentityFile ${home(r, '.ssh/id_ed25519')}`);
      expect(config).toContain('StrictHostKeyChecking accept-new');
      expect(config).toContain('CanonicalizeHostname always');
      expect(config).toMatch(
        /Host [^\n]*spore\.lolwtf\.ca[^\n]*\n {2}ProxyJump capsule\.lolwtf\.ca/,
      );
      // The jump host is reached directly, not through itself.
      expect(config).not.toMatch(/Host [^\n]*capsule\.lolwtf\.ca/);
      expect(config).not.toContain('riptide');
      expect(config.indexOf('Host *')).toBeGreaterThan(
        config.indexOf('ProxyJump'),
      );
    });
  });

  test('the Lab Net jump host is the one the config names', async () => {
    const r = credentialled({
      ssh: 'PRIVATE-KEY-BYTES',
      jump: 'spore.lolwtf.ca',
    });
    await turn(r, () => {
      const config = read(r, '.ssh/config');
      expect(config).toMatch(
        /Host [^\n]*capsule\.lolwtf\.ca[^\n]*\n {2}ProxyJump spore\.lolwtf\.ca/,
      );
      expect(config).not.toMatch(/Host [^\n]*spore\.lolwtf\.ca/);
    });
  });

  test('a talosconfig is written where talosctl looks, for the operator only', async () => {
    const r = credentialled({ talos: 'TALOSCONFIG-BYTES' });
    await turn(r, () => {
      expect(read(r, '.talos/config')).toBe('TALOSCONFIG-BYTES');
      expect(mode(home(r, '.talos/config'))).toBe(0o600);
      expect(mode(home(r, '.talos'))).toBe(0o700);
    });
    expect(read(r, '.talos/config')).toBe('');

    const investigator = credentialled({
      app: null,
      cluster: false,
      reader: 'mate-sandbox-reader',
      talos: 'TALOSCONFIG-BYTES',
    });
    await turn(
      investigator,
      () => expect(read(investigator, '.talos/config')).toBe(''),
      INVESTIGATOR,
    );
  });

  test('a talosconfig alone is reason enough to stamp', async () => {
    const r = credentialled({ app: null, cluster: false, talos: 'TALOS' });
    const { summary } = await turn(r, () => {
      expect(read(r, '.talos/config')).toBe('TALOS');
    });
    expect(summary.stamped).toBe(true);
  });

  test('no talosconfig, and the file is empty', async () => {
    const r = credentialled();
    await turn(r, () => expect(read(r, '.talos/config')).toBe(''));
  });

  test('no key, and no client config pointing ssh at one', async () => {
    const r = credentialled();
    await turn(r, () => {
      expect(read(r, '.ssh/id_ed25519')).toBe('');
      expect(read(r, '.ssh/config')).toBe('');
    });
  });

  test('a turn answers when nothing can be minted', async () => {
    const r = credentialled();
    (r.app as FakeApp).failMint = new Error('422 from GitHub');
    r.fake.tokenRequestFails = 'no RBAC for serviceaccounts/token';
    const { result } = await turn(r, () => {
      expect(read(r, '.github-token')).toBe('');
      expect(read(r, '.kube/config')).toBe('');
    });
    expect(result.ok).toBe(true);
    expect(r.metrics.tokenMints).toEqual(['mint-failed']);
    expect(r.metrics.tokenStamps).toEqual(['mint-failed']);
    expect(r.app?.revoked).toEqual([]);
    expect(
      r.log.of('could not mint a GitHub token for this turn'),
    ).toHaveLength(1);
    expect(
      r.log.of('could not mint cluster access for this turn'),
    ).toHaveLength(1);
  });

  test('a token that cannot be written is revoked at once', async () => {
    const r = credentialled();
    writeFileSync(home(r, '.ssh'), 'not a directory');
    const t = begin(r.hands.thread(THREAD, new Hooks(), OPERATOR));
    expect((await t.env.exec('true', undefined, C)).ok).toBe(true);
    expect(r.metrics.tokenStamps).toEqual(['stamp-failed']);
    expect(r.app?.revoked).toEqual(['ghs-token-1']);
    await t.lease.finish();
    expect(r.app?.revoked).toEqual(['ghs-token-1']);
  });

  test('with no App, a stamp that fails says nothing about a token', async () => {
    const r = credentialled({ app: null });
    writeFileSync(home(r, '.ssh'), 'not a directory');
    const { result } = await turn(r);
    expect(result.ok).toBe(true);
    expect(
      r.log.of("could not stamp the turn's credentials into the sandbox"),
    ).toHaveLength(1);
    expect(r.metrics.tokenStamps).toEqual([]);
  });

  test('with no App, no account, no key and no kthx, nothing is written', async () => {
    const r = credentialled({ app: null, cluster: false });
    const { summary } = await turn(r);
    expect(summary.stamped).toBe(false);
    expect(writes(r)).toEqual([]);
    expect(existsSync(home(r, '.github-token'))).toBe(false);
    expect(r.fake.tokenRequests).toEqual([]);
  });
});

describe('the peers', () => {
  function describePeer(r: Rig, ca: boolean): void {
    const topology = join(
      r.workspace,
      'clusters/folly/config/cluster-topology.json',
    );
    mkdirSync(dirname(topology), { recursive: true });
    writeFileSync(
      topology,
      JSON.stringify({
        data: {
          API_SERVER_HOSTNAME: 'folly.example.test',
          API_SERVER_PORT: '6443',
        },
      }),
    );
    if (!ca) return;
    const bundle = join(r.workspace, 'terraform/pki/certs/folly-ca-bundle.pem');
    mkdirSync(dirname(bundle), { recursive: true });
    writeFileSync(bundle, CA);
  }

  test('each peer the checkout describes gets a context', async () => {
    const r = credentialled({ peers: ['folly'] });
    describePeer(r, true);
    await turn(r, () => {
      const parsed = Bun.YAML.parse(read(r, '.kube/config')) as KubeconfigShape;
      expect(parsed.clusters.map((c) => c.name)).toEqual(['offsite', 'folly']);
      const folly = parsed.clusters[1]?.cluster;
      expect(folly?.server).toBe('https://folly.example.test:6443');
      expect(
        Buffer.from(
          folly?.['certificate-authority-data'] ?? '',
          'base64',
        ).toString(),
      ).toBe(CA);
      expect(parsed.contexts).toContainEqual({
        name: 'folly',
        context: { cluster: 'folly', user: 'sandbox' },
      });
      expect(parsed['current-context']).toBe('offsite');
    });
  });

  test('a peer with no CA bundle is left out, with a warning', async () => {
    const r = credentialled({ peers: ['folly'] });
    describePeer(r, false);
    await turn(r, () => {
      const parsed = Bun.YAML.parse(read(r, '.kube/config')) as KubeconfigShape;
      expect(parsed.clusters.map((c) => c.name)).toEqual(['offsite']);
    });
    const [warned] = r.log.of(
      'the checkout does not say where this cluster is',
    );
    expect(warned?.fields?.peer).toBe('folly');
    expect(String(warned?.fields?.error)).toContain('folly-ca-bundle.pem');
  });

  test('parsePeer takes only an apiserver URL and a certificate', () => {
    const topology = (data: Record<string, unknown>) =>
      JSON.stringify({ data });
    expect(
      parsePeer(
        'folly',
        topology({ API_SERVER_HOSTNAME: 'a.test', API_SERVER_PORT: '6443' }),
        CA,
      ),
    ).toEqual({ name: 'folly', server: 'https://a.test:6443', ca: CA });
    expect(() => parsePeer('folly', topology({}), CA)).toThrow(/no apiserver/);
    expect(() =>
      parsePeer(
        'folly',
        topology({ API_SERVER_HOSTNAME: 'a b', API_SERVER_PORT: '6443' }),
        CA,
      ),
    ).toThrow(/no apiserver/);
    expect(() =>
      parsePeer(
        'folly',
        topology({ API_SERVER_HOSTNAME: 'a.test', API_SERVER_PORT: '6443' }),
        'not a pem',
      ),
    ).toThrow(/no certificate/);
    expect(() => parsePeer('folly', '{not json', CA)).toThrow();
  });
});

describe('the retire', () => {
  test('blanks every file and revokes the token', async () => {
    const r = credentialled({ ssh: 'PRIVATE-KEY-BYTES', talos: 'TALOS' });
    const { summary } = await turn(r);
    expect(summary.stamped).toBe(true);
    for (const file of [
      '.github-token',
      '.kube/config',
      '.ssh/id_ed25519',
      '.ssh/config',
      '.talos/config',
    ]) {
      expect(read(r, file)).toBe('');
    }
    expect(r.app?.revoked).toEqual(['ghs-token-1']);
    expect(writes(r)).toHaveLength(2);
  });

  test('with the link gone, a one-shot command blanks them with no secret in argv', async () => {
    const r = credentialled({ ssh: 'PRIVATE-KEY-BYTES', talos: 'TALOS-BYTES' });
    const t = begin(r.hands.thread(THREAD, new Hooks(), OPERATOR));
    expect((await t.env.exec('true', undefined, C)).ok).toBe(true);
    const client = t.lease.current();
    if (client) t.lease.drop(client, 'deadline');
    await t.lease.finish();
    t.end();

    const blank = r.fake.execs.find((e) =>
      e.command.some((word) => word.includes('printf %s')),
    );
    expect(blank?.command.slice(0, 2)).toEqual(['/bin/sh', '-c']);
    expect(blank?.command.slice(4)).toEqual(['', '', '', '', '']);
    for (const exec of r.fake.execs) {
      const argv = exec.command.join(' ');
      expect(argv).not.toContain('ghs-token');
      expect(argv).not.toContain('sa-token');
      expect(argv).not.toContain('PRIVATE-KEY-BYTES');
      expect(argv).not.toContain('TALOS-BYTES');
    }
    for (const file of [
      '.github-token',
      '.kube/config',
      '.ssh/id_ed25519',
      '.talos/config',
    ]) {
      expect(read(r, file)).toBe('');
    }
    expect(r.app?.revoked).toEqual(['ghs-token-1']);
  });

  test('a token still minting when the turn is abandoned is revoked as it lands, and never written', async () => {
    const r = credentialled();
    const app = r.app as FakeApp;
    const held = Promise.withResolvers<void>();
    app.hold = held.promise;
    const t = begin(r.hands.thread(THREAD, new Hooks(), OPERATOR));
    const call = t.env.exec('true', undefined, C);
    await until(() => app.asked === 1);
    const abandoning = t.lease.abandon();
    held.resolve();
    await abandoning;
    expect((await call).ok).toBe(false);
    await until(() => app.revoked.length > 0);
    expect(app.revoked).toEqual(['ghs-token-1']);
    expect(r.fake.tokenRequests).toHaveLength(1);
    const stamped = writes(r).filter((line) => /ghs-|sa-token/.test(line));
    expect(stamped).toEqual([]);
  });

  test('a token minted after its stamp gave up is revoked as it lands', async () => {
    const clock = new FakeClock();
    const app = new FakeApp();
    const held = Promise.withResolvers<void>();
    app.hold = held.promise;
    const r = rig({
      config: { github: true },
      deps: { githubApp: app, clock },
    });
    const t = begin(r.hands.thread(THREAD, new Hooks(), OPERATOR));
    const call = t.env.exec('true', undefined, C);
    await until(() => app.asked === 1);
    await clock.advance(STAMP_TIMEOUT_MS);
    expect((await call).ok).toBe(true);
    expect(r.metrics.tokenStamps).toEqual(['stamp-failed']);
    await t.lease.finish();
    t.end();
    expect(app.revoked).toEqual([]);

    held.resolve();
    await until(() => app.revoked.length > 0);
    expect(app.revoked).toEqual(['ghs-token-1']);
    expect(writes(r).filter((line) => line.includes('ghs-token'))).toEqual([]);
  });

  test('the token is revoked even when the blanking fails', async () => {
    const r = credentialled();
    const t = begin(r.hands.thread(THREAD, new Hooks(), OPERATOR));
    expect((await t.env.exec('true', undefined, C)).ok).toBe(true);
    const client = t.lease.current();
    if (client) t.lease.drop(client, 'deadline');
    r.fake.commandFails = 'container not found';
    await t.lease.finish();
    expect(r.log.of("could not clear the turn's credentials")).toHaveLength(1);
    expect(r.app?.revoked).toEqual(['ghs-token-1']);
  });
});

// The CLI's token file is stamped from a Secret on a turn's first tool call
// and read back into it at the end, so a site claimed here outlives the
// sandbox.
describe('the kthx sites', () => {
  const FILE = '.config/kthx/sites.json';

  function held(names: Record<string, string>): Sites {
    return { [ORIGIN]: names };
  }

  function sites(): Rig {
    return credentialled({ app: null, cluster: false, kthx: true });
  }

  function secretPatches(r: Rig) {
    return r.fake.patches.filter((patch) => patch.name === SECRET);
  }

  function stored(r: Rig): Sites {
    return parseSites(r.fake.secretValue(SECRET, 'sites.json') ?? '');
  }

  /** A turn during which the agent leaves `contents` in the CLI's file. */
  function turnLeaving(r: Rig, contents: string | null) {
    return turn(r, () => {
      if (contents === null) return;
      mkdirSync(dirname(home(r, FILE)), { recursive: true });
      writeFileSync(home(r, FILE), contents);
    });
  }

  test('stamps the file from the Secret and blanks it after the turn', async () => {
    const r = sites();
    r.fake.putSecret(SECRET, {
      'sites.json': serialize(held({ blog: 'tok-blog' })),
    });
    const { result } = await turn(r, () => {
      expect(parseSites(read(r, FILE))).toEqual(held({ blog: 'tok-blog' }));
      expect(mode(home(r, FILE))).toBe(0o600);
    });
    expect(result.ok).toBe(true);
    expect(read(r, FILE)).toBe('{}\n');
    expect(secretPatches(r)).toEqual([]);
    expect(r.metrics.siteSyncs).toEqual(['ok', 'ok']);
  });

  test('a site claimed during the turn is saved under mate s own field manager', async () => {
    const r = sites();
    r.fake.putSecret(SECRET, {
      'sites.json': serialize(held({ blog: 'tok-blog' })),
    });
    const before = r.fake.secretRevision(SECRET);
    await turnLeaving(
      r,
      serialize(held({ blog: 'tok-blog', shop: 'tok-shop' })),
    );

    const [patch] = secretPatches(r);
    expect(secretPatches(r)).toHaveLength(1);
    expect(patch?.query).toBe('fieldManager=mate');
    expect(patch?.contentType).toBe('application/merge-patch+json');
    expect(patch?.body.metadata).toEqual({ resourceVersion: before });
    expect(stored(r)).toEqual(held({ blog: 'tok-blog', shop: 'tok-shop' }));
    expect(read(r, FILE)).toBe('{}\n');
    expect(r.metrics.siteSyncs).toEqual(['ok', 'ok']);
    expect(JSON.stringify(r.log.entries)).not.toContain('tok-shop');
  });

  test('a site removed during the turn leaves the ledger, and one claimed elsewhere stays', async () => {
    const r = sites();
    r.fake.putSecret(SECRET, {
      'sites.json': serialize(held({ blog: 'tok-blog', old: 'tok-old' })),
    });
    await turn(r, () => {
      // The agent ran `kthx rm old`; another thread claimed `shop` meanwhile.
      writeFileSync(home(r, FILE), serialize(held({ blog: 'tok-blog' })));
      r.fake.putSecret(SECRET, {
        'sites.json': serialize(
          held({ blog: 'tok-blog', old: 'tok-old', shop: 'tok-shop' }),
        ),
      });
    });
    expect(stored(r)).toEqual(held({ blog: 'tok-blog', shop: 'tok-shop' }));
  });

  test('a save that lands on a moved Secret is folded again', async () => {
    const r = sites();
    r.fake.putSecret(SECRET, {
      'sites.json': serialize(held({ blog: 'tok-blog' })),
    });
    await turn(r, () => {
      writeFileSync(
        home(r, FILE),
        serialize(held({ blog: 'tok-blog', shop: 'tok-shop' })),
      );
      r.fake.secretMovesAfterRead = 1;
    });
    expect(secretPatches(r)).toHaveLength(2);
    expect(
      r.log.of('kthx sites ledger moved under a save; retrying'),
    ).toHaveLength(1);
    expect(stored(r)).toEqual(held({ blog: 'tok-blog', shop: 'tok-shop' }));
    expect(read(r, FILE)).toBe('{}\n');
    expect(r.metrics.siteSyncs).toEqual(['ok', 'ok']);
  });

  test('a failed save leaves the file for the next turn, which heals it', async () => {
    const r = sites();
    r.fake.putSecret(SECRET, {
      'sites.json': serialize(held({ blog: 'tok-blog' })),
    });
    r.fake.secretPatchFails = true;
    const claimed = serialize(held({ blog: 'tok-blog', shop: 'tok-shop' }));
    await turnLeaving(r, claimed);

    // Not blanked: the file is the only copy of the new bearer.
    expect(read(r, FILE)).toBe(claimed);
    expect(stored(r)).toEqual(held({ blog: 'tok-blog' }));
    expect(r.metrics.siteSyncs).toEqual(['ok', 'save-failed']);
    expect(
      r.log.of('could not save the sandbox kthx sites into the ledger'),
    ).toHaveLength(1);

    r.fake.secretPatchFails = false;
    await turn(r, () => {
      expect(parseSites(read(r, FILE))).toEqual(
        held({ blog: 'tok-blog', shop: 'tok-shop' }),
      );
    });
    expect(stored(r)).toEqual(held({ blog: 'tok-blog', shop: 'tok-shop' }));
    expect(r.metrics.siteSyncs).toEqual(['ok', 'save-failed', 'ok', 'ok']);
  });

  test('a second turn that claims nothing keeps every site the first one did', async () => {
    const r = sites();
    r.fake.putSecret(SECRET, { 'sites.json': serialize(held({})) });
    await turnLeaving(r, serialize(held({ blog: 'tok-blog' })));
    expect(stored(r)).toEqual(held({ blog: 'tok-blog' }));
    // Blanked at the end of the turn; an empty file is not a removal.
    expect(read(r, FILE)).toBe('{}\n');
    await turn(r, () => {
      expect(parseSites(read(r, FILE))).toEqual(held({ blog: 'tok-blog' }));
    });
    expect(stored(r)).toEqual(held({ blog: 'tok-blog' }));
    expect(r.metrics.siteSyncs).toEqual(['ok', 'ok', 'ok', 'ok']);
  });

  test('a stamp that fails after the fold is never read as a removal', async () => {
    const r = sites();
    r.fake.putSecret(SECRET, {
      'sites.json': serialize(held({ blog: 'tok-blog', shop: 'tok-shop' })),
    });
    writeFileSync(home(r, '.ssh'), 'not a directory');
    const { result } = await turnLeaving(r, null);
    expect(result.ok).toBe(true);
    expect(stored(r)).toEqual(held({ blog: 'tok-blog', shop: 'tok-shop' }));
    expect(secretPatches(r)).toEqual([]);
    expect(r.metrics.siteSyncs).toEqual(['ok', 'ok']);
  });

  test('a file over the limit is read-failed and never saved over', async () => {
    const r = sites();
    r.fake.putSecret(SECRET, {
      'sites.json': serialize(held({ blog: 'tok-blog' })),
    });
    const huge = serialize(held({ blog: 'tok-blog', big: 'x'.repeat(70_000) }));
    await turnLeaving(r, huge);
    expect(read(r, FILE)).toBe(huge);
    expect(stored(r)).toEqual(held({ blog: 'tok-blog' }));
    expect(r.metrics.siteSyncs).toEqual(['ok', 'read-failed']);
    const [entry] = r.log.of('could not read the sandbox kthx sites file');
    expect(String(entry?.fields?.error)).toContain('more than');
  });

  test('a corrupt file is left alone and never saved over', async () => {
    const r = sites();
    r.fake.putSecret(SECRET, {
      'sites.json': serialize(held({ blog: 'tok-blog' })),
    });
    await turnLeaving(r, '{not json');
    expect(read(r, FILE)).toBe('{not json');
    expect(secretPatches(r)).toEqual([]);
    expect(r.metrics.siteSyncs).toEqual(['ok', 'read-failed']);
    expect(r.log.of('could not read the sandbox kthx sites file')).toHaveLength(
      1,
    );
  });

  test('a missing Secret is logged and the turn still answers', async () => {
    const r = sites();
    const { result } = await turnLeaving(r, null);
    expect(result.ok).toBe(true);
    // Nothing to stamp, so the file is not written at all.
    expect(existsSync(home(r, FILE))).toBe(false);
    expect(r.metrics.siteSyncs).toEqual(['save-failed', 'save-failed']);
    const [entry] = r.log.of(
      'could not save the sandbox kthx sites into the ledger',
    );
    expect(entry?.fields?.error).toContain('not found');
  });

  test('a release keeps what the sandbox still holds', async () => {
    const r = sites();
    r.fake.putSecret(SECRET, {
      'sites.json': serialize(held({ blog: 'tok-blog' })),
    });
    r.fake.secretPatchFails = true;
    await turnLeaving(
      r,
      serialize(held({ blog: 'tok-blog', shop: 'tok-shop' })),
    );
    r.fake.secretPatchFails = false;

    await r.hands.release(THREAD, 'quiet');
    expect(r.fake.sandboxes.size).toBe(0);
    expect(stored(r)).toEqual(held({ blog: 'tok-blog', shop: 'tok-shop' }));
    expect(r.metrics.siteSyncs.at(-1)).toBe('ok');
  });

  test('a release of something already gone is still not an error', async () => {
    const r = sites();
    await r.hands.release(THREAD, 'quiet');
    expect(r.log.entries.filter((e) => e.level !== 'info')).toEqual([]);
    expect(r.metrics.siteSyncs).toEqual([]);
  });

  test('a sandbox an earlier mate left keeps its sites before boot condemns it', async () => {
    const r = sites();
    r.fake.putSecret(SECRET, {
      'sites.json': serialize(held({ blog: 'tok-blog' })),
    });
    const labels = sandboxLabels(THREAD, GUILD, OPERATOR);
    delete labels[HANDS_LABEL];
    const response = await r.kube.request(
      '/apis/agents.x-k8s.io/v1beta1/namespaces/mate/sandboxes',
      {
        method: 'POST',
        body: sandboxManifest({
          name: 'mate-older',
          namespace: 'mate',
          labels,
          config: SANDBOX_CONFIG,
          shutdownTime: new Date(Date.now() + 3_600_000).toISOString(),
          profile: OPERATOR,
        }),
      },
    );
    expect(response.status).toBe(201);
    mkdirSync(dirname(home(r, FILE)), { recursive: true });
    writeFileSync(
      home(r, FILE),
      serialize(held({ blog: 'tok-blog', shop: 'tok-shop' })),
    );

    expect(await r.hands.start()).toEqual([]);
    await until(() => !r.fake.sandboxes.has('mate-older'));
    expect(stored(r)).toEqual(held({ blog: 'tok-blog', shop: 'tok-shop' }));
    expect(r.metrics.teardowns).toEqual(['inherited']);
  });

  test('with no origin, nothing reads the file or the Secret', async () => {
    const r = credentialled();
    await turn(r);
    expect(r.fake.requests.some((q) => q.path.includes('/secrets/'))).toBe(
      false,
    );
    for (const line of writes(r)) expect(line).not.toContain('sites.json');
    expect(r.metrics.siteSyncs).toEqual([]);
  });
});

// A read-only profile's turn gets the reader's cluster token and nothing else,
// whatever mate holds.
describe('a read-only turn', () => {
  const FILE = '.config/kthx/sites.json';
  const HOSTILE = serialize({ [ORIGIN]: { blog: 'tok-attacker' } });

  function everything(reader: string | null): Rig & { app: FakeApp | null } {
    const r = credentialled({
      ssh: 'PRIVATE-KEY-BYTES',
      peers: ['folly'],
      kthx: true,
      reader,
    });
    r.fake.putSecret(SECRET, {
      'sites.json': serialize({ [ORIGIN]: { blog: 'tok-blog' } }),
    });
    return r;
  }

  test('stamps the reader token for its own turn length, and blanks the rest', async () => {
    const r = everything('mate-sandbox-reader');
    const ledger = r.fake.secretRevision(SECRET);
    const { summary } = await turn(
      r,
      () => {
        expect(read(r, '.github-token')).toBe('');
        expect(read(r, '.ssh/id_ed25519')).toBe('');
        expect(read(r, '.ssh/config')).toBe('');
        const parsed = Bun.YAML.parse(
          read(r, '.kube/config'),
        ) as KubeconfigShape;
        expect(parsed.users).toEqual([
          { name: 'sandbox', user: { token: 'sa-token-1' } },
        ]);
        expect(existsSync(home(r, FILE))).toBe(false);
        // The agent leaves a file that would overwrite the ledger's bearer.
        mkdirSync(dirname(home(r, FILE)), { recursive: true });
        writeFileSync(home(r, FILE), HOSTILE);
      },
      INVESTIGATOR,
    );
    expect(summary.stamped).toBe(true);
    expect(
      r.fake.tokenRequests.map(({ account, expirationSeconds }) => ({
        account,
        expirationSeconds,
      })),
    ).toEqual([{ account: 'mate-sandbox-reader', expirationSeconds: 1500 }]);
    expect(r.app?.asked).toBe(0);
    expect(r.metrics.tokenMints).toEqual([]);
    expect(r.metrics.tokenStamps).toEqual([]);
    // Never read, written or folded: the file is left as the agent left it.
    expect(read(r, FILE)).toBe(HOSTILE);
    expect(r.metrics.siteSyncs).toEqual([]);
    expect(r.fake.secretRevision(SECRET)).toBe(ledger);
    expect(r.fake.patches.filter((p) => p.name === SECRET)).toEqual([]);
    for (const line of writes(r)) expect(line).not.toContain('sites.json');
    for (const file of ['.github-token', '.kube/config', '.ssh/id_ed25519']) {
      expect(read(r, file)).toBe('');
    }
  });

  test('with no reader account, nothing is minted or written', async () => {
    const r = everything(null);
    const { summary } = await turn(r, undefined, INVESTIGATOR);
    expect(summary.stamped).toBe(false);
    expect(r.fake.tokenRequests).toEqual([]);
    expect(r.app?.asked).toBe(0);
    expect(writes(r)).toEqual([]);
    expect(existsSync(home(r, '.kube/config'))).toBe(false);
    expect(r.metrics.siteSyncs).toEqual([]);
  });

  test('an operator turn on the same mate still gets the admin, the token and the key', async () => {
    const r = everything('mate-sandbox-reader');
    await turn(r, () => {
      expect(read(r, '.github-token')).toBe('ghs-token-1');
      expect(read(r, '.ssh/id_ed25519')).toBe('PRIVATE-KEY-BYTES');
    });
    expect(r.fake.tokenRequests.map((q) => q.account)).toEqual([
      'mate-sandbox-admin',
    ]);
    expect(r.fake.tokenRequests[0]?.expirationSeconds).toBe(600);
    expect(r.metrics.siteSyncs).toEqual(['ok', 'ok']);
  });
});
