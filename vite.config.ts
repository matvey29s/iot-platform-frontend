import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Relative asset URLs: the built site works from any folder or port
  // (e.g. http://<ip>:8080/ or http://<ip>/nexus/) with no server config.
  base: './',
  server: { port: 5173 }
});
