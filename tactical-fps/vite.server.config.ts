import { defineConfig } from 'vite';

// Bundles the account server (server/main.ts + the shared src/economy rules)
// for Node: `npm run build:server` → dist-server/main.js. Only `pg` stays an
// external dependency. Nothing here is part of the client bundle.
export default defineConfig({
  publicDir: false,
  build: {
    ssr: 'server/main.ts',
    outDir: 'dist-server',
    emptyOutDir: true,
    target: 'node20',
    sourcemap: true,
    rollupOptions: { output: { entryFileNames: 'main.js' } },
  },
  ssr: { external: ['pg'] },
});
