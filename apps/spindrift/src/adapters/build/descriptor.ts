import type { z } from 'zod';
import type { GitHubApp } from '../../integrations/github/app.ts';
import type { TokenProvider } from '../deploy/kubernetes/api.ts';
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
