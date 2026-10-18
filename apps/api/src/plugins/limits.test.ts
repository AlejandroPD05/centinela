import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { rateLimit } from './limits.js';

const apps: Array<ReturnType<typeof Fastify>> = [];

const buildApp = (options: Parameters<typeof rateLimit>[1]) => {
  const app = Fastify();
  rateLimit(app, options);
  app.get('/x', async () => ({ ok: true }));
  apps.push(app);
  return app;
};

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('rateLimit — cupo por IP', () => {
  it('deja pasar el cupo y corta con 429 y Retry-After al superarlo', async () => {
    const app = buildApp({ perMinute: 2, scope: 'prueba' });

    expect((await app.inject({ url: '/x' })).statusCode).toBe(200);
    expect((await app.inject({ url: '/x' })).statusCode).toBe(200);

    const tercera = await app.inject({ url: '/x' });
    expect(tercera.statusCode).toBe(429);
    expect(Number(tercera.headers['retry-after'])).toBeGreaterThan(0);
    expect(tercera.json()).toEqual({
      error: 'demasiadas peticiones; baja el ritmo y vuelve a intentarlo',
    });
  });

  it('con enabled=false no limita', async () => {
    const app = buildApp({ perMinute: 1, scope: 'prueba', enabled: false });

    for (let intento = 0; intento < 5; intento++) {
      expect((await app.inject({ url: '/x' })).statusCode).toBe(200);
    }
  });

  it('con perMinute=0 tampoco limita', async () => {
    const app = buildApp({ perMinute: 0, scope: 'prueba' });

    for (let intento = 0; intento < 5; intento++) {
      expect((await app.inject({ url: '/x' })).statusCode).toBe(200);
    }
  });
});
