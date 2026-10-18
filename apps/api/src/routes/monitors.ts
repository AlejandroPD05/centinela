import { uptimeWindows, type UptimeWindow } from '@centinela/shared';
import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Database } from '../db/client.js';
import { monitors } from '../db/schema.js';
import { getDailyBuckets, getUptimeSummary, listIncidents } from '../history/queries.js';

const uuidSchema = z.uuid();
const windowSchema = z.enum(uptimeWindows);
const daysSchema = z.coerce.number().int().min(1).max(365);
const limitSchema = z.coerce.number().int().min(1).max(100);

type MonitorRow = typeof monitors.$inferSelect;

/**
 * Proyección segura de un monitor: el token de heartbeat y cualquier campo
 * interno se quedan dentro. Las URLs de los servicios vigilados no son secretas.
 */
function toMonitorView(monitor: MonitorRow) {
  const isHttps = monitor.url !== null && monitor.url.startsWith('https://');

  return {
    id: monitor.id,
    name: monitor.name,
    slug: monitor.slug,
    type: monitor.type,
    url: monitor.url,
    host: monitor.host,
    port: monitor.port,
    state: monitor.state,
    isPublic: monitor.isPublic,
    paused: monitor.paused,
    intervalSeconds: monitor.intervalSeconds,
    timeoutMs: monitor.timeoutMs,
    confirmFailures: monitor.confirmFailures,
    confirmRecoveries: monitor.confirmRecoveries,
    lastCheckAt: monitor.lastCheckAt?.toISOString() ?? null,
    lastStateChangeAt: monitor.lastStateChangeAt?.toISOString() ?? null,
    nextCheckAt: monitor.nextCheckAt.toISOString(),
    ssl:
      monitor.type === 'http' && isHttps
        ? {
            expiresAt: monitor.sslExpiresAt?.toISOString() ?? null,
            checkedAt: monitor.sslCheckedAt?.toISOString() ?? null,
            issuer: monitor.sslIssuer,
            error: monitor.sslError,
          }
        : null,
  };
}

async function monitorExists(database: Database, id: string): Promise<boolean> {
  const [row] = await database
    .select({ id: monitors.id })
    .from(monitors)
    .where(eq(monitors.id, id));
  return row !== undefined;
}

/** Rutas de lectura: monitores, uptime, serie diaria e incidencias. */
export function monitorRoutes(app: FastifyInstance, database: Database): void {
  app.get('/monitors', async () => {
    const rows = await database.select().from(monitors).orderBy(asc(monitors.name));
    return { monitors: rows.map(toMonitorView) };
  });

  app.get<{ Params: { id: string } }>('/monitors/:id', async (request, reply) => {
    const id = uuidSchema.safeParse(request.params.id);
    if (!id.success) return reply.code(400).send({ error: 'id de monitor inválido' });

    const [monitor] = await database.select().from(monitors).where(eq(monitors.id, id.data));
    if (!monitor) return reply.code(404).send({ error: 'monitor no encontrado' });

    return toMonitorView(monitor);
  });

  app.get<{ Params: { id: string }; Querystring: { window?: string } }>(
    '/monitors/:id/uptime',
    async (request, reply) => {
      const id = uuidSchema.safeParse(request.params.id);
      if (!id.success) return reply.code(400).send({ error: 'id de monitor inválido' });

      const window = windowSchema.safeParse(request.query.window ?? '24h');
      if (!window.success) {
        return reply
          .code(400)
          .send({ error: `ventana inválida; usa una de: ${uptimeWindows.join(', ')}` });
      }

      if (!(await monitorExists(database, id.data))) {
        return reply.code(404).send({ error: 'monitor no encontrado' });
      }

      return getUptimeSummary(database, id.data, window.data as UptimeWindow);
    },
  );

  app.get<{ Params: { id: string }; Querystring: { days?: string } }>(
    '/monitors/:id/history',
    async (request, reply) => {
      const id = uuidSchema.safeParse(request.params.id);
      if (!id.success) return reply.code(400).send({ error: 'id de monitor inválido' });

      const days = daysSchema.safeParse(request.query.days ?? '90');
      if (!days.success) {
        return reply.code(400).send({ error: 'days debe ser un entero entre 1 y 365' });
      }

      if (!(await monitorExists(database, id.data))) {
        return reply.code(404).send({ error: 'monitor no encontrado' });
      }

      return { days: days.data, buckets: await getDailyBuckets(database, id.data, days.data) };
    },
  );

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    '/monitors/:id/incidents',
    async (request, reply) => {
      const id = uuidSchema.safeParse(request.params.id);
      if (!id.success) return reply.code(400).send({ error: 'id de monitor inválido' });

      const limit = limitSchema.safeParse(request.query.limit ?? '20');
      if (!limit.success) {
        return reply.code(400).send({ error: 'limit debe ser un entero entre 1 y 100' });
      }

      if (!(await monitorExists(database, id.data))) {
        return reply.code(404).send({ error: 'monitor no encontrado' });
      }

      return { incidents: await listIncidents(database, id.data, limit.data) };
    },
  );
}
