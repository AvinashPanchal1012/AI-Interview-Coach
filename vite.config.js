import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development, Vite forwards /api requests to the Express server,
// so the browser sees one origin and no CORS problems.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:5000', changeOrigin: true },
    },
  },
});
