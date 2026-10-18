import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Database } from '../db/client.js';
import { monitors } from '../db/schema.js';
import { persistOutcome } from '../worker/persist.js';

/**
 * Latidos de entrada: `POST/GET /api/heartbeats/:token`.
 *
 * Cada latido cuenta como un check correcto y reprograma el plazo
 * (periodo + gracia). El token solo identifica a un monitor: no revela nada
 * más del sistema. GET se mantiene para plataformas que solo saben hacer ping.
 */
export function heartbeatRoutes(app: FastifyInstance, database: Database): void {
  const handlePing = async (
    request: FastifyRequest<{ Params: { token: string } }>,
    reply: FastifyReply,
  ) => {
    const token = request.params.token ?? '';
    if (token.length < 8 || token.length > 128) {
      return reply.code(400).send({ error: 'token de latido inválido' });
    }

    const [monitor] = await database
      .select()
      .from(monitors)
      .where(and(eq(monitors.heartbeatToken, token), eq(monitors.type, 'heartbeat')))
      .limit(1);

    if (!monitor) {
      return reply.code(404).send({ error: 'latido desconocido' });
    }

    if (monitor.paused) {
      return { ok: true, monitor: monitor.slug, ignored: 'monitor en pausa' };
    }

    const now = new Date();
    const period = monitor.heartbeatPeriodSeconds ?? monitor.intervalSeconds;
    const grace = monitor.heartbeatGraceSeconds ?? 0;

    const result = await persistOutcome(database, monitor, { status: 'up', latencyMs: 0 }, now, {
      nextCheckAt: new Date(now.getTime() + (period + grace) * 1000),
    });

    return { ok: true, monitor: monitor.slug, state: result.state };
  };

  app.post<{ Params: { token: string } }>('/heartbeats/:token', handlePing);
  app.get<{ Params: { token: string } }>('/heartbeats/:token', handlePing);
}
