import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// In development (`npm run dev`) the API server listens on PORT (default 4760) and Vite serves the UI
// on 4761, proxying /api to it. Built, the API server serves the UI itself on one port (the live
// service on 4750, `npm run demo` on 4770).
const apiPort = Number(process.env.PORT ?? 4760);

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
    port: 4761,
    strictPort: true,
    proxy: { '/api': `http://127.0.0.1:${apiPort}` },
  },
});
