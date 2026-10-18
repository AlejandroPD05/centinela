import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/client.js';
import type { WorkerHealth } from '../worker/worker.js';

/**
 * Liveness (no toca nada) y readiness (comprueba PostgreSQL).
 * El despliegue usa /api/health para saber si el servicio respira; además,
 * la salud incluye la señal del motor de checks (`stalled`) para que un
 * vigía externo pueda distinguir «API viva» de «motor atascado».
 */
export function healthRoutes(
  app: FastifyInstance,
  database?: Database,
  workerHealth?: () => WorkerHealth | null,
): void {
  app.get('/health', async () => {
    const worker = workerHealth ? workerHealth() : null;

    return {
      status: worker?.stalled ? 'degraded' : 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      worker,
    };
  });

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
