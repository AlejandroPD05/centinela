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
    expect(response.json()).toMatchObject({ status: 'ok', worker: null });
  });

  it('con el motor atascado se declara degraded y lo detalla', async () => {
    const appConMotor = buildServer({
      env,
      workerHealth: () => ({
        cycles: 7,
        lastCycleAt: '2026-10-18T10:00:00.000Z',
        lagSeconds: 400,
        stalled: true,
        lastSelfPingAt: null,
      }),
    });

    try {
      const response = await appConMotor.inject({ method: 'GET', url: '/api/health' });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        status: 'degraded',
        worker: { stalled: true, cycles: 7, lagSeconds: 400 },
      });
    } finally {
      await appConMotor.close();
    }
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
