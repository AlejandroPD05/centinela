import { slugify, uptimeWindows, type UptimeWindow } from '@centinela/shared';
import { asc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { recordAudit } from '../audit/record.js';
import { authUser, requireRole, workspaceRoles, type Authenticator } from '../auth/plugin.js';
import { generateHeartbeatToken } from '../auth/tokens.js';
import type { Database } from '../db/client.js';
import { pgErrorInfo } from '../db/errors.js';
import { monitors } from '../db/schema.js';
import { getDailyBuckets, getUptimeSummary, listIncidents } from '../history/queries.js';

const uuidSchema = z.uuid();
const windowSchema = z.enum(uptimeWindows);
const daysSchema = z.coerce.number().int().min(1).max(365);
const limitSchema = z.coerce.number().int().min(1).max(100);

type MonitorRow = typeof monitors.$inferSelect;
type MonitorInsert = typeof monitors.$inferInsert;

/** URL de un monitor HTTP: solo http(s), el resto no se vigila. */
const targetUrlSchema = z
  .url()
  .refine(
    (value) => value.startsWith('http://') || value.startsWith('https://'),
    'la URL debe empezar por http:// o https://',
  );

const commonCreateFields = {
  workspaceId: uuidSchema,
  name: z.string().trim().min(1).max(120),
  slug: z.string().trim().min(1).max(80).optional(),
  intervalSeconds: z.coerce.number().int().min(30).max(86_400).default(300),
  timeoutMs: z.coerce.number().int().min(1_000).max(60_000).default(10_000),
  confirmFailures: z.coerce.number().int().min(1).max(10).default(2),
  confirmRecoveries: z.coerce.number().int().min(1).max(10).default(1),
  isPublic: z.boolean().default(false),
  paused: z.boolean().default(false),
} as const;

const createSchema = z.discriminatedUnion('type', [
  z.object({
    ...commonCreateFields,
    type: z.literal('http'),
    url: targetUrlSchema,
    method: z.enum(['GET', 'HEAD']).default('GET'),
    expectedStatus: z.coerce.number().int().min(100).max(599).default(200),
    keyword: z.string().trim().min(1).max(200).optional(),
    degradedLatencyMs: z.coerce.number().int().min(1).max(60_000).optional(),
  }),
  z.object({
    ...commonCreateFields,
    type: z.literal('tcp'),
    host: z.string().trim().min(1).max(253),
    port: z.coerce.number().int().min(1).max(65_535),
    degradedLatencyMs: z.coerce.number().int().min(1).max(60_000).optional(),
  }),
  z.object({
    ...commonCreateFields,
    type: z.literal('heartbeat'),
    heartbeatPeriodSeconds: z.coerce.number().int().min(10).max(86_400),
    heartbeatGraceSeconds: z.coerce.number().int().min(0).max(86_400).default(60),
  }),
]);

const patchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  slug: z.string().trim().min(1).max(80).optional(),
  url: targetUrlSchema.optional(),
  method: z.enum(['GET', 'HEAD']).optional(),
  expectedStatus: z.coerce.number().int().min(100).max(599).optional(),
  keyword: z.string().trim().min(1).max(200).nullable().optional(),
  host: z.string().trim().min(1).max(253).optional(),
  port: z.coerce.number().int().min(1).max(65_535).optional(),
  intervalSeconds: z.coerce.number().int().min(30).max(86_400).optional(),
  timeoutMs: z.coerce.number().int().min(1_000).max(60_000).optional(),
  degradedLatencyMs: z.coerce.number().int().min(1).max(60_000).nullable().optional(),
  confirmFailures: z.coerce.number().int().min(1).max(10).optional(),
  confirmRecoveries: z.coerce.number().int().min(1).max(10).optional(),
  heartbeatPeriodSeconds: z.coerce.number().int().min(10).max(86_400).optional(),
  heartbeatGraceSeconds: z.coerce.number().int().min(0).max(86_400).optional(),
  isPublic: z.boolean().optional(),
  paused: z.boolean().optional(),
});

type PatchInput = z.infer<typeof patchSchema>;

