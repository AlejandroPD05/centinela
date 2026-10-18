import { defineConfig, devices } from '@playwright/test';
import { API_PORT, VICTIM_PORT, WEB_PORT } from './support/ports.mjs';

/**
 * Pruebas de extremo a extremo: base efímera, API real (con worker), servidor
 * víctima y el panel servido por Vite con el proxy apuntando a esta API. Todo
 * corre en puertos propios para no pisar el entorno de desarrollo.
 */
export default defineConfig({
  testDir: './tests',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: './results',
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
  },
  webServer: [
    {
      command: 'node support/api.mjs',
      url: `http://127.0.0.1:${API_PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 180_000,
    },
    {
      command: 'node support/victim.mjs',
      url: `http://127.0.0.1:${VICTIM_PORT}/control/status`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: `node node_modules/vite/bin/vite.js --port ${WEB_PORT} --strictPort --host 127.0.0.1`,
      cwd: '../web',
      url: `http://127.0.0.1:${WEB_PORT}/login`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: { CENTINELA_API: `http://127.0.0.1:${API_PORT}` },
    },
  ],
});
