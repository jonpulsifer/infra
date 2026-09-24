/**
 * `getInstallationManifest` reads the authored manifest from the per-dispatch
 * context. The browser bundle reaches the command registry, so this takes no
 * server-only import. Safe to return whole: the manifest holds no credentials;
 * access paths resolve per request.
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
   * False while the genuine choices are still the stand-ins
   * `loadStoredManifest` seeds an unseeded row with.
   */
  readonly configured: boolean;
  /** `controlPlane.version`, for the shell's footer. */
  readonly version: string | null;
}

export const getInstallationManifest: Command<
  GetInstallationManifestInput,
  GetInstallationManifestResult
> = async (_input, context) => {
  // Authored, not resolved: `configureInstallation` refuses the deployment
  // facts joined onto the context, and the predicate reads authored keys only.
  const manifest = toAuthoredManifest(context.manifest);
  return ok({
    manifest,
    configured: !isUnconfiguredInstallation(manifest),
    version: context.manifest.controlPlane.version,
  });
};
