import { desc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authUser, workspaceRoles, type Authenticator } from '../auth/plugin.js';
import type { Database } from '../db/client.js';
import { incidents, monitors } from '../db/schema.js';

const uuidSchema = z.uuid();
const listQuerySchema = z.object({
  workspaceId: uuidSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/**
 * Incidencias de todos los monitores de tus espacios, con el monitor ya
 * resuelto para pintarlas sin otra consulta. El timeline completo sigue
 * viviendo en `/monitors/:id/incidents`; aquí interesa la lectura rápida
 * (consola M6).
 */
export function incidentRoutes(
  app: FastifyInstance,
  database: Database,
  authenticate: Authenticator,
): void {
  app.get<{ Querystring: { workspaceId?: string; limit?: string } }>(
    '/incidents',
    { preHandler: authenticate },
    async (request, reply) => {
      const user = authUser(request);

      const query = listQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.code(400).send({ error: 'filtros inválidos', issues: query.error.issues });
      }

      const roles = await workspaceRoles(database, user.id);
      let workspaceIds = [...roles.keys()];

      if (query.data.workspaceId) {
        if (!workspaceIds.includes(query.data.workspaceId)) {
          return reply.code(403).send({ error: 'no perteneces a este espacio de trabajo' });
        }
        workspaceIds = [query.data.workspaceId];
      }

      if (workspaceIds.length === 0) return { incidents: [] };

      const rows = await database
        .select({
          id: incidents.id,
          monitorId: incidents.monitorId,
          monitorName: monitors.name,
          monitorSlug: monitors.slug,
          workspaceId: monitors.workspaceId,
          startedAt: incidents.startedAt,
          resolvedAt: incidents.resolvedAt,
          cause: incidents.cause,
        })
        .from(incidents)
        .innerJoin(monitors, eq(incidents.monitorId, monitors.id))
        .where(inArray(monitors.workspaceId, workspaceIds))
        .orderBy(desc(incidents.startedAt))
        .limit(query.data.limit);

      const now = Date.now();
      return {
        incidents: rows.map((row) => ({
          id: row.id,
          monitorId: row.monitorId,
          monitorName: row.monitorName,
          monitorSlug: row.monitorSlug,
          workspaceId: row.workspaceId,
          startedAt: row.startedAt.toISOString(),
          resolvedAt: row.resolvedAt?.toISOString() ?? null,
          durationSeconds: Math.max(
            0,
            Math.floor(
              ((row.resolvedAt?.getTime() ?? now) - row.startedAt.getTime()) / 1000,
            ),
          ),
          cause: row.cause,
          open: row.resolvedAt === null,
        })),
      };
    },
  );
}
