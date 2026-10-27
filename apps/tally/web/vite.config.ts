import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  plugins: [tailwindcss(), react()],
  resolve: { tsconfigPaths: true },
  server: {
    proxy: { '/api': 'http://localhost:8081' },
  },
  preview: {
    proxy: { '/api': 'http://localhost:8081' },
  },
});
