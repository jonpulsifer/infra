/**
 * `configureInstallation` writes this installation's whole manifest: a document
 * is valid or it is not, so there is no patch form. With no revision column,
 * two concurrent editors lose one edit to the second save.
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
     * `unknown`, so {@link validateManifest} names every bad key instead of the
     * Zod refusal. A string is a restored export, parsed as YAML.
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
   * Each declared Target as `<vessel>/<adapter>`, in manifest order. Writing a
   * manifest can create Targets nobody named, so the confirmation lists them.
   */
  readonly targets: readonly string[];
}

export const configureInstallation: Command<
  ConfigureInstallationInput,
  ConfigureInstallationResult
> = async (input, context) => {
  // The document carries `auth.gateway`, which decides who counts as a human
  // at the next boot, so a bearer credential must not be able to write it.
  if (context.principal.kind !== 'human') {
    return failed(
      'FORBIDDEN',
      'an agent token cannot change the installation — sign in and save it from Settings',
    );
  }

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

  // Boot refuses auth.gateway unless the deployment attests that a policy
  // strips identity headers, so saving it here would wedge the next restart.
  const boundary = trustedGatewayRefusal({
    auth: manifest.auth,
    boundary: context.manifest.boundary,
  });
  if (boundary !== null) {
    return failed('NOT_DEPLOYABLE', boundary);
  }

  await writeStoredManifest(context.db, manifest);

  return ok({
    installation: manifest.installation.name,
    targets: manifest.targets.map(targetLabel),
  });
};

/**
 * Re-exported so callers check a document against the schema the command uses.
 */
export { installationManifestSchema };
