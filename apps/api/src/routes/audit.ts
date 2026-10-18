import { desc, eq, inArray, or } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authUser, workspaceRoles, type Authenticator } from '../auth/plugin.js';
import type { Database } from '../db/client.js';
import { auditLog } from '../db/schema.js';

const querySchema = z.object({
  workspaceId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

/**
 * Auditoría: cada usuario ve lo suyo y lo de los espacios donde administra.
 * Con `workspaceId` se filtra un espacio concreto (solo administración).
 */
export function auditRoutes(
  app: FastifyInstance,
  database: Database,
  authenticate: Authenticator,
): void {
  app.get('/audit', { preHandler: authenticate }, async (request, reply) => {
    const user = authUser(request);

    const parsed = querySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'filtros inválidos', issues: parsed.error.issues });
    }

    const limit = parsed.data.limit ?? 50;
    const roles = await workspaceRoles(database, user.id);
    const adminWorkspaceIds = [...roles.entries()]
      .filter(([, role]) => role === 'admin')
      .map(([workspaceId]) => workspaceId);

    let where;
    if (parsed.data.workspaceId !== undefined) {
      if (!adminWorkspaceIds.includes(parsed.data.workspaceId)) {
        return reply
          .code(403)
          .send({ error: 'solo la administración del espacio ve su auditoría' });
      }
      where = eq(auditLog.workspaceId, parsed.data.workspaceId);
    } else {
      const conditions = [eq(auditLog.userId, user.id)];
      if (adminWorkspaceIds.length > 0) {
        conditions.push(inArray(auditLog.workspaceId, adminWorkspaceIds));
      }
      where = or(...conditions);
    }

    const entries = await database
      .select()
      .from(auditLog)
      .where(where)
      .orderBy(desc(auditLog.id))
      .limit(limit);

    return { entries };
  });
}
