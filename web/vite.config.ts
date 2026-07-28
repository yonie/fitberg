import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Dev server proxies the API to the Node server so cookies and relative
    // fetches behave exactly as they do in production.
    proxy: {
      '/api': {
        target: process.env.FITBERG_API || 'http://localhost:8710',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // MapLibre is large; splitting it keeps the initial dashboard load small,
    // which matters when the server is a Raspberry Pi on a home connection.
    rollupOptions: {
      output: {
        manualChunks: {
          maplibre: ['maplibre-gl'],
          react: ['react', 'react-dom', 'react-router-dom'],
        },
      },
    },
    chunkSizeWarningLimit: 1200,
  },
});