/** Campos editables por tipo de monitor: lo demás no aplica y da 400. */
const patchableFields: Record<MonitorRow['type'], ReadonlyArray<keyof PatchInput>> = {
  http: [
    'name',
    'slug',
    'isPublic',
    'paused',
    'confirmFailures',
    'confirmRecoveries',
    'intervalSeconds',
    'timeoutMs',
    'url',
    'method',
    'expectedStatus',
    'keyword',
    'degradedLatencyMs',
  ],
  tcp: [
    'name',
    'slug',
    'isPublic',
    'paused',
    'confirmFailures',
    'confirmRecoveries',
    'intervalSeconds',
    'timeoutMs',
    'host',
    'port',
    'degradedLatencyMs',
  ],
  heartbeat: [
    'name',
    'slug',
    'isPublic',
    'paused',
    'confirmFailures',
    'confirmRecoveries',
    'heartbeatPeriodSeconds',
    'heartbeatGraceSeconds',
  ],
};

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

/** Detalle para la consola: configuración editable y token de latido incluidos. */
function toMonitorDetail(monitor: MonitorRow) {
  return {
    ...toMonitorView(monitor),
    workspaceId: monitor.workspaceId,
    method: monitor.type === 'http' ? monitor.method : null,
    expectedStatus: monitor.type === 'http' ? monitor.expectedStatus : null,
    keyword: monitor.keyword,
    degradedLatencyMs: monitor.degradedLatencyMs,
    heartbeat:
      monitor.type === 'heartbeat'
        ? {
            token: monitor.heartbeatToken,
            periodSeconds: monitor.heartbeatPeriodSeconds,
            graceSeconds: monitor.heartbeatGraceSeconds,
          }
        : null,
    createdAt: monitor.createdAt.toISOString(),
    updatedAt: monitor.updatedAt.toISOString(),
  };
}

/**
 * Carga un monitor y comprueba el rol del usuario en su espacio. Responde por
 * sí sola (400/404/403) y devuelve `null` cuando algo falla.
 */
async function loadMonitorWithAccess(
  database: Database,
  request: FastifyRequest,
  reply: FastifyReply,
  rawId: string,
  minimum: 'viewer' | 'editor',
): Promise<MonitorRow | null> {
  const id = uuidSchema.safeParse(rawId);
  if (!id.success) {
    reply.code(400).send({ error: 'id de monitor inválido' });
    return null;
  }

  const [monitor] = await database.select().from(monitors).where(eq(monitors.id, id.data));
  if (!monitor) {
    reply.code(404).send({ error: 'monitor no encontrado' });
    return null;
  }

  if (!(await requireRole(database, request, reply, monitor.workspaceId, minimum))) return null;

  return monitor;
}

