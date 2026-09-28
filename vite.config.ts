import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// The API server (src/server/main.ts) listens on PORT (default 4750). In dev, Vite serves the UI on
// 4751 and proxies /api to it; in production the API server serves the built UI itself on one port.
const apiPort = Number(process.env.PORT ?? 4750);

export default defineConfig({
  root: 'src/web',
  publicDir: 'public',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
    sourcemap: true,
    chunkSizeWarningLimit: 1500,
  },
  server: {
    host: '127.0.0.1',
    port: 4751,
    strictPort: true,
    proxy: { '/api': `http://127.0.0.1:${apiPort}` },
  },
});
