import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assertHostAllowed } from '../checks/ssrf.js';
import type { Env } from '../config/env.js';
import type { Database } from '../db/client.js';
import { notificationChannels, workspaces } from '../db/schema.js';

const idSchema = z.uuid();
const nameSchema = z.string().trim().min(1).max(80);

const discordConfigSchema = z.object({ webhookUrl: z.url() });
const webhookConfigSchema = z.object({ url: z.url() });
const emailConfigSchema = z.object({ to: z.email() });

const configSchemas = {
  discord: discordConfigSchema,
  webhook: webhookConfigSchema,
  email: emailConfigSchema,
} as const;

const createSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('discord'),
    workspaceId: idSchema,
    name: nameSchema,
    config: discordConfigSchema,
  }),
  z.object({
    type: z.literal('webhook'),
    workspaceId: idSchema,
    name: nameSchema,
    config: webhookConfigSchema,
  }),
  z.object({
    type: z.literal('email'),
    workspaceId: idSchema,
    name: nameSchema,
    config: emailConfigSchema,
  }),
]);

const patchSchema = z.object({
  name: nameSchema.optional(),
  enabled: z.boolean().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

/** Extrae el código de error de PostgreSQL aunque Drizzle lo envuelva. */
function pgErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;

  if ('code' in error && typeof (error as { code?: unknown }).code === 'string') {
    return (error as { code: string }).code;
  }

  return pgErrorCode((error as { cause?: unknown }).cause);
}

/**
 * Los canales apuntan a URLs externas: se validan con la misma guarda SSRF
 * que los monitores (salvo que el entorno permita destinos privados). El
 * worker revalida contra rebinding en M7; aquí se corta el error humano.
 */
async function channelTargetError(target: string, env: Env): Promise<string | null> {
  try {
    const url = new URL(target);
    await assertHostAllowed(url.hostname, { allowPrivateTargets: env.ALLOW_PRIVATE_TARGETS });
    return null;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return `el destino del canal no es válido: ${detail}`;
  }
}

/** CRUD de canales de aviso. En M4 pasará detrás de autenticación por rol. */
export function channelRoutes(app: FastifyInstance, database: Database, env: Env): void {
  app.get('/channels', async () => {
    const channels = await database
      .select()
      .from(notificationChannels)
      .orderBy(asc(notificationChannels.name));
    return { channels };
  });

  app.post('/channels', async (request, reply) => {
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'canal inválido', issues: parsed.error.issues });
    }

    const target =
      parsed.data.type === 'discord'
        ? parsed.data.config.webhookUrl
        : parsed.data.type === 'webhook'
          ? parsed.data.config.url
          : null;

    if (target) {
      const targetError = await channelTargetError(target, env);
      if (targetError) return reply.code(400).send({ error: targetError });
    }

    const [workspace] = await database
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.id, parsed.data.workspaceId));

    if (!workspace) {
      return reply.code(404).send({ error: 'espacio de trabajo no encontrado' });
    }

    try {
      const [channel] = await database.insert(notificationChannels).values(parsed.data).returning();
      return reply.code(201).send({ channel });
    } catch (error) {
      if (pgErrorCode(error) === '23505') {
        return reply.code(409).send({ error: 'ya existe un canal con ese nombre en el espacio' });
      }
      throw error;
    }
  });

  app.patch<{ Params: { id: string } }>('/channels/:id', async (request, reply) => {
    const id = idSchema.safeParse(request.params.id);
    if (!id.success) return reply.code(400).send({ error: 'id de canal inválido' });

    const parsed = patchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'cambios inválidos', issues: parsed.error.issues });
    }

    const [channel] = await database
      .select()
      .from(notificationChannels)
      .where(eq(notificationChannels.id, id.data));

    if (!channel) return reply.code(404).send({ error: 'canal no encontrado' });

    let config = channel.config;
    if (parsed.data.config) {
      const configSchema = configSchemas[channel.type];
      const validated = configSchema.safeParse(parsed.data.config);
      if (!validated.success) {
        return reply.code(400).send({
          error: `config inválida para un canal ${channel.type}`,
          issues: validated.error.issues,
        });
      }

      const target =
        channel.type === 'discord'
          ? (validated.data as { webhookUrl: string }).webhookUrl
          : channel.type === 'webhook'
            ? (validated.data as { url: string }).url
            : null;

      if (target) {
        const targetError = await channelTargetError(target, env);
        if (targetError) return reply.code(400).send({ error: targetError });
      }

      config = validated.data;
    }

    const [updated] = await database
      .update(notificationChannels)
      .set({
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
        ...(parsed.data.enabled !== undefined ? { enabled: parsed.data.enabled } : {}),
        config,
      })
      .where(eq(notificationChannels.id, id.data))
      .returning();

    return { channel: updated };
  });

  app.delete<{ Params: { id: string } }>('/channels/:id', async (request, reply) => {
    const id = idSchema.safeParse(request.params.id);
    if (!id.success) return reply.code(400).send({ error: 'id de canal inválido' });

    const deleted = await database
      .delete(notificationChannels)
      .where(eq(notificationChannels.id, id.data))
      .returning({ id: notificationChannels.id });

    if (deleted.length === 0) return reply.code(404).send({ error: 'canal no encontrado' });

    return reply.code(204).send();
  });
}