/** Monitores: alta y edición (editor), lectura (viewer) y check a demanda. */
export function monitorRoutes(
  app: FastifyInstance,
  database: Database,
  authenticate: Authenticator,
): void {
  app.get('/monitors', { preHandler: authenticate }, async (request) => {
    const user = authUser(request);

    const roles = await workspaceRoles(database, user.id);
    const workspaceIds = [...roles.keys()];
    if (workspaceIds.length === 0) return { monitors: [] };

    const rows = await database
      .select()
      .from(monitors)
      .where(inArray(monitors.workspaceId, workspaceIds))
      .orderBy(asc(monitors.name));

    return { monitors: rows.map(toMonitorView) };
  });

  app.post('/monitors', { preHandler: authenticate }, async (request, reply) => {
    const user = authUser(request);

    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'monitor inválido', issues: parsed.error.issues });
    }

    const data = parsed.data;
    if (!(await requireRole(database, request, reply, data.workspaceId, 'editor'))) return;

    const values: Omit<MonitorInsert, 'slug'> = {
      workspaceId: data.workspaceId,
      name: data.name,
      type: data.type,
      intervalSeconds: data.intervalSeconds,
      timeoutMs: data.timeoutMs,
      confirmFailures: data.confirmFailures,
      confirmRecoveries: data.confirmRecoveries,
      isPublic: data.isPublic,
      paused: data.paused,
      ...(data.type === 'http'
        ? {
            url: data.url,
            method: data.method,
            expectedStatus: data.expectedStatus,
            ...(data.keyword !== undefined ? { keyword: data.keyword } : {}),
            ...(data.degradedLatencyMs !== undefined
              ? { degradedLatencyMs: data.degradedLatencyMs }
              : {}),
          }
        : {}),
      ...(data.type === 'tcp'
        ? {
            host: data.host,
            port: data.port,
            ...(data.degradedLatencyMs !== undefined
              ? { degradedLatencyMs: data.degradedLatencyMs }
              : {}),
          }
        : {}),
      ...(data.type === 'heartbeat'
        ? {
            heartbeatToken: generateHeartbeatToken(),
            heartbeatPeriodSeconds: data.heartbeatPeriodSeconds,
            heartbeatGraceSeconds: data.heartbeatGraceSeconds,
          }
        : {}),
    };

    // El slug debe ser único dentro del espacio: si lo generamos nosotros,
    // probamos sufijos antes de rendirnos; si lo eligió la persona, 409.
    const explicitSlug = data.slug !== undefined;
    const baseSlug = slugify(data.slug ?? data.name) || 'monitor';

    for (let attempt = 0; ; attempt += 1) {
      const slug = attempt === 0 ? baseSlug : `${baseSlug}-${attempt + 1}`;

      try {
        const [monitor] = await database
          .insert(monitors)
          .values({ ...values, slug })
          .returning();
        if (!monitor) throw new Error('sin fila al crear el monitor');

        await recordAudit(database, {
          userId: user.id,
          workspaceId: monitor.workspaceId,
          action: 'monitor.create',
          targetType: 'monitor',
          targetId: monitor.id,
          detail: { name: monitor.name, slug: monitor.slug, type: monitor.type },
          ip: request.ip,
        });

        return reply.code(201).send({ monitor: toMonitorDetail(monitor) });
      } catch (error) {
        const info = pgErrorInfo(error);
        const slugConflict =
          info.code === '23505' && info.constraint === 'monitors_workspace_slug_key';

        if (slugConflict && !explicitSlug && attempt < 9) continue;
        if (slugConflict) {
          return reply.code(409).send({ error: 'ya existe un monitor con ese slug en el espacio' });
        }
        throw error;
      }
    }
  });

  app.get<{ Params: { id: string } }>(
    '/monitors/:id',
    { preHandler: authenticate },
    async (request, reply) => {
      const monitor = await loadMonitorWithAccess(
        database,
        request,
        reply,
        request.params.id,
        'viewer',
      );
      if (!monitor) return;

      return toMonitorDetail(monitor);
    },
  );

  app.get<{ Params: { id: string }; Querystring: { window?: string } }>(
    '/monitors/:id/uptime',
    { preHandler: authenticate },
    async (request, reply) => {
      const window = windowSchema.safeParse(request.query.window ?? '24h');
      if (!window.success) {
        return reply
          .code(400)
          .send({ error: `ventana inválida; usa una de: ${uptimeWindows.join(', ')}` });
      }

      const monitor = await loadMonitorWithAccess(
        database,
        request,
        reply,
        request.params.id,
        'viewer',
      );
      if (!monitor) return;

      return getUptimeSummary(database, monitor.id, window.data as UptimeWindow);
    },
  );

  app.get<{ Params: { id: string }; Querystring: { days?: string } }>(
    '/monitors/:id/history',
    { preHandler: authenticate },
    async (request, reply) => {
      const days = daysSchema.safeParse(request.query.days ?? '90');
      if (!days.success) {
        return reply.code(400).send({ error: 'days debe ser un entero entre 1 y 365' });
      }

      const monitor = await loadMonitorWithAccess(
        database,
        request,
        reply,
        request.params.id,
        'viewer',
      );
      if (!monitor) return;

      return { days: days.data, buckets: await getDailyBuckets(database, monitor.id, days.data) };
    },
  );

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    '/monitors/:id/incidents',
    { preHandler: authenticate },
    async (request, reply) => {
      const limit = limitSchema.safeParse(request.query.limit ?? '20');
      if (!limit.success) {
        return reply.code(400).send({ error: 'limit debe ser un entero entre 1 y 100' });
      }

      const monitor = await loadMonitorWithAccess(
        database,
        request,
        reply,
        request.params.id,
        'viewer',
      );
      if (!monitor) return;

      return { incidents: await listIncidents(database, monitor.id, limit.data) };
    },
  );

  app.patch<{ Params: { id: string } }>(
    '/monitors/:id',
    { preHandler: authenticate },
    async (request, reply) => {
      const user = authUser(request);

      const parsed = patchSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'cambios inválidos', issues: parsed.error.issues });
      }

      const monitor = await loadMonitorWithAccess(
        database,
        request,
        reply,
        request.params.id,
        'editor',
      );
      if (!monitor) return;

      const changes = parsed.data;
      if (Object.keys(changes).length === 0) {
        return reply.code(400).send({ error: 'no hay cambios que aplicar' });
      }

      const notApplicable = Object.keys(changes).filter(
        (field) => !patchableFields[monitor.type].includes(field as keyof PatchInput),
      );
      if (notApplicable.length > 0) {
        return reply.code(400).send({
          error: `estos campos no aplican a un monitor de tipo ${monitor.type}: ${notApplicable.join(', ')}`,
        });
      }

      const set: Partial<MonitorInsert> = { ...changes, nextCheckAt: new Date() };

      if (changes.slug !== undefined) {
        const slug = slugify(changes.slug);
        if (slug === '') return reply.code(400).send({ error: 'el slug no puede quedar vacío' });
        set.slug = slug;
      }

      // Si cambia el destino, el certificado del anterior deja de valer.
      if (changes.url !== undefined || changes.host !== undefined || changes.port !== undefined) {
        set.sslExpiresAt = null;
        set.sslCheckedAt = null;
        set.sslIssuer = null;
        set.sslError = null;
        set.sslAlertStage = 0;
      }

      try {
        const [updated] = await database
          .update(monitors)
          .set(set)
          .where(eq(monitors.id, monitor.id))
          .returning();
        if (!updated) throw new Error('sin fila al actualizar el monitor');

        await recordAudit(database, {
          userId: user.id,
          workspaceId: updated.workspaceId,
          action: 'monitor.update',
          targetType: 'monitor',
          targetId: updated.id,
          detail: { fields: Object.keys(changes) },
          ip: request.ip,
        });

        return { monitor: toMonitorDetail(updated) };
      } catch (error) {
        if (pgErrorInfo(error).code === '23505') {
          return reply.code(409).send({ error: 'ya existe un monitor con ese slug en el espacio' });
        }
        throw error;
      }
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/monitors/:id',
    { preHandler: authenticate },
    async (request, reply) => {
      const user = authUser(request);

      const monitor = await loadMonitorWithAccess(
        database,
        request,
        reply,
        request.params.id,
        'editor',
      );
      if (!monitor) return;

      await database.delete(monitors).where(eq(monitors.id, monitor.id));

      await recordAudit(database, {
        userId: user.id,
        workspaceId: monitor.workspaceId,
        action: 'monitor.delete',
        targetType: 'monitor',
        targetId: monitor.id,
        detail: { name: monitor.name, slug: monitor.slug },
        ip: request.ip,
      });

      return reply.code(204).send();
    },
  );

  app.post<{ Params: { id: string } }>(
    '/monitors/:id/check',
    { preHandler: authenticate },
    async (request, reply) => {
      const user = authUser(request);

      const monitor = await loadMonitorWithAccess(
        database,
        request,
        reply,
        request.params.id,
        'editor',
      );
      if (!monitor) return;

      if (monitor.type === 'heartbeat') {
        return reply
          .code(409)
          .send({ error: 'los monitores de latido no se comprueban a demanda' });
      }
      if (monitor.paused) {
        return reply
          .code(409)
          .send({ error: 'el monitor está en pausa; reanúdalo antes de pedir un check' });
      }

      await database
        .update(monitors)
        .set({ nextCheckAt: new Date() })
        .where(eq(monitors.id, monitor.id));

      await recordAudit(database, {
        userId: user.id,
        workspaceId: monitor.workspaceId,
        action: 'monitor.check',
        targetType: 'monitor',
        targetId: monitor.id,
        ip: request.ip,
      });

      return reply
        .code(202)
        .send({ ok: true, message: 'check programado; el resultado llega en unos segundos' });
    },
  );
}
