import { roles, slugify } from '@centinela/shared';
import { and, asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { recordAudit } from '../audit/record.js';
import { authUser, requireRole, type Authenticator } from '../auth/plugin.js';
import { randomToken } from '../auth/tokens.js';
import type { Database } from '../db/client.js';
import { pgErrorInfo } from '../db/errors.js';
import { memberships, users, workspaces } from '../db/schema.js';

const uuidSchema = z.uuid();
const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  slug: z.string().trim().min(2).max(60).optional(),
});
const memberSchema = z.object({ email: z.email(), role: z.enum(roles) });
const rolePatchSchema = z.object({ role: z.enum(roles) });

async function workspaceExists(database: Database, id: string): Promise<boolean> {
  const [row] = await database
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.id, id));

  return row !== undefined;
}

async function adminCount(database: Database, workspaceId: string): Promise<number> {
  const rows = await database
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.role, 'admin')));

  return rows.length;
}

/** Espacios de trabajo y su membresía: quién entra y con qué rol. */
export function workspaceRoutes(
  app: FastifyInstance,
  database: Database,
  authenticate: Authenticator,
): void {
  app.get('/workspaces', { preHandler: authenticate }, async (request) => {
    const user = authUser(request);

    const spaces = await database
      .select({
        id: workspaces.id,
        name: workspaces.name,
        slug: workspaces.slug,
        role: memberships.role,
        createdAt: workspaces.createdAt,
      })
      .from(memberships)
      .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
      .where(eq(memberships.userId, user.id))
      .orderBy(asc(workspaces.name));

    return { workspaces: spaces };
  });

  app.post('/workspaces', { preHandler: authenticate }, async (request, reply) => {
    const user = authUser(request);

    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'espacio inválido', issues: parsed.error.issues });
    }

    const slug =
      slugify(parsed.data.slug ?? parsed.data.name) || `espacio-${randomToken(6).toLowerCase()}`;

    try {
      const workspace = await database.transaction(async (tx) => {
        const [created] = await tx
          .insert(workspaces)
          .values({ name: parsed.data.name, slug })
          .returning();
        if (!created) throw new Error('sin fila al crear el espacio');

        await tx
          .insert(memberships)
          .values({ userId: user.id, workspaceId: created.id, role: 'admin' });

        return created;
      });

      await recordAudit(database, {
        userId: user.id,
        workspaceId: workspace.id,
        action: 'workspace.create',
        targetType: 'workspace',
        targetId: workspace.id,
        detail: { name: workspace.name, slug: workspace.slug },
        ip: request.ip,
      });

      return reply.code(201).send({
        workspace: {
          id: workspace.id,
          name: workspace.name,
          slug: workspace.slug,
          role: 'admin',
          createdAt: workspace.createdAt,
        },
      });
    } catch (error) {
      if (pgErrorInfo(error).code === '23505') {
        return reply.code(409).send({ error: 'ese slug ya está en uso' });
      }
      throw error;
    }
  });

  app.get<{ Params: { id: string } }>(
    '/workspaces/:id/members',
    { preHandler: authenticate },
    async (request, reply) => {
      const id = uuidSchema.safeParse(request.params.id);
      if (!id.success) return reply.code(400).send({ error: 'id de espacio inválido' });

      if (!(await workspaceExists(database, id.data))) {
        return reply.code(404).send({ error: 'espacio de trabajo no encontrado' });
      }
      if (!(await requireRole(database, request, reply, id.data, 'viewer'))) return;

      const members = await database
        .select({
          userId: users.id,
          email: users.email,
          name: users.name,
          role: memberships.role,
          createdAt: memberships.createdAt,
        })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(eq(memberships.workspaceId, id.data))
        .orderBy(asc(users.name));

      return { members };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/workspaces/:id/members',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = authUser(request);

      const id = uuidSchema.safeParse(request.params.id);
      if (!id.success) return reply.code(400).send({ error: 'id de espacio inválido' });

      const parsed = memberSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'miembro inválido', issues: parsed.error.issues });
      }

      if (!(await workspaceExists(database, id.data))) {
        return reply.code(404).send({ error: 'espacio de trabajo no encontrado' });
      }
      if (!(await requireRole(database, request, reply, id.data, 'admin'))) return;

      const email = parsed.data.email.trim().toLowerCase();
      const [target] = await database
        .select({ id: users.id, email: users.email, name: users.name })
        .from(users)
        .where(eq(users.email, email));

      if (!target) {
        return reply.code(404).send({
          error: 'no existe ningún usuario con ese correo; créalo con `pnpm api:cli create-user`',
        });
      }

      try {
        await database
          .insert(memberships)
          .values({ userId: target.id, workspaceId: id.data, role: parsed.data.role });
      } catch (error) {
        if (pgErrorInfo(error).code === '23505') {
          return reply.code(409).send({ error: 'ya es miembro del espacio' });
        }
        throw error;
      }

      await recordAudit(database, {
        userId: actor.id,
        workspaceId: id.data,
        action: 'member.add',
        targetType: 'user',
        targetId: target.id,
        detail: { email, role: parsed.data.role },
        ip: request.ip,
      });

      return reply.code(201).send({
        member: {
          userId: target.id,
          email: target.email,
          name: target.name,
          role: parsed.data.role,
        },
      });
    },
  );

  app.patch<{ Params: { id: string; userId: string } }>(
    '/workspaces/:id/members/:userId',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = authUser(request);

      const id = uuidSchema.safeParse(request.params.id);
      if (!id.success) return reply.code(400).send({ error: 'id de espacio inválido' });
      const targetId = uuidSchema.safeParse(request.params.userId);
      if (!targetId.success) return reply.code(400).send({ error: 'id de usuario inválido' });

      const parsed = rolePatchSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'rol inválido; usa admin, editor o viewer' });
      }

      if (!(await requireRole(database, request, reply, id.data, 'admin'))) return;

      const [membership] = await database
        .select()
        .from(memberships)
        .where(and(eq(memberships.workspaceId, id.data), eq(memberships.userId, targetId.data)));

      if (!membership) {
        return reply.code(404).send({ error: 'esa persona no es miembro del espacio' });
      }

      if (
        membership.role === 'admin' &&
        parsed.data.role !== 'admin' &&
        (await adminCount(database, id.data)) === 1
      ) {
        return reply
          .code(409)
          .send({ error: 'no puedes quitar el último administrador del espacio' });
      }

      await database
        .update(memberships)
        .set({ role: parsed.data.role })
        .where(and(eq(memberships.workspaceId, id.data), eq(memberships.userId, targetId.data)));

      await recordAudit(database, {
        userId: actor.id,
        workspaceId: id.data,
        action: 'member.role',
        targetType: 'user',
        targetId: targetId.data,
        detail: { from: membership.role, to: parsed.data.role },
        ip: request.ip,
      });

      return { member: { userId: targetId.data, role: parsed.data.role } };
    },
  );

  app.delete<{ Params: { id: string; userId: string } }>(
    '/workspaces/:id/members/:userId',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = authUser(request);

      const id = uuidSchema.safeParse(request.params.id);
      if (!id.success) return reply.code(400).send({ error: 'id de espacio inválido' });
      const targetId = uuidSchema.safeParse(request.params.userId);
      if (!targetId.success) return reply.code(400).send({ error: 'id de usuario inválido' });

      if (!(await requireRole(database, request, reply, id.data, 'admin'))) return;

      const [membership] = await database
        .select()
        .from(memberships)
        .where(and(eq(memberships.workspaceId, id.data), eq(memberships.userId, targetId.data)));

      if (!membership) {
        return reply.code(404).send({ error: 'esa persona no es miembro del espacio' });
      }

      if (membership.role === 'admin' && (await adminCount(database, id.data)) === 1) {
        return reply
          .code(409)
          .send({ error: 'no puedes quitar el último administrador del espacio' });
      }

      await database
        .delete(memberships)
        .where(and(eq(memberships.workspaceId, id.data), eq(memberships.userId, targetId.data)));

      await recordAudit(database, {
        userId: actor.id,
        workspaceId: id.data,
        action: 'member.remove',
        targetType: 'user',
        targetId: targetId.data,
        detail: { role: membership.role },
        ip: request.ip,
      });

      return reply.code(204).send();
    },
  );
}
