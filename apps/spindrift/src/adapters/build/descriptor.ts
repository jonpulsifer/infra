import type { z } from 'zod';
import type { GitHubApp } from '../../integrations/github/app.ts';
import type { TokenProvider } from '../deploy/kubernetes/api.ts';
import type { BosunOutbox } from './bosun.ts';
import type { BuildAdapter, BuildLevel } from './contract.ts';

export interface BuildRouteContext {
  readonly manifest: {
    readonly build: { readonly zeroConfigFrontend: string };
    readonly supplyChain: {
      readonly signer: string;
      readonly attestor?: string;
    };
    readonly github: { readonly buildWorkflow: string | null };
  };
  readonly app: GitHubApp | null;
  readonly cloud: TokenProvider;
  readonly token: TokenProvider;
  readonly fetch?: (request: Request) => Promise<Response>;
  readonly env?: Record<string, string | undefined>;
  /**
   * The bosun build route's outbox, or `null` where this process has no
   * database — the same "both halves or nothing" posture
   * `registryCredentials()` takes in `adapters/registry.ts`. `bosunDescriptor`
   * answers `null` from `create` whenever this is absent, exactly as
   * `inClusterDescriptor` does for a missing `token`.
   */
  readonly outbox?: BosunOutbox | null;
}

export interface BuildRouteDescriptor<
  TConfig = any,
  TSchema extends z.ZodObject<any> = z.ZodObject<any>,
> {
  readonly kind: string;
  readonly displayName: string;
  readonly logo: string;
  readonly buildLevel: BuildLevel;
  readonly configSchema: TSchema;
  create(config: TConfig, context: BuildRouteContext): BuildAdapter | null;
}
