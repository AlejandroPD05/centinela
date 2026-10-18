import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// En desarrollo, todo lo que no es el panel va a la API (4100): los mismos
// caminos que en producción comparten origen (status, badges, widget, fuentes).
const api = 'http://127.0.0.1:4100';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 4101,
    proxy: {
      '/api': api,
      '/assets': api,
      '/status': api,
      '/badge': api,
      '/embed': api,
    },
  },
});
