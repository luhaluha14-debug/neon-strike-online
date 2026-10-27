import { defineConfig } from 'vite';

// GRID_API_PROXY=http://127.0.0.1:8080 npm run dev: /api goes to a local
// account server (npm run start). Without it there is no /api: the game runs
// on its offline GRID record.
const apiProxy = process.env.GRID_API_PROXY;

export default defineConfig({
  server: { host: true, port: 5173, ...(apiProxy ? { proxy: { '/api': { target: apiProxy } } } : {}) },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1200,
  },
});
