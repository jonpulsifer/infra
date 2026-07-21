import { reactRouter } from '@react-router/dev/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// One ID per build, baked into both the client and server bundles (the config
// is evaluated once for both environments). Kiosk clients compare their
// compiled-in ID against the one the server reports to detect new deployments
// and reload themselves.
const buildId = process.env.GIT_SHA ?? new Date().toISOString();

export default defineConfig({
  plugins: [tailwindcss(), reactRouter()],
  resolve: { tsconfigPaths: true },
  define: { __BUILD_ID__: JSON.stringify(buildId) },
});
