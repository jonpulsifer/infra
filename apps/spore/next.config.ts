import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  basePath: '/spore',
  output: 'standalone',
  serverExternalPackages: ['better-sqlite3'],
};

export default nextConfig;
