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
 */
import { z } from 'zod';
import {
  type AuthoredManifest,
  toAuthoredManifest,
} from '../../config/manifest.schema.ts';
import { type Command, ok } from '../types.ts';

export const getInstallationManifestInput = z.object({}).strict();

export type GetInstallationManifestInput = z.infer<
  typeof getInstallationManifestInput
>;

export interface GetInstallationManifestResult {
  readonly manifest: AuthoredManifest;
}

export const getInstallationManifest: Command<
  GetInstallationManifestInput,
  GetInstallationManifestResult
> = async (_input, context) =>
  ok({ manifest: toAuthoredManifest(context.manifest) });
