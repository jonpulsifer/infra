/**
 * The labels an App mints under kthx's site zone. kthx holds them for the App
 * before an edit stores a name or a Deploy routes one, so an App never takes a
 * site's name and a site never takes an App's.
 */
import type { KthxClient, KthxTaken } from '../../adapters/kthx.ts';
import { type DnsZones, isLabel } from '../../domain/naming.ts';
import { type CommandResult, failed } from '../types.ts';
import { namesUnder, type Placement } from './names.ts';

/**
 * Each host's single label under `zone`, de-duplicated and sorted. The apex and
 * dotted or over-long prefixes are left out: kthx can never serve them as a site.
 */
export function kthxLabels(
  hostnames: readonly (string | undefined)[],
  zone: string,
): string[] {
  const suffix = `.${zone.toLowerCase()}`;
  const labels = new Set<string>();
  for (const host of hostnames) {
    const name = host?.toLowerCase();
    if (name === undefined || !name.endsWith(suffix)) continue;
    const label = name.slice(0, -suffix.length);
    if (isLabel(label)) labels.add(label);
  }
  return [...labels].sort();
}

/**
 * The labels every placement would mint. `namesUnder` puts the vanity name on
 * each placement, though only the sole serving Component carries it, so this
 * reserves a little more than is routed. That costs nothing.
 */
export function kthxNamesOf(
  appName: string,
  placements: readonly Pick<Placement, 'component' | 'reach' | 'adapter'>[],
  zones: DnsZones,
  pinned: string | null,
  vanityLabel: string | null,
  zone: string,
): string[] {
  return kthxLabels(
    placements.flatMap((placement) =>
      namesUnder(appName, placement, zones, pinned, vanityLabel),
    ),
    zone,
  );
}

/**
 * Reserves `labels` for the App, or the failure an edit returns. `subject`
 * opens the sentence, and `path` names the input that would mint them.
 */
export async function reserveForEdit<Output>(
  kthx: KthxClient,
  appId: string,
  labels: readonly string[],
  input: { readonly path: string; readonly subject: string },
): Promise<CommandResult<Output> | null> {
  if (labels.length === 0) return null;
  const reserved = await kthx.reserve(appId, labels);
  if (!reserved.ok) {
    return failed(
      'NOT_DEPLOYABLE',
      `kthx could not reserve ${hostsOf(labels, kthx.zone)} (${reserved.reason}); nothing changed`,
    );
  }
  if (reserved.value.length === 0) return null;
  const rules = reserved.value.map(
    (taken) =>
      `would take ${taken.name}.${kthx.zone}, which ${holderOf(taken)} holds`,
  );
  return failed(
    'INVALID_INPUT',
    `${input.subject} ${rules.join('; ')}`,
    rules.map((rule) => ({ path: input.path, message: rule })),
  );
}

function holderOf(taken: KthxTaken): string {
  return taken.by === 'site' ? 'a kthx site' : 'another App';
}

function hostsOf(labels: readonly string[], zone: string): string {
  return labels.map((label) => `${label}.${zone}`).join(', ');
}

/**
 * The deploy-time backstop for names no edit sees: canonical names, and vanity
 * names stored before the hook. `null` when kthx holds every name for the App.
 */
export async function kthxRefusal(
  kthx: KthxClient,
  appId: string,
  hostname: { readonly canonical: string; readonly vanity?: string },
): Promise<string | null> {
  const labels = kthxLabels([hostname.canonical, hostname.vanity], kthx.zone);
  if (labels.length === 0) return null;
  const reserved = await kthx.reserve(appId, labels);
  if (!reserved.ok) {
    const verb = labels.length === 1 ? 'is' : 'are';
    return `kthx could not confirm ${hostsOf(labels, kthx.zone)} ${verb} this App's (${reserved.reason}); deploy again once it answers`;
  }
  if (reserved.value.length === 0) return null;
  return reserved.value
    .map((taken) => {
      const host = `${taken.name}.${kthx.zone}`;
      const isVanity = host === hostname.vanity?.toLowerCase();
      const which = isVanity ? "this App's vanity name" : 'the canonical name';
      const fix = isVanity
        ? "change the App's vanity name"
        : 'rename the Component';
      const or = taken.by === 'site' ? ' or remove the site' : '';
      return `${host} (${which}) is held by ${holderOf(taken)} — ${fix}${or}`;
    })
    .join('; ');
}
