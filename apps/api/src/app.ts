import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import helmet from '@fastify/helmet';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { createAuthenticator } from './auth/plugin.js';
import type { Env } from './config/env.js';
import type { Database } from './db/client.js';
import { startStatusBridge } from './events/bridge.js';
import { loggerOptions } from './logger.js';
import { rateLimit } from './plugins/limits.js';
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
import type { WorkerHealth } from './worker/worker.js';

export interface BuildServerOptions {
  env: Env;
  /** Sin base de datos no se registra /api/health/ready (arranque mínimo). */
  database?: Database;
  /** Señal de vida del motor de checks, para /api/health (opcional). */
  workerHealth?: () => WorkerHealth | null;
  /** Raíz del panel compilado; `null` para no servirlo. Por defecto, en producción, apps/web/dist. */
  webRoot?: string | null;
}

/** Panel compilado, vecino de la API en el monorepo (apps/web/dist). */
const defaultWebRoot = fileURLToPath(new URL('../../web/dist', import.meta.url));

/** Construye Fastify sin abrir el puerto: los tests usan `app.inject()`. */
export function buildServer({
  env,
  database,
  workerHealth,
  webRoot = env.NODE_ENV === 'production' && existsSync(defaultWebRoot) ? defaultWebRoot : null,
}: BuildServerOptions): FastifyInstance {
  const app = Fastify({
    logger: loggerOptions(env),
    trustProxy: true,
    // Al cerrar, los sockets en espera (keep-alive) se sueltan ya; las
    // conexiones vivas (SSE) se despiden desde el hub antes de `close()`.
    forceCloseConnections: 'idle',
  });

  // Cada petición lleva su contexto de autenticación (null hasta que el
  // preHandler `authenticate` la rellena).
  app.decorateRequest('auth', null);

  // Puente de avisos en vivo: escucha el canal de PostgreSQL (en el que
  // publica el worker, esté donde esté) y lo reparte entre las conexiones SSE
  // de este proceso. Se cierra con el servidor.
  if (database) {
    const bridge = startStatusBridge(env.DATABASE_URL, app.log);
    app.addHook('onClose', () => bridge.stop());
  }

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
      // Límite general por IP para toda la API. En los tests va desactivado:
      // las suites lanzan muchas peticiones seguidas a propósito.
      rateLimit(api, {
        perMinute: env.RATE_LIMIT_PER_MINUTE,
        scope: 'api',
        enabled: env.NODE_ENV !== 'test',
      });

      api.get('/', async () => ({
        name: 'centinela',
        version: '0.1.0',
        health: '/api/health',
        docs: '/api/docs',
      }));

      // Públicas: salud, latidos y documentación.
      healthRoutes(api, database, workerHealth);
      openApiRoutes(api);

      if (database) {
        const authenticate = createAuthenticator(database, env);

        authRoutes(api, database, env, authenticate);
        workspaceRoutes(api, database, authenticate);
        apiKeyRoutes(api, database, authenticate);
        auditRoutes(api, database, authenticate);
        monitorRoutes(api, database, authenticate);
        incidentRoutes(api, database, authenticate);
        heartbeatRoutes(api, database, { limitPerMinute: env.HEARTBEAT_LIMIT_PER_MINUTE });
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
      rateLimit(publico, {
        perMinute: env.PUBLIC_RATE_LIMIT_PER_MINUTE,
        scope: 'publicas',
        enabled: env.NODE_ENV !== 'test',
      });
      statusRoutes(publico, db);
    });
  }

  // Panel compilado (producción): la API sirve apps/web/dist en la raíz, así
  // que panel, status page y badges comparten origen. Cualquier GET que no
  // toque la API ni las superficies públicas cae en index.html (SPA).
  if (webRoot) {
    app.register(fastifyStatic, { root: webRoot });
    app.setNotFoundHandler((request, reply) => {
      const path = (request.raw.url ?? '/').split('?')[0] ?? '/';
      const reservada = ['/api', '/status', '/badge', '/embed'].some(
        (prefix) => path === prefix || path.startsWith(`${prefix}/`),
      );
      const pideHtml = (request.headers.accept ?? '').includes('text/html');

      if (request.method === 'GET' && pideHtml && !reservada) {
        return reply.sendFile('index.html');
      }

      return reply.code(404).send({
        message: `Route ${request.method}:${path} not found`,
        error: 'Not Found',
        statusCode: 404,
      });
    });
  }

  return app;
}
