import { defineConfig } from 'vite';
import { randomUUID } from 'node:crypto';
import { RELEASE } from './src/release-notes.js';

const manifest = { schema: 1, buildId: process.env.GITHUB_SHA || randomUUID(), ...RELEASE };

export default defineConfig({
  define: { __APP_BUILD_ID__: JSON.stringify(manifest.buildId) },
  plugins: [{
    name: 'app-release-manifest',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url?.split('?')[0] !== '/version.json') return next();
        response.setHeader('Content-Type', 'application/json');
        response.setHeader('Cache-Control', 'no-store');
        response.end(JSON.stringify(manifest));
      });
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify(manifest) });
    },
  }],
  base: './',
  publicDir: 'public',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
