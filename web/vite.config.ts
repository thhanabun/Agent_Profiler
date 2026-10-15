import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  root: import.meta.dirname,
  plugins: [tailwindcss()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    cors: false,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4180',
        changeOrigin: true,
        configure(proxy) {
          proxy.on('proxyReq', (request, incoming) => {
            // Preserve the host's origin boundary through the local dev proxy.
            if (incoming.headers.host !== '127.0.0.1:5173' ||
                incoming.headers.origin && incoming.headers.origin !== 'http://127.0.0.1:5173') {
              request.destroy(new Error('Unexpected development origin.'));
              return;
            }
            request.setHeader('origin', 'http://127.0.0.1:4180');
          });
        },
      },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
