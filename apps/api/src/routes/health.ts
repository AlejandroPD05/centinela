import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/client.js';

/**
 * Liveness (no toca nada) y readiness (comprueba PostgreSQL).
 * El despliegue usa /api/health para saber si el servicio respira.
 */
export function healthRoutes(app: FastifyInstance, database?: Database): void {
  app.get('/health', async () => ({
    status: 'ok',
    uptimeSeconds: Math.round(process.uptime()),
  }));

  if (!database) return;

  app.get('/health/ready', async (_request, reply) => {
    try {
      await database.execute(sql`select 1`);
      return { status: 'ready', database: 'up' };
    } catch (error) {
      app.log.error({ err: error }, 'readiness: PostgreSQL no responde');
      return reply.code(503).send({ status: 'unavailable', database: 'down' });
    }
  });
}
