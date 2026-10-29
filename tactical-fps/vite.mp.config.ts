import { defineConfig } from 'vite';

// Bundles the multiplayer relay (server/mp/main.ts) for Node:
// `npm run build:mp` → dist-mp/main.js. Only `ws` stays an external dependency.
export default defineConfig({
  publicDir: false,
  build: {
    ssr: 'server/mp/main.ts',
    outDir: 'dist-mp',
    emptyOutDir: true,
    target: 'node20',
    sourcemap: true,
    rollupOptions: { output: { entryFileNames: 'main.js' } },
  },
  ssr: { external: ['ws'] },
});
