import { afterAll, describe, expect, it } from 'vitest';
import { buildServer } from '../app.js';
import { loadEnv } from '../config/env.js';

const env = loadEnv({
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  DATABASE_URL: 'postgres://centinela:centinela@localhost:5433/centinela',
  JWT_SECRET: 'secreto-de-pruebas-unitarias-con-32-caracteres',
});

const app = buildServer({ env });

afterAll(async () => {
  await app.close();
});

describe('salud de la API', () => {
  it('GET /api/health responde ok sin tocar PostgreSQL', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok' });
  });

  it('las respuestas llevan las cabeceras de seguridad de helmet', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health' });

    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });

  it('GET /api se presenta', async () => {
    const response = await app.inject({ method: 'GET', url: '/api' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ name: 'centinela' });
  });
});
