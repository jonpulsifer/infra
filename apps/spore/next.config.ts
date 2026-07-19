import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  cacheComponents: true,
  output: 'standalone',
  serverExternalPackages: ['better-sqlite3'],
  // Next 16.2 typechecks via the TS JS API, which TS 7 omits until 7.1.
  // Type safety is enforced by the standalone `tsc --noEmit` (bun run typecheck).
  typescript: {
    ignoreBuildErrors: true,
  },
};

export default nextConfig;
