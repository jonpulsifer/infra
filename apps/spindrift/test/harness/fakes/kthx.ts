/** A `KthxClient` that records each reservation call and reads no sites. */
import type {
  KthxClient,
  KthxRead,
  KthxSiteDetail,
  KthxSitePage,
  KthxTaken,
} from '../../../src/adapters/kthx.ts';
import type { InstallationManifest } from '../../../src/config/manifest.ts';

export const KTHX_ZONE = 'kthx.example.test';

/**
 * The manifest with kthx's zone serving both reaches. `first`: an unpinned App
 * falls into it; `last`: only a pin reaches it.
 */
export function withKthxZone(
  manifest: InstallationManifest,
  where: 'first' | 'last',
): InstallationManifest {
  const kthx: InstallationManifest['dns']['zones'][number] = {
    name: KTHX_ZONE,
    reaches: ['private', 'public'],
  };
  const zones = manifest.dns.zones;
  return {
    ...manifest,
    dns: { zones: where === 'first' ? [kthx, ...zones] : [...zones, kthx] },
  };
}

export interface FakeKthxOptions {
  /** Labels kthx answers as held by someone else. */
  readonly taken?: readonly KthxTaken[];
  /** When set, every reservation call fails with this reason. */
  readonly unreadable?: string;
}

export interface RecordedKthxCall {
  readonly holder: string;
  readonly labels: readonly string[] | null;
}

export class FakeKthx implements KthxClient {
  readonly zone = KTHX_ZONE;
  readonly reserved: RecordedKthxCall[] = [];
  readonly released: RecordedKthxCall[] = [];
  /** Every call in order, as `reserve` or `release`. */
  readonly calls: string[] = [];

  constructor(private readonly options: FakeKthxOptions = {}) {}

  async listSites(): Promise<KthxRead<KthxSitePage>> {
    throw new Error('a name hook listed sites');
  }

  async getSite(): Promise<KthxRead<KthxSiteDetail | 'missing'>> {
    throw new Error('a name hook read a site');
  }

  async reserve(
    holder: string,
    labels: readonly string[],
  ): Promise<KthxRead<readonly KthxTaken[]>> {
    this.calls.push('reserve');
    this.reserved.push({ holder, labels });
    if (this.options.unreadable !== undefined) {
      return { ok: false, reason: this.options.unreadable };
    }
    return {
      ok: true,
      value: (this.options.taken ?? []).filter((taken) =>
        labels.includes(taken.name),
      ),
    };
  }

  async release(
    holder: string,
    labels: readonly string[] | null,
  ): Promise<KthxRead<readonly string[]>> {
    this.calls.push('release');
    this.released.push({ holder, labels });
    if (this.options.unreadable !== undefined) {
      return { ok: false, reason: this.options.unreadable };
    }
    return { ok: true, value: [] };
  }
}
