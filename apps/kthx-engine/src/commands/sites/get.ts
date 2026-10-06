import { z } from 'zod';
import type { KthxSite, KthxSiteDetail } from '../../adapters/kthx.ts';
import { elapsedSince } from '../../domain/elapsed.ts';
import { type Command, type CommandContext, failed, ok } from '../types.ts';
import type { SiteListItem, SiteResult, SiteView } from '../views.ts';
import { siteName } from './name.ts';

export const getSiteInput = z
  .object({ name: siteName })
  .strict()
  .describe('Read one kthx site: its releases, usage and quotas.');
export type GetSiteInput = z.infer<typeof getSiteInput>;

export const getSite: Command<GetSiteInput, SiteResult> = async (
  input,
  context,
) => {
  const kthx = context.adapters.kthx?.() ?? null;
  if (kthx === null) {
    return failed('NOT_FOUND', 'this installation does not read kthx sites');
  }
  const read = await kthx.getSite(input.name);
  if (!read.ok) return ok({ state: 'unreadable', reason: read.reason });
  if (read.value === 'missing') {
    return failed('NOT_FOUND', `there is no kthx site named ${input.name}`);
  }
  return ok({ state: 'ok', site: siteView(read.value, context) });
};

/**
 * Hiding the owner from agents is hygiene, not a boundary: anyone who can mint
 * the engine's token or read kthx's database sees it.
 */
export function siteListItem(
  site: KthxSite,
  context: CommandContext,
): SiteListItem {
  return {
    name: site.name,
    url: site.url,
    ...(context.principal.kind === 'human' ? { owner: site.owner } : {}),
    release: site.serving,
    held: site.held,
    createdAt: site.created,
    ...(site.deployed === null
      ? {}
      : {
          at: site.deployed,
          when: elapsedSince(new Date(site.deployed), context.clock.now()),
        }),
  };
}

function siteView(site: KthxSiteDetail, context: CommandContext): SiteView {
  return {
    ...siteListItem(site, context),
    provisioned: site.provisioned,
    releases: site.releases,
    usage: site.usage,
    quotas: site.quotas,
  };
}
