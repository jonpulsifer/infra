/**
 * `getInstallationManifest` — read what {@link configureInstallation} writes.
 *
 * An editing surface has to start from the document it is about to replace,
 * and `configureInstallation` takes the whole document rather than a patch, so
 * a form that guessed at the keys it did not render would delete them. This is
 * the read half of that pair, and the two are deliberately symmetric: what this
 * answers is exactly what that accepts.
 *
 * That symmetry is why the context manifest is projected through
 * {@link toAuthoredManifest} rather than answered as it is. A reader is given
 * the resolved document — the authored one plus the deployment facts joined
 * around it — and the write half takes only what may be authored. Answering the
 * resolved document made the form refuse its own round trip with
 * `cloud: Unrecognized key: "federation"` on a field it never rendered, which
 * is the shape of bug this pair exists to make impossible.
 *
 * **It reads the context, not the database.** `CommandContext.manifest` is
 * resolved per dispatch — that is the whole reason the context factory is
 * async — so the row is already the source of this answer, and querying it a
 * second time would only add a way for the two to disagree. It also keeps this
 * command free of any server-only import, which matters more than it looks:
 * the command registry is reachable from the browser bundle, so a read command
 * that reached for the store would put the store in the client build.
 *
 * **Nothing here is secret.** §13 keeps credentials out of the manifest by
 * construction — every adapter's access path is resolved per request, and no
 * variant of any route or connection carries key material — so the document is
 * platform configuration, and the surface is session-authenticated regardless.
 *
 * **`manifestDivergence` rides along for the same reason `manifest` does.**
 * `loadStoredManifest` already detects a mounted declaration that disagrees
 * with the stored row and says so — once, in a pod log, at boot. §6: "drift is
 * detected and surfaced, never silently corrected" does not stop at the log;
 * an operator who opens this screen weeks after the rollout that caused the
 * disagreement is exactly who needed to see it and exactly who cannot. It is
 * read off `context.manifestDivergence` rather than recomputed here for the
 * same reason `manifest` is: recomputing it would mean reading the mounted
 * declaration a second time, which needs `Bun.file` and puts this command back
 * in the shape it exists to avoid.
 */
import { z } from 'zod';
import {
  type AuthoredManifest,
  toAuthoredManifest,
} from '../../config/manifest.schema.ts';
import { isPlaceholderInstallation } from '../../config/manifest.ts';
import { type Command, ok } from '../types.ts';

export const getInstallationManifestInput = z.object({}).strict();

export type GetInstallationManifestInput = z.infer<
  typeof getInstallationManifestInput
>;

export interface GetInstallationManifestResult {
  readonly manifest: AuthoredManifest;
  /**
   * Dotted paths where a mounted declaration disagrees with the manifest
   * above, or `[]` when nothing is mounted or the two agree. Paths only —
   * see `manifest-store.ts`'s `diffManifestPaths` for why a value never rides
   * along with one.
   */
  readonly manifestDivergence: readonly string[];
  /**
   * Whether anybody has configured this installation, or it is still the
   * placeholder `loadStoredManifest` seeds an unseeded row with.
   *
   * Answered here rather than by a command of its own because the caller that
   * needs it — the browser deciding between onboarding and the product — needs
   * the document in the same breath, and a second command would be a second
   * round trip to learn two halves of one answer that can be inconsistent
   * between them.
   *
   * Current by construction, for the reason above: `context.manifest` is
   * resolved per dispatch, and {@link isPlaceholderInstallation} is a pure
   * function of it. So the dispatch that follows a `configureInstallation`
   * answers `true`, and onboarding ends because the installation is configured
   * rather than because a screen decided it was finished.
   */
  readonly configured: boolean;
}

export const getInstallationManifest: Command<
  GetInstallationManifestInput,
  GetInstallationManifestResult
> = async (_input, context) => {
  const manifest = toAuthoredManifest(context.manifest);
  return ok({
    manifest,
    manifestDivergence: context.manifestDivergence ?? [],
    // The authored document, not the resolved one: the deployment's federation
    // is joined onto `context.manifest` per read, and comparing that against a
    // constant that cannot carry it would answer `configured` for every
    // installation, including the one that has configured nothing.
    configured: !isPlaceholderInstallation(manifest),
  });
};
