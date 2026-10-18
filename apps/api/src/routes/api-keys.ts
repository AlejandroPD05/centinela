import { and, desc, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { recordAudit } from '../audit/record.js';
import { authUser, type Authenticator } from '../auth/plugin.js';
import { generateApiKey } from '../auth/tokens.js';
import type { Database } from '../db/client.js';
import { apiKeys } from '../db/schema.js';

const uuidSchema = z.uuid();
const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  expiresInDays: z.coerce.number().int().min(1).max(3_650).optional(),
});

/** Proyección segura: jamás sale la huella de la clave. */
const keyView = {
  id: apiKeys.id,
  name: apiKeys.name,
  prefix: apiKeys.prefix,
  createdAt: apiKeys.createdAt,
  lastUsedAt: apiKeys.lastUsedAt,
  expiresAt: apiKeys.expiresAt,
  revokedAt: apiKeys.revokedAt,
};

/** Claves de API personales: cualquier usuario gestiona las suyas. */
export function apiKeyRoutes(
  app: FastifyInstance,
  database: Database,
  authenticate: Authenticator,
): void {
  app.get('/api-keys', { preHandler: authenticate }, async (request) => {
    const user = authUser(request);

    const keys = await database
      .select(keyView)
      .from(apiKeys)
      .where(eq(apiKeys.userId, user.id))
      .orderBy(desc(apiKeys.createdAt));

    return { apiKeys: keys };
  });

  app.post('/api-keys', { preHandler: authenticate }, async (request, reply) => {
    const user = authUser(request);

    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'clave inválida', issues: parsed.error.issues });
    }

    const generated = generateApiKey();
    const [created] = await database
      .insert(apiKeys)
      .values({
        userId: user.id,
        name: parsed.data.name,
        prefix: generated.prefix,
        keyHash: generated.keyHash,
        expiresAt:
          parsed.data.expiresInDays !== undefined
            ? new Date(Date.now() + parsed.data.expiresInDays * 86_400_000)
            : null,
      })
      .returning(keyView);

    if (!created) throw new Error('sin fila al crear la clave de API');

    await recordAudit(database, {
      userId: user.id,
      action: 'apikey.create',
      targetType: 'api_key',
      targetId: created.id,
      detail: { name: parsed.data.name },
      ip: request.ip,
    });

    // La clave completa solo se muestra aquí, una única vez.
    return reply.code(201).send({ key: generated.key, apiKey: created });
  });

  app.delete<{ Params: { id: string } }>(
    '/api-keys/:id',
    { preHandler: authenticate },
    async (request, reply) => {
      const user = authUser(request);

      const id = uuidSchema.safeParse(request.params.id);
      if (!id.success) return reply.code(400).send({ error: 'id de clave inválido' });

      const revoked = await database
        .update(apiKeys)
        .set({ revokedAt: new Date() })
        .where(and(eq(apiKeys.id, id.data), eq(apiKeys.userId, user.id), isNull(apiKeys.revokedAt)))
        .returning({ id: apiKeys.id, name: apiKeys.name });

      if (revoked.length === 0) {
        const [existing] = await database
          .select({ id: apiKeys.id })
          .from(apiKeys)
          .where(and(eq(apiKeys.id, id.data), eq(apiKeys.userId, user.id)));

        if (!existing) return reply.code(404).send({ error: 'clave no encontrada' });
        return reply.code(204).send(); // ya estaba revocada: idempotente
      }

      await recordAudit(database, {
        userId: user.id,
        action: 'apikey.revoke',
        targetType: 'api_key',
        targetId: id.data,
        detail: { name: revoked[0]?.name ?? null },
        ip: request.ip,
      });

      return reply.code(204).send();
    },
  );
}
