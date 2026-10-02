/**
 * `getDeveloperSurfaces`: where a developer points a tool. Read from the
 * deployment's facts alone, so it reaches nothing and the browser never calls
 * kthx to draw the Developer pages.
 */
import { z } from 'zod';
import { UNSERVED_HOSTNAME } from '../../config/manifest.ts';
import { type Command, ok } from '../types.ts';

export const getDeveloperSurfacesInput = z
  .object({})
  .strict()
  .describe(
    "Read where the developer surfaces answer: this MCP endpoint's private and public addresses, and kthx's origin and zone. Changes nothing.",
  );
export type GetDeveloperSurfacesInput = z.infer<
  typeof getDeveloperSurfacesInput
>;

export interface DeveloperSurfaces {
  readonly adminMcp: {
    /** `null` when the deployment names no host of its own. */
    readonly private: string | null;
    /** `null` without a public host for the machine routes. */
    readonly public: string | null;
  };
  /** `null` when the installation names no kthx. */
  readonly kthx: { readonly origin: string; readonly zone: string } | null;
}

export const getDeveloperSurfaces: Command<
  GetDeveloperSurfacesInput,
  DeveloperSurfaces
> = async (_input, context) => {
  const { hostname, publicHostname } = context.manifest.controlPlane;
  const kthx = context.adapters.kthx?.() ?? null;
  return ok({
    adminMcp: {
      private:
        hostname === UNSERVED_HOSTNAME ? null : `https://${hostname}/mcp`,
      public: publicHostname === null ? null : `https://${publicHostname}/mcp`,
    },
    kthx: kthx === null ? null : { origin: kthx.origin, zone: kthx.zone },
  });
};
