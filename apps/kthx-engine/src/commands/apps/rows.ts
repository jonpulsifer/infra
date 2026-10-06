import { z } from 'zod';
import { siteListItem } from '../sites/get.ts';
import { siteName } from '../sites/name.ts';
import { type Command, ok } from '../types.ts';
import type { AppRowsView, AppRowView } from '../views.ts';
import { appListItems } from './list.ts';

const SITES_PER_PAGE = 50;

export const listAppRowsInput = z
  .object({
    after: siteName.optional(),
    limit: z.int().min(1).max(200).optional(),
  })
  .strict()
  .describe(
    'List every App: built Apps first, then a page of kthx sites. Pass `after` for the next page of sites only.',
  );
export type ListAppRowsInput = z.infer<typeof listAppRowsInput>;

export const listAppRows: Command<ListAppRowsInput, AppRowsView> = async (
  input,
  context,
) => {
  const kthx = context.adapters.kthx?.() ?? null;
  const [apps, page] = await Promise.all([
    input.after === undefined ? appListItems(context) : [],
    kthx?.listSites({
      after: input.after ?? null,
      limit: input.limit ?? SITES_PER_PAGE,
    }) ?? null,
  ]);
  const appRows = apps.map(
    (app): AppRowView => ({ kind: 'app', key: app.id, app }),
  );

  if (page === null) {
    return ok({ rows: appRows, sites: { state: 'off' }, next: null });
  }
  if (!page.ok) {
    return ok({
      rows: appRows,
      sites: { state: 'unreadable', reason: page.reason },
      next: null,
    });
  }
  const siteRows = page.value.items.map(
    (site): AppRowView => ({
      kind: 'site',
      key: `site:${site.name}`,
      site: siteListItem(site, context),
    }),
  );
  return ok({
    rows: [...appRows, ...siteRows],
    sites: { state: 'ok', total: page.value.total },
    next: page.value.next,
  });
};
