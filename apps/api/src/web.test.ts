import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from './app.js';
import { loadEnv } from './config/env.js';

const env = loadEnv({
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  DATABASE_URL: 'postgres://centinela:centinela@localhost:5433/centinela',
  JWT_SECRET: 'secreto-de-pruebas-unitarias-con-32-caracteres',
});

/**
 * Panel compilado al estilo de producción: la API sirve las rutas del SPA
 * (index.html) y los ficheros estáticos, pero no tapa el 404 de la API ni el
 * de las superficies públicas. Sin raíz de panel (desarrollo), no hay SPA.
 */
describe('panel compilado', () => {
  let webRoot: string;
  let app: ReturnType<typeof buildServer>;

  beforeAll(async () => {
    webRoot = await mkdtemp(path.join(tmpdir(), 'centinela-web-'));
    await mkdir(path.join(webRoot, 'assets'));
    await writeFile(path.join(webRoot, 'index.html'), '<html><body>panel de prueba</body></html>');
    await writeFile(path.join(webRoot, 'assets', 'app.js'), 'console.log("panel")');

    app = buildServer({ env, webRoot });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await rm(webRoot, { recursive: true, force: true });
  });

  it('sirve el index para las rutas del panel (SPA)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/monitores/abc',
      headers: { accept: 'text/html' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('panel de prueba');
  });

  it('sirve los ficheros estáticos', async () => {
    const response = await app.inject({ method: 'GET', url: '/assets/app.js' });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('panel');
  });

  it('no tapa el 404 de la API ni el de las superficies públicas', async () => {
    const api = await app.inject({
      method: 'GET',
      url: '/api/desconocido',
      headers: { accept: 'text/html' },
    });
    expect(api.statusCode).toBe(404);
    expect(api.json()).toMatchObject({ error: 'Not Found', statusCode: 404 });

    const status = await app.inject({
      method: 'GET',
      url: '/status/nada',
      headers: { accept: 'text/html' },
    });
    expect(status.statusCode).toBe(404);
  });

  it('sin raíz de panel (desarrollo) no hay SPA', async () => {
    const sinPanel = buildServer({ env, webRoot: null });

    try {
      const response = await sinPanel.inject({
        method: 'GET',
        url: '/monitores/abc',
        headers: { accept: 'text/html' },
      });
      expect(response.statusCode).toBe(404);
    } finally {
      await sinPanel.close();
    }
  });
});
