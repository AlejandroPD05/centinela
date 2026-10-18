import helmet from '@fastify/helmet';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Env } from './config/env.js';
import type { Database } from './db/client.js';
import { loggerOptions } from './logger.js';
import { channelRoutes } from './routes/channels.js';
import { healthRoutes } from './routes/health.js';
import { heartbeatRoutes } from './routes/heartbeats.js';
import { monitorRoutes } from './routes/monitors.js';

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

  // Los latidos pueden llegar sin cuerpo o con un content-type raro (curl,
  // plataformas de ping, formularios): se acepta cualquier cuerpo y las rutas
  // que sí importan lo validan con zod.
  app.addContentTypeParser('*', (_request, _payload, done) => {
    done(null, undefined);
  });

  app.register(
    async (api) => {
      api.get('/', async () => ({
        name: 'centinela',
        version: '0.1.0',
        health: '/api/health',
      }));

      healthRoutes(api, database);
      if (database) {
        monitorRoutes(api, database);
        heartbeatRoutes(api, database);
        channelRoutes(api, database, env);
      }
    },
    { prefix: '/api' },
  );

  return app;
}
