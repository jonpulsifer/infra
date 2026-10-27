import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// PROTOTYPE: the tally UI prototype. Three variants of the whole app on one
// route, switchable with ?variant=a|b|c. See src/prototype/README.md.
export default defineConfig({
  base: './',
  plugins: [tailwindcss(), react()],
  resolve: { tsconfigPaths: true },
});
