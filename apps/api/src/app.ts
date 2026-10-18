import helmet from '@fastify/helmet';
import Fastify, { type FastifyInstance } from 'fastify';
import { createAuthenticator } from './auth/plugin.js';
import type { Env } from './config/env.js';
import type { Database } from './db/client.js';
import { loggerOptions } from './logger.js';
import { apiKeyRoutes } from './routes/api-keys.js';
import { auditRoutes } from './routes/audit.js';
import { authRoutes } from './routes/auth.js';
import { channelRoutes } from './routes/channels.js';
import { deliveryRoutes } from './routes/deliveries.js';
import { healthRoutes } from './routes/health.js';
import { heartbeatRoutes } from './routes/heartbeats.js';
import { incidentRoutes } from './routes/incidents.js';
import { monitorRoutes } from './routes/monitors.js';
import { openApiRoutes } from './routes/openapi.js';
import { statusRoutes } from './routes/status.js';
import { workspaceRoutes } from './routes/workspaces.js';

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

  // Cada petición lleva su contexto de autenticación (null hasta que el
  // preHandler `authenticate` la rellena).
  app.decorateRequest('auth', null);

  app.register(helmet, {
    // La CSP se definirá cuando la API sirva el panel (M6). Sin frameguard:
    // el widget se incrusta en otras webs (la ruta /embed fija su propia
    // política) y los badges se consumen cross-origin desde los READMEs.
    contentSecurityPolicy: false,
    frameguard: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
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
        docs: '/api/docs',
      }));

      // Públicas: salud, latidos y documentación.
      healthRoutes(api, database);
      openApiRoutes(api);

      if (database) {
        const authenticate = createAuthenticator(database, env);

        authRoutes(api, database, env, authenticate);
        workspaceRoutes(api, database, authenticate);
        apiKeyRoutes(api, database, authenticate);
        auditRoutes(api, database, authenticate);
        monitorRoutes(api, database, authenticate);
        incidentRoutes(api, database, authenticate);
        heartbeatRoutes(api, database);
        channelRoutes(api, database, env, authenticate);
        deliveryRoutes(api, database, authenticate);
      }
    },
    { prefix: '/api' },
  );

  // Superficies públicas de raíz: status page, widget, badges y fuentes.
  if (database) {
    const db = database;
    app.register(async (publico) => {
      statusRoutes(publico, db);
    });
  }

  return app;
}
