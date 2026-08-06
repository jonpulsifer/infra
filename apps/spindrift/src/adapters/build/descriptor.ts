import type { z } from 'zod';
import type { InstallationManifest } from '../../config/manifest.schema.ts';
import type { GitHubApp } from '../../integrations/github/app.ts';
import type { TokenProvider } from '../../storage/signed-url.ts';
import type { BuildAdapter, BuildLevel } from './contract.ts';

export interface BuildRouteContext {
  readonly manifest: InstallationManifest;
  readonly app: GitHubApp | null;
  readonly cloud: TokenProvider;
  readonly fetch?: (request: Request) => Promise<Response>;
  readonly env?: Record<string, string | undefined>;
  readonly token?: string;
}

export interface BuildRouteDescriptor<TConfig = any> {
  readonly kind: string;
  readonly displayName: string;
  readonly logo: string;
  readonly buildLevel: BuildLevel;
  readonly configSchema: z.ZodTypeAny;
  create(config: TConfig, context: BuildRouteContext): BuildAdapter | null;
}
