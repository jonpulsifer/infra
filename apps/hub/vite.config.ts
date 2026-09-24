import { reactRouter } from '@react-router/dev/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// The config is evaluated once for both bundles, so client and server share the
// ID. Kiosks reload when the server reports a different one.
const buildId = process.env.GIT_SHA ?? new Date().toISOString();

export default defineConfig({
  plugins: [tailwindcss(), reactRouter()],
  resolve: { tsconfigPaths: true },
  define: { __BUILD_ID__: JSON.stringify(buildId) },
});
