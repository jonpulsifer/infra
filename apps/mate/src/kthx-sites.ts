/**
 * The kthx CLI's `sites.json` (origin → site name → bearer), kept in a Secret
 * between sandboxes. A site claimed in a sandbox has its only bearer in that
 * sandbox's home until this ledger has it.
 */
import { type Kube, KubeError, type KubeObject, kubeError } from './kube.ts';
import type { Log } from './log.ts';

export type Sites = Record<string, Record<string, string>>;

export const SITES_KEY = 'sites.json';
// The Secret is declared in git with no data; Flux's server-side apply
// leaves a field another manager owns alone.
export const FIELD_MANAGER = 'mate';
const SAVE_ATTEMPTS = 3;
const MERGE_PATCH = 'application/merge-patch+json';

export type SyncResult = 'ok' | 'read-failed' | 'save-failed';

type Secret = KubeObject<undefined> & { data?: Record<string, string> };

/**
 * A corrupt file throws, as the CLI's own reader does: the tokens in it are
 * not known to be lost, so nothing must be saved over them.
 */
export function parseSites(text: string): Sites {
  if (!text.trim()) return {};
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) throw new Error('sites.json is not an object');
  const sites: Sites = {};
  for (const [origin, names] of Object.entries(parsed)) {
    if (!isRecord(names))
      throw new Error(`sites.json: ${origin} is not an object`);
    for (const token of Object.values(names)) {
      if (typeof token !== 'string') {
        throw new Error(`sites.json: ${origin} holds a non-string token`);
      }
    }
    sites[origin] = { ...(names as Record<string, string>) };
  }
  return sites;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The ledger once a sandbox's file is read back. `stamped` is what mate wrote
 * at the turn's start; a name it held that the file no longer does was
 * removed, and one the file holds with a token `stamped` lacks was claimed.
 * A name only the ledger holds was claimed elsewhere and stays.
 */
export function reconcile(
  ledger: Sites,
  stamped: Sites,
  harvested: Sites,
): Sites {
  const next: Sites = {};
  for (const [origin, names] of Object.entries(ledger)) {
    next[origin] = { ...names };
  }
  for (const origin of new Set([
    ...Object.keys(stamped),
    ...Object.keys(harvested),
  ])) {
    const before = stamped[origin] ?? {};
    const after = harvested[origin] ?? {};
    const names = next[origin] ?? {};
    for (const [name, token] of Object.entries(before)) {
      // Only the token that was stamped: a re-claim elsewhere is not a removal.
      if (!(name in after) && names[name] === token) delete names[name];
    }
    for (const [name, token] of Object.entries(after)) {
      if (before[name] !== token) names[name] = token;
    }
    if (Object.keys(names).length > 0) next[origin] = names;
    else delete next[origin];
  }
  return next;
}

/** Sorted keys, so two ledgers holding the same tokens serialise the same. */
export function serialize(sites: Sites): string {
  const sorted: Sites = {};
  for (const origin of Object.keys(sites).sort()) {
    const names = sites[origin] ?? {};
    sorted[origin] = Object.fromEntries(
      Object.keys(names)
        .sort()
        .map((name) => [name, names[name] as string]),
    );
  }
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

export interface KthxSitesDeps {
  kube: Kube;
  /** mate's own namespace: the Secret is never in the sandbox namespace. */
  namespace: string;
  secret: string;
  log: Log;
}

export class KthxSites {
  constructor(private readonly deps: KthxSitesDeps) {}

  get secret(): string {
    return this.deps.secret;
  }

  /** The ledger and the revision a save must carry. */
  async load(): Promise<{ sites: Sites; resourceVersion: string }> {
    const secret = await this.deps.kube.json<Secret>(this.path());
    const raw = secret.data?.[SITES_KEY];
    const sites = raw
      ? parseSites(Buffer.from(raw, 'base64').toString('utf8'))
      : {};
    return { sites, resourceVersion: secret.metadata.resourceVersion ?? '' };
  }

  /**
   * Folds a sandbox's file into the ledger. A stale revision means another
   * turn saved first, so the fold is redone on what it saved.
   */
  async merge(stamped: Sites, harvested: Sites): Promise<Sites> {
    for (let attempt = 1; ; attempt += 1) {
      const { sites, resourceVersion } = await this.load();
      const next = reconcile(sites, stamped, harvested);
      if (serialize(next) === serialize(sites)) return sites;
      try {
        await this.save(next, resourceVersion);
        return next;
      } catch (error) {
        const stale = error instanceof KubeError && error.status === 409;
        if (!stale || attempt >= SAVE_ATTEMPTS) throw error;
        this.deps.log.info('kthx sites ledger moved under a save; retrying', {
          secret: this.deps.secret,
          attempt,
        });
      }
    }
  }

  private async save(sites: Sites, resourceVersion: string): Promise<void> {
    const response = await this.deps.kube.request(this.path(), {
      method: 'PATCH',
      query: { fieldManager: FIELD_MANAGER },
      contentType: MERGE_PATCH,
      body: {
        metadata: { resourceVersion },
        data: { [SITES_KEY]: Buffer.from(serialize(sites)).toString('base64') },
      },
    });
    if (!response.ok) throw await kubeError(response);
    await response.body?.cancel().catch(() => {});
  }

  private path(): string {
    return `/api/v1/namespaces/${this.deps.namespace}/secrets/${this.deps.secret}`;
  }
}
