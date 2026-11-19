import { defineConfig } from 'vite';

// Builds the SPA straight into ../public (the web root), next to index.php/.htaccess.
export default defineConfig({
  base: '/',
  build: {
    outDir: '../public',
    emptyOutDir: false,
    assetsDir: 'assets',
    sourcemap: false,
    target: 'es2022',
  },
  server: {
    proxy: { '/api': 'http://localhost:8080' },
  },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.ts'],
  },
});
