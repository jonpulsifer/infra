/**
 * `listStagedBundles` — the bundles this installation has staged (§4, §15).
 *
 * The third thing the Storage screen is about, and the one that makes the other
 * two legible. §15 stages **one immutable bundle** per source before any route
 * sees it, and §16 joins the source receipt and the provenance document on its
 * digest — so the bundle is the identity everything else in the supply chain is
 * hung from, and until now it appeared nowhere an operator could look.
 *
 * **A bundle is an input, not a release.** It is what a builder is handed, and
 * the artifact that comes back is pushed to a registry. The one bundle that is
 * also deployable is §4's supplied artifact — an archive of *finished output*,
 * recorded as-is with no builder — and that row is the exception the listing
 * has to make visible rather than the rule it should be named after.
 *
 * `deployable` is derived from what actually happened rather than from what was
 * declared: a Build that reached `SUCCEEDED` with no `runner` is a Build no
 * route ran, which is exactly `dispatchBuild`'s supplied-artifact arm. Reading
 * the App's declared archive contents instead would report a bundle deployable
 * on the strength of a claim made before anything was staged.
 *
 * Retention comes from the App's source kind, which is where `source-bundle.ts`
 * puts it: an upload is durable and a repository fetch is ephemeral. It is the
 * fact that decides whether the location under a row still resolves.
 *
 * `builds.bundle_location` is read but nothing here fetches it — a listing that
 * asked Cloud Storage per row would be a screen slow in proportion to how much
 * has ever been staged, and the row a depot has since reaped is still the
 * durable record of what was built.
 */
import { isNotNull } from 'drizzle-orm';
import { z } from 'zod';
import { isFetchableBundleLocation } from '../../storage/archives.ts';
import { type Command, ok } from '../types.ts';

/** How many bundles a listing answers with before it is a data-export problem. */
export const BUNDLE_PAGE = 50;

export const listStagedBundlesInput = z
  .object({
    limit: z.number().int().positive().max(BUNDLE_PAGE).optional(),
  })
  .strict();

export type ListStagedBundlesInput = z.infer<typeof listStagedBundlesInput>;

/** Whether a bundle survives its build, per `source-bundle.ts`. */
export type BundleRetention = 'durable' | 'ephemeral';

/** One staged bundle, as the Storage screen reads it. */
export interface StagedBundleView {
  /** §16's join: the digest over the exact staged bytes. */
  readonly digest: string;
  /** Where it is fetched from, or `null` for a Build that recorded none. */
  readonly location: string | null;
  /** Whether any build route could actually be handed that location. */
  readonly fetchable: boolean;
  readonly retention: BundleRetention;
  readonly app: string;
  readonly component: string;
  readonly buildId: number;
  readonly artifactType: string;
  readonly status: string;
  /**
   * §4's supplied artifact: finished output recorded with no builder, and so
   * the one bundle that is deployed rather than built.
   */
  readonly deployable: boolean;
  /** The route that ran, or `null` where none did. */
  readonly runner: string | null;
  readonly at: string;
}

export interface ListStagedBundlesResult {
  readonly bundles: readonly StagedBundleView[];
  /** What the page is capped at, so a full page reads as one rather than as all. */
  readonly limit: number;
}

export const listStagedBundles: Command<
  ListStagedBundlesInput,
  ListStagedBundlesResult
> = async (input, context) => {
  const limit = input.limit ?? BUNDLE_PAGE;
  const rows = await context.db.query.builds.findMany({
    where: (builds) => isNotNull(builds.bundleDigest),
    orderBy: (builds, { desc }) => [desc(builds.id)],
    limit,
    with: { component: { with: { app: true } } },
  });

  return ok({
    limit,
    bundles: rows.map((row) => ({
      // Non-null by the predicate above; the column is nullable for Builds that
      // have not staged anything yet, and those are precisely what is filtered.
      digest: row.bundleDigest ?? '',
      location: row.bundleLocation,
      fetchable: isFetchableBundleLocation(row.bundleLocation),
      retention:
        row.component.app.sourceKind === 'archive' ? 'durable' : 'ephemeral',
      app: row.component.app.name,
      component: row.component.name,
      buildId: row.id,
      artifactType: row.artifactType,
      status: row.status,
      deployable: row.status === 'SUCCEEDED' && row.runner === null,
      runner: row.runner,
      at: row.createdAt.toISOString(),
    })),
  });
};
