/**
 * `configureInstallation` — write this installation's manifest (§20).
 *
 * §20 makes the manifest the place everything naming an installation lives, and
 * `manifest-store.ts` has always said the point of storing it durably is "so
 * the UI can drive all configuration dynamically". Until this command there was
 * no hand to drive it with: the seed path was the only writer of the row in the
 * codebase, so a value seeded wrong stayed wrong for the life of the
 * installation, and the only remedies were destroying the database or editing
 * Postgres by hand.
 *
 * **The whole document, not a patch.** A manifest is one document that is valid
 * or is not — `validateManifest` reports every offending key at once precisely
 * because a half-configured installation must not reach the point where it can
 * place a workload. A patch interface would have to decide what a partially
 * valid document means, and the answer §20 wants is that there is no such
 * thing.
 *
 * **Named cost: two operators editing concurrently lose one of the edits.**
 * There is no revision column on `installation` and this command does not
 * invent one, so the second save wins whole. `STALE_EDIT` exists for exactly
 * this shape and is deliberately not used yet: an installation has one manifest
 * and, today, one authenticated operator editing it from one screen. The moment
 * a second editing surface exists this needs a revision, and that is a schema
 * change rather than a change of mind here.
 */
import { z } from 'zod';
import {
  type AuthoredManifest,
  installationManifestSchema,
} from '../../config/manifest.schema.ts';
import {
  ManifestError,
  parseManifest,
  trustedGatewayRefusal,
  validateManifest,
} from '../../config/manifest.ts';
import { writeStoredManifest } from '../../config/manifest-store.ts';
import { targetLabel } from '../../domain/target.ts';
import { type Command, failed, ok } from '../types.ts';

export const configureInstallationInput = z
  .object({
    /**
     * The manifest document, parsed but not yet validated — or the text of one.
     *
     * `unknown` rather than the schema itself, so a bad document is refused by
     * {@link validateManifest} with every offending key named, instead of by
     * the dispatch layer's generic input refusal with a Zod path. The operator
     * is editing configuration; the sentence they read has to be about their
     * configuration.
     *
     * **A string is a document somebody is restoring**, from a file this
     * installation exported before it was torn down. It is parsed here rather
     * than in the browser because `parseManifest` is the same reader every
     * other document goes through — a second parser in the client bundle would
     * be a second answer to "is this a manifest", and the one that matters is
     * the server's. YAML, and therefore JSON, so the file the export writes
     * reads back unchanged.
     */
    manifest: z.unknown(),
  })
  .strict();

export type ConfigureInstallationInput = z.infer<
  typeof configureInstallationInput
>;

export interface ConfigureInstallationResult {
  readonly installation: string;
  /**
   * The Targets the written manifest declares, in its own order — which is
   * §16's admin rank — each as `<vessel>/<adapter>`. Returned because writing a
   * manifest is the one act that can create a Target without anyone naming one,
   * and a confirmation that did not say so would hide it.
   */
  readonly targets: readonly string[];
}

export const configureInstallation: Command<
  ConfigureInstallationInput,
  ConfigureInstallationResult
> = async (input, context) => {
  let manifest: AuthoredManifest;
  try {
    manifest =
      typeof input.manifest === 'string'
        ? parseManifest(input.manifest, 'the restored document')
        : validateManifest(input.manifest, 'the submitted manifest');
  } catch (cause) {
    if (cause instanceof ManifestError) {
      return failed('INVALID_INPUT', cause.message);
    }
    throw cause;
  }

  // What this screen can write that the next restart cannot serve.
  // `auth.gateway` is refused at boot without the deployment's attestation that
  // a policy strips identity headers, so a document setting it here saved
  // cleanly and wedged the web process the next time a pod restarted — hours
  // later, with nothing connecting the two. `NOT_DEPLOYABLE` rather than
  // `INVALID_INPUT`: nothing in the document is malformed, and no amount of
  // re-typing makes this deployment able to honour it.
  const boundary = trustedGatewayRefusal({
    auth: manifest.auth,
    boundary: context.manifest.boundary,
  });
  if (boundary !== null) {
    return failed('NOT_DEPLOYABLE', boundary);
  }

  // **Reconciliation makes no refusal of its own.** It used to make exactly one
  // — a declared Target whose adapter disagreed with the stored row's — and that
  // state stopped being expressible when the adapter became half of what
  // identifies a Target: a seed naming a different one names a different Target,
  // not a redefinition of this one. Everything left that a document can get
  // wrong is a key, and `validateManifest` above names it.
  await writeStoredManifest(context.db, manifest);

  return ok({
    installation: manifest.installation.name,
    targets: manifest.targets.map(targetLabel),
  });
};

/**
 * Re-exported so a caller that wants to check a document before sending it uses
 * the same schema the command validates against, rather than a copy that can
 * drift from it.
 */
export { installationManifestSchema };
