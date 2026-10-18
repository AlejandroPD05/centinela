import { and, desc, eq, inArray, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authUser, workspaceRoles, type Authenticator } from '../auth/plugin.js';
import type { Database } from '../db/client.js';
import { deliveries, monitors, notificationChannels } from '../db/schema.js';

const uuidSchema = z.uuid();
const listQuerySchema = z.object({
  workspaceId: uuidSchema.optional(),
  status: z.enum(['pending', 'sent', 'failed']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/**
 * Registro de entregas de avisos: qué salió, por qué canal, con cuántos
 * intentos y en qué acabó. Es la traza que el operador mira cuando un aviso
 * no llegó (consola M6).
 */
export function deliveryRoutes(
  app: FastifyInstance,
  database: Database,
  authenticate: Authenticator,
): void {
  app.get<{ Querystring: { workspaceId?: string; status?: string; limit?: string } }>(
    '/deliveries',
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

      if (workspaceIds.length === 0) return { deliveries: [] };

      const conditions: SQL[] = [inArray(monitors.workspaceId, workspaceIds)];
      if (query.data.status) conditions.push(eq(deliveries.status, query.data.status));

      const rows = await database
        .select({
          id: deliveries.id,
          kind: deliveries.kind,
          status: deliveries.status,
          attempts: deliveries.attempts,
          lastError: deliveries.lastError,
          createdAt: deliveries.createdAt,
          nextAttemptAt: deliveries.nextAttemptAt,
          sentAt: deliveries.sentAt,
          incidentId: deliveries.incidentId,
          channelId: deliveries.channelId,
          channelName: notificationChannels.name,
          channelType: notificationChannels.type,
          monitorId: deliveries.monitorId,
          monitorName: monitors.name,
          monitorSlug: monitors.slug,
        })
        .from(deliveries)
        .innerJoin(notificationChannels, eq(deliveries.channelId, notificationChannels.id))
        .innerJoin(monitors, eq(deliveries.monitorId, monitors.id))
        .where(and(...conditions))
        .orderBy(desc(deliveries.createdAt))
        .limit(query.data.limit);

      return {
        deliveries: rows.map((row) => ({
          id: row.id,
          kind: row.kind,
          status: row.status,
          attempts: row.attempts,
          lastError: row.lastError,
          createdAt: row.createdAt.toISOString(),
          nextAttemptAt: row.nextAttemptAt.toISOString(),
          sentAt: row.sentAt?.toISOString() ?? null,
          incidentId: row.incidentId,
          channelId: row.channelId,
          channelName: row.channelName,
          channelType: row.channelType,
          monitorId: row.monitorId,
          monitorName: row.monitorName,
          monitorSlug: row.monitorSlug,
        })),
      };
    },
  );
}
