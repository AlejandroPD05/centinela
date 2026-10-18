import helmet from '@fastify/helmet';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Env } from './config/env.js';
import type { Database } from './db/client.js';
import { loggerOptions } from './logger.js';
import { healthRoutes } from './routes/health.js';

export interface BuildServerOptions {
  env: Env;
  /** Sin base de datos no se registra /api/health/ready (arranque mínimo). */
  database?: Database;
}

/** Construye Fastify sin abrir el puerto: los tests usan `app.inject()`. */
export function buildServer({ env, database }: BuildServerOptions): FastifyInstance {
  const app = Fastify({
    logger: loggerOptions(env),
    trustProxy: true,
  });

  app.register(helmet, {
    // La CSP se definirá cuando la API sirva el panel y la status page (M5).
    contentSecurityPolicy: false,
  });

  app.register(
    async (api) => {
      api.get('/', async () => ({
        name: 'centinela',
        version: '0.1.0',
        health: '/api/health',
      }));

      healthRoutes(api, database);
    },
    { prefix: '/api' },
  );

  return app;
}
