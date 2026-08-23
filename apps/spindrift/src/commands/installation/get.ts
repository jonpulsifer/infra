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
 */
import { z } from 'zod';
import {
  type AuthoredManifest,
  toAuthoredManifest,
} from '../../config/manifest.schema.ts';
import { isUnconfiguredInstallation } from '../../config/manifest.ts';
import { type Command, ok } from '../types.ts';

export const getInstallationManifestInput = z.object({}).strict();

export type GetInstallationManifestInput = z.infer<
  typeof getInstallationManifestInput
>;

export interface GetInstallationManifestResult {
  readonly manifest: AuthoredManifest;
  /**
   * Whether anybody has answered this installation's genuine choices, or they
   * are still the stand-ins `loadStoredManifest` seeds an unseeded row with.
   *
   * Answered here rather than by a command of its own because the caller that
   * needs it — the browser deciding between onboarding and the product — needs
   * the document in the same breath, and a second command would be a second
   * round trip to learn two halves of one answer that can be inconsistent
   * between them.
   *
   * Current by construction, for the reason above: `context.manifest` is
   * resolved per dispatch, and {@link isUnconfiguredInstallation} is a pure
   * function of it, so the dispatch that follows a `configureInstallation`
   * already reads the row that write left.
   *
   * **The browser does not wait for that dispatch, and this is where the two
   * part.** `app.tsx` moves to the product when the wizard reports a saved
   * document rather than re-reading this command, which costs a round trip on
   * every completed onboarding to re-learn what the write just proved. The
   * price of not paying it is the corner the predicate names: an operator who
   * confirms all four stand-ins unchanged gets the product now and the wizard
   * on the next load, because the write was real and configured nothing.
   */
  readonly configured: boolean;
  /**
   * What the answering process is running (`controlPlane.version`), for the
   * shell's footer. A deployment fact, so it rides the one read the browser
   * already makes about this installation rather than a channel of its own.
   */
  readonly version: string | null;
}

export const getInstallationManifest: Command<
  GetInstallationManifestInput,
  GetInstallationManifestResult
> = async (_input, context) => {
  const manifest = toAuthoredManifest(context.manifest);
  return ok({
    manifest,
    // The authored document, not the resolved one: the deployment's federation
    // is joined onto `context.manifest` per read, and the predicate reads keys
    // an authored document is the only place to state.
    configured: !isUnconfiguredInstallation(manifest),
    version: context.manifest.controlPlane.version,
  });
};
