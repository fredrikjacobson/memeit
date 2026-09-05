import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    // onnxruntime-web ships its own wasm bundles — let it load them at runtime
    exclude: ['onnxruntime-web', '@imgly/background-removal'],
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3001',
    },
    // Cross-origin isolation unlocks multi-threaded WASM (SharedArrayBuffer)
    // for onnxruntime — ~2-4x faster AI segmentation on multi-core machines.
    // Safe with COEP require-corp: same-origin assets are unaffected, the
    // proxied /api is same-origin, and the @imgly model CDN serves
    // `Access-Control-Allow-Origin: *` + `Cross-Origin-Resource-Policy:
    // cross-origin`. If you serve `dist/` elsewhere (nginx, static host),
    // send these same two headers there or inference falls back to 1 thread.
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  preview: {
    port: 5173,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
});
