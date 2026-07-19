import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  cacheComponents: true,
  logging: {
    fetches: {
      fullUrl: true,
      hmrRefreshes: true,
    },
  },
  output: process.env.STANDALONE ? 'standalone' : undefined,
  // Next 16.2 typechecks via the TS JS API, which TS 7 omits until 7.1.
  // Type safety is enforced by the standalone `tsc --noEmit` (bun run typecheck).
  typescript: {
    ignoreBuildErrors: true,
  },
};

export default nextConfig;
