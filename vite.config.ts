import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Relative asset URLs: the built site works from any folder or port
  // (e.g. http://<ip>:8080/ or http://<ip>/nexus/) with no server config.
  base: './',
  server: {
    port: 5173,
    // `npm run dev` talks to a real controller:  NEXUS_BACKEND=http://192.168.1.70:8080 npm run dev
    proxy: { '/api': process.env.NEXUS_BACKEND ?? 'http://192.168.1.70:8080' }
  }
});
