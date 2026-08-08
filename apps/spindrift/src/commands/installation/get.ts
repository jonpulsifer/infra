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
 * **`declarationDivergence` rides along for the same reason `manifest` does.**
 * `loadStoredManifest` already detects a mounted declaration that disagrees
 * with the stored row and says so — once, in a pod log, at boot. §6: "drift is
 * detected and surfaced, never silently corrected" does not stop at the log;
 * an operator who opens this screen weeks after the rollout that caused the
 * disagreement is exactly who needed to see it and exactly who cannot. It is
 * read off `context.declarationDivergence` rather than recomputed here for the
 * same reason `manifest` is: recomputing it would mean reading the mounted
 * declaration a second time, which needs `Bun.file` and puts this command back
 * in the shape it exists to avoid. Named `declarationDivergence` rather than
 * `manifestDivergence` because `targets/list.ts:135`'s `connectionDivergence`
 * used to share that name for a different comparison — a Target's row against
 * its own manifest entry, not this pair.
 *
 * **`declaration` answers the same document as a whole, not only the paths it
 * disagrees at.** That is what turns "an operator can see a merge did not
 * land" into "an operator can put it on the row": the whole document is
 * exactly `configureInstallation`'s input type, so a caller of both commands
 * in sequence adopts the mounted declaration with no assembly of its own —
 * `views/auth/installation.tsx`'s adopt action is exactly that sequence. This
 * does not weaken the paths-only promise `declarationDivergence` keeps —
 * `diffManifestPaths` still only ever answers a path — it rests instead on the
 * guarantee the paragraph above already spends: §13 keeps every manifest
 * variant credential-free by construction, which is the whole reason this
 * command may answer `manifest` itself rather than only facts about it. Two
 * documents under that one guarantee, not two guarantees.
 */
import { z } from 'zod';
import {
  type AuthoredManifest,
  toAuthoredManifest,
} from '../../config/manifest.schema.ts';
import {
  governingDeclaration,
  isUnconfiguredInstallation,
} from '../../config/manifest.ts';
import { type Command, ok } from '../types.ts';

export const getInstallationManifestInput = z.object({}).strict();

export type GetInstallationManifestInput = z.infer<
  typeof getInstallationManifestInput
>;

export interface GetInstallationManifestResult {
  readonly manifest: AuthoredManifest;
  /**
   * The mounted declaration, whole — or `null` where none is mounted, one is
   * unreadable, or this installation runs with no declaration at all.
   *
   * `configureInstallation` takes exactly this type, so this is the whole of
   * what an adopt action needs: read this command, send its `declaration`
   * straight to that one. Not projected or reduced the way `manifest` is
   * documented above not to need — `context.declaration` is already parsed
   * into `AuthoredManifest`, the type this command's own `manifest` field is
   * and the type `configureInstallation` accepts, so there is nothing here
   * for a round trip to disagree about.
   */
  readonly declaration: AuthoredManifest | null;
  /**
   * Whether that declaration takes the governed slice back on every boot.
   *
   * `false` for no declaration, and — the case this field exists for — `false`
   * for a declaration that is the chart's stand-in, which governs nothing
   * (`governingDeclaration`). The editing surface reads it to decide whether to
   * lock the two vessels' fields, and it must reach the same answer
   * `configureInstallation` will: a field locked against a write that would
   * have been accepted is a screen refusing on the server's behalf and getting
   * it wrong, which on a chart-only installation is the wizard refusing the
   * only two values it exists to collect.
   *
   * A boolean rather than the predicate itself, because answering it needs
   * `DEFAULT_PLACEHOLDER_MANIFEST` and the module that holds it is not one the
   * client bundle may import.
   */
  readonly declarationGoverns: boolean;
  /**
   * Dotted paths where {@link declaration} disagrees with the manifest above,
   * or `[]` when nothing is mounted or the two agree. Paths only — see
   * `manifest-store.ts`'s `diffManifestPaths` for why a value never rides
   * along with one.
   */
  readonly declarationDivergence: readonly string[];
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
}

export const getInstallationManifest: Command<
  GetInstallationManifestInput,
  GetInstallationManifestResult
> = async (_input, context) => {
  const manifest = toAuthoredManifest(context.manifest);
  return ok({
    manifest,
    declaration: context.declaration ?? null,
    declarationGoverns: governingDeclaration(context.declaration) !== null,
    declarationDivergence: context.declarationDivergence ?? [],
    // The authored document, not the resolved one: the deployment's federation
    // is joined onto `context.manifest` per read, and the predicate reads keys
    // an authored document is the only place to state.
    configured: !isUnconfiguredInstallation(manifest),
  });
};
