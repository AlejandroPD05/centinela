import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { NotificationPayload } from '@centinela/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../app.js';
import { signAccessToken } from '../auth/jwt.js';
import { hashPassword } from '../auth/password.js';
import { loadEnv, loadEnvFileIfPresent } from '../config/env.js';
import {
  checkResults,
  deliveries,
  incidentEvents,
  incidents,
  memberships,
  monitors,
  users,
  workspaces,
} from '../db/schema.js';
import {
  canReachDatabase,
  createEphemeralDatabase,
  type EphemeralDatabase,
} from '../test/support.js';

loadEnvFileIfPresent();

const databaseUrl = process.env.DATABASE_URL ?? '';
const dbAvailable = databaseUrl !== '' && (await canReachDatabase(databaseUrl));

if (!dbAvailable) {
  console.warn('PostgreSQL no disponible: la prueba de integración de la consola se salta.');
}

const JWT_SECRET = 'secreto-de-integracion-de-la-consola-1234567890';
const MINUTE = 60_000;
const HOUR = 3_600_000;

/**
 * Ampliaciones de API que estrena la consola de operador (M6): listado de
 * monitores con espacio y filtro, checks crudos recientes, incidencias
 * globales, registro de entregas y aviso de prueba por canal. Todo contra
 * PostgreSQL efímero y un webhook local de verdad.
 */
describe.runIf(dbAvailable)('consola — ampliaciones de API en integración', () => {
  let ephemeral: EphemeralDatabase;
  let app: FastifyInstance;
  let webhook: Server;
  let webhookBase: string;
  const received: Array<{ url: string; body: string }> = [];

  let workspaceId: string;
  let otherWorkspaceId: string;
  let monitorId: string;
  let channelId: string;
  let adminHeaders: { authorization: string };
  let viewerHeaders: { authorization: string };
  let strangerHeaders: { authorization: string };
  const now = Date.now();

  async function makeUser(email: string, name: string): Promise<string> {
    const [user] = await ephemeral.db
      .insert(users)
      .values({ email, name, passwordHash: await hashPassword('contraseña-de-prueba-2026') })
      .returning();
    if (!user) throw new Error('no se pudo crear el usuario');
    return user.id;
  }

  function headersFor(user: { id: string; email: string; name: string }) {
    return {
      authorization: `Bearer ${signAccessToken(
        { sub: user.id, email: user.email, name: user.name },
        JWT_SECRET,
        3_600,
      )}`,
    };
  }

  beforeAll(async () => {
    ephemeral = await createEphemeralDatabase(databaseUrl, 'centinela_test_panel');
    const { db } = ephemeral;

    // Webhook local: 200 en /ok, 500 en /fail; guarda lo recibido.
    webhook = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => {
        body += chunk;
      });
      request.on('end', () => {
        received.push({ url: request.url ?? '', body });
        response.statusCode = request.url === '/fail' ? 500 : 200;
        response.setHeader('content-type', 'application/json');
        response.end('{}');
      });
    });
    await new Promise<void>((resolve) => webhook.listen(0, '127.0.0.1', resolve));
    const address = webhook.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    webhookBase = `http://127.0.0.1:${port}`;

    // Dos espacios: la consola ve el suyo; el ajeno sirve de frontera.
    const [workspace] = await db
      .insert(workspaces)
      .values({ name: 'Consola', slug: `consola-${randomUUID()}` })
      .returning();
    const [other] = await db
      .insert(workspaces)
      .values({ name: 'Ajeno', slug: `ajeno-${randomUUID()}` })
      .returning();
    if (!workspace || !other) throw new Error('no se pudieron crear los espacios');
    workspaceId = workspace.id;
    otherWorkspaceId = other.id;

    const adminId = await makeUser('consola-admin@example.com', 'Admin de consola');
    const viewerId = await makeUser('consola-viewer@example.com', 'Lectora de consola');
    const strangerId = await makeUser('consola-ajeno@example.com', 'Ajeno');

    await db.insert(memberships).values([
      { userId: adminId, workspaceId, role: 'admin' },
      { userId: viewerId, workspaceId, role: 'viewer' },
      { userId: strangerId, workspaceId: otherWorkspaceId, role: 'admin' },
    ]);

    adminHeaders = headersFor({
      id: adminId,
      email: 'consola-admin@example.com',
      name: 'Admin de consola',
    });
    viewerHeaders = headersFor({
      id: viewerId,
      email: 'consola-viewer@example.com',
      name: 'Lectora de consola',
    });
    strangerHeaders = headersFor({
      id: strangerId,
      email: 'consola-ajeno@example.com',
      name: 'Ajeno',
    });

    const [monitor] = await db
      .insert(monitors)
      .values({
        workspaceId,
        name: 'API de ejemplo',
        slug: 'api-de-ejemplo',
        type: 'http',
        url: 'https://example.com/',
        isPublic: true,
      })
      .returning();
    if (!monitor) throw new Error('no se pudo crear el monitor');
    monitorId = monitor.id;

    await db.insert(monitors).values([
      {
        workspaceId,
        name: 'Puerto de respaldo',
        slug: 'puerto-de-respaldo',
        type: 'tcp',
        host: 'example.com',
        port: 443,
      },
      {
        workspaceId: otherWorkspaceId,
        name: 'Monitor ajeno',
        slug: 'monitor-ajeno',
        type: 'http',
        url: 'https://example.org/',
      },
    ]);

    // Cuatro checks: el más nuevo y el más viejo correctos.
    await db.insert(checkResults).values([
      {
        monitorId,
        status: 'up',
        latencyMs: 120,
        statusCode: 200,
        checkedAt: new Date(now - 30 * MINUTE),
      },
      {
        monitorId,
        status: 'degraded',
        latencyMs: 800,
        statusCode: 200,
        checkedAt: new Date(now - 20 * MINUTE),
      },
      {
        monitorId,
        status: 'down',
        error: 'conexión rechazada',
        checkedAt: new Date(now - 10 * MINUTE),
      },
      {
        monitorId,
        status: 'up',
        latencyMs: 150,
        statusCode: 200,
        checkedAt: new Date(now - 5 * MINUTE),
      },
    ]);

    // Una incidencia abierta en el espacio propio y una resuelta con timeline.
    const [openIncident] = await db
      .insert(incidents)
      .values({
        monitorId,
        startedAt: new Date(now - 10 * MINUTE),
        cause: 'conexión rechazada',
      })
      .returning();
    if (!openIncident) throw new Error('no se pudo crear la incidencia abierta');

    const [resolvedIncident] = await db
      .insert(incidents)
      .values({
        monitorId,
        startedAt: new Date(now - 3 * HOUR),
        resolvedAt: new Date(now - 2 * HOUR),
        cause: 'tiempo agotado',
      })
      .returning();
    if (!resolvedIncident) throw new Error('no se pudo crear la incidencia resuelta');

    await db.insert(incidentEvents).values([
      { incidentId: resolvedIncident.id, kind: 'opened', happenedAt: new Date(now - 3 * HOUR) },
      { incidentId: resolvedIncident.id, kind: 'recovered', happenedAt: new Date(now - 2 * HOUR) },
    ]);

    // Una incidencia ajena: no debe aparecer nunca en la consulta propia.
    const [foreignMonitor] = await db
      .insert(monitors)
      .values({
        workspaceId: otherWorkspaceId,
        name: 'Caído ajeno',
        slug: 'caido-ajeno',
        type: 'http',
        url: 'https://example.net/',
      })
      .returning();
    if (!foreignMonitor) throw new Error('no se pudo crear el monitor ajeno');

    await db.insert(incidents).values({
      monitorId: foreignMonitor.id,
      startedAt: new Date(now - MINUTE),
      cause: 'némesis del test',
    });

    const env = loadEnv({
      NODE_ENV: 'test',
      DATABASE_URL: databaseUrl,
      LOG_LEVEL: 'silent',
      JWT_SECRET,
      ALLOW_PRIVATE_TARGETS: 'true',
    });
    app = buildServer({ env, database: db });
    await app.ready();

    // Canal webhook creado por la API (la guarda SSRF acepta 127.0.0.1 aquí).
    const created = await app.inject({
      method: 'POST',
      url: '/api/channels',
      headers: adminHeaders,
      payload: {
        type: 'webhook',
        workspaceId,
        name: 'Webhook de consola',
        config: { url: `${webhookBase}/ok` },
      },
    });
    expect(created.statusCode).toBe(201);
    channelId = (created.json() as { channel: { id: string } }).channel.id;

    // Dos entregas sembradas: una enviada y otra agotada.
    const payload: NotificationPayload = {
      kind: 'down',
      at: new Date(now - HOUR).toISOString(),
      monitor: {
        id: monitorId,
        name: 'API de ejemplo',
        slug: 'api-de-ejemplo',
        type: 'http',
        target: 'https://example.com/',
      },
      incident: {
        id: resolvedIncident.id,
        startedAt: new Date(now - 3 * HOUR).toISOString(),
        cause: 'tiempo agotado',
        durationSeconds: 3_600,
      },
      ssl: null,
    };

    await db.insert(deliveries).values([
      {
        channelId,
        monitorId,
        incidentId: resolvedIncident.id,
        kind: 'down',
        payload,
        status: 'sent',
        attempts: 1,
        sentAt: new Date(now - HOUR),
      },
      {
        channelId,
        monitorId,
        kind: 'ssl',
        payload: { ...payload, kind: 'ssl', incident: null, ssl: null },
        status: 'failed',
        attempts: 3,
        lastError: 'el webhook respondió 500',
      },
    ]);
  });

  afterAll(async () => {
    await app?.close();
    await new Promise<void>((resolve) => webhook?.close(() => resolve()));
    await ephemeral?.drop();
  });

  it('el listado incluye el espacio y acepta filtrar por workspaceId', async () => {
    const all = await app.inject({ method: 'GET', url: '/api/monitors', headers: adminHeaders });
    expect(all.statusCode).toBe(200);
    const monitorsAll = (
      all.json() as {
        monitors: Array<{
          workspaceId: string;
          name: string;
          stats: {
            day: { total: number; available: number; ratio: number | null };
            openIncidents: number;
          } | null;
        }>;
      }
    ).monitors;
    expect(monitorsAll).toHaveLength(2);
    expect(monitorsAll.every((row) => row.workspaceId === workspaceId)).toBe(true);

    // Estadísticas agregadas: 4 checks en 24 h (3 disponibles) y una abierta.
    const api = monitorsAll.find((row) => row.name === 'API de ejemplo');
    expect(api?.stats).toMatchObject({
      day: { total: 4, available: 3, ratio: 0.75 },
      openIncidents: 1,
    });

    // Sin checks: ratio nulo, nunca cero (lo que no se ha medido no es 0 %).
    const tcp = monitorsAll.find((row) => row.name === 'Puerto de respaldo');
    expect(tcp?.stats).toMatchObject({ day: { total: 0, ratio: null }, openIncidents: 0 });

    const filtered = await app.inject({
      method: 'GET',
      url: `/api/monitors?workspaceId=${workspaceId}`,
      headers: adminHeaders,
    });
    expect(filtered.statusCode).toBe(200);
    expect((filtered.json() as { monitors: unknown[] }).monitors).toHaveLength(2);

    const foreign = await app.inject({
      method: 'GET',
      url: `/api/monitors?workspaceId=${otherWorkspaceId}`,
      headers: adminHeaders,
    });
    expect(foreign.statusCode).toBe(403);

    const invalid = await app.inject({
      method: 'GET',
      url: '/api/monitors?workspaceId=no-es-uuid',
      headers: adminHeaders,
    });
    expect(invalid.statusCode).toBe(400);
  });

  it('los checks recientes llegan del más nuevo al más viejo y con límite', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/monitors/${monitorId}/checks`,
      headers: viewerHeaders,
    });
    expect(response.statusCode).toBe(200);

    const { checks } = response.json() as {
      checks: Array<{ status: string; latencyMs: number | null; error: string | null; at: string }>;
    };
    expect(checks).toHaveLength(4);
    expect(checks[0]).toMatchObject({ status: 'up', latencyMs: 150 });
    expect(checks[1]).toMatchObject({ status: 'down', error: 'conexión rechazada' });
    expect(checks[3]).toMatchObject({ status: 'up', latencyMs: 120 });

    const limited = await app.inject({
      method: 'GET',
      url: `/api/monitors/${monitorId}/checks?limit=2`,
      headers: viewerHeaders,
    });
    expect((limited.json() as { checks: unknown[] }).checks).toHaveLength(2);

    const badLimit = await app.inject({
      method: 'GET',
      url: `/api/monitors/${monitorId}/checks?limit=0`,
      headers: viewerHeaders,
    });
    expect(badLimit.statusCode).toBe(400);

    const stranger = await app.inject({
      method: 'GET',
      url: `/api/monitors/${monitorId}/checks`,
      headers: strangerHeaders,
    });
    expect(stranger.statusCode).toBe(403);

    const missing = await app.inject({
      method: 'GET',
      url: `/api/monitors/${randomUUID()}/checks`,
      headers: viewerHeaders,
    });
    expect(missing.statusCode).toBe(404);
  });

  it('las incidencias globales traen el monitor resuelto y respetan la frontera', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/incidents?workspaceId=${workspaceId}`,
      headers: viewerHeaders,
    });
    expect(response.statusCode).toBe(200);

    const { incidents: rows } = response.json() as {
      incidents: Array<{
        monitorName: string;
        open: boolean;
        durationSeconds: number;
        cause: string | null;
        events?: unknown;
      }>;
    };
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      monitorName: 'API de ejemplo',
      open: true,
      cause: 'conexión rechazada',
    });
    expect(rows[0]?.durationSeconds).toBeGreaterThan(0);
    expect(rows[1]).toMatchObject({ open: false, cause: 'tiempo agotado' });
    expect(rows[0]).not.toHaveProperty('events');

    const own = await app.inject({
      method: 'GET',
      url: '/api/incidents',
      headers: strangerHeaders,
    });
    const ownRows = (own.json() as { incidents: Array<{ cause: string | null }> }).incidents;
    expect(ownRows).toHaveLength(1);
    expect(ownRows[0]?.cause).toBe('némesis del test');

    const forbidden = await app.inject({
      method: 'GET',
      url: `/api/incidents?workspaceId=${workspaceId}`,
      headers: strangerHeaders,
    });
    expect(forbidden.statusCode).toBe(403);
  });

  it('el registro de entregas une canal y monitor y filtra por estado', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/deliveries?workspaceId=${workspaceId}`,
      headers: viewerHeaders,
    });
    expect(response.statusCode).toBe(200);

    const { deliveries: rows } = response.json() as {
      deliveries: Array<{
        channelName: string;
        monitorName: string;
        status: string;
        lastError: string | null;
      }>;
    };
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.channelName === 'Webhook de consola')).toBe(true);
    expect(rows.every((row) => row.monitorName === 'API de ejemplo')).toBe(true);

    const failed = await app.inject({
      method: 'GET',
      url: `/api/deliveries?workspaceId=${workspaceId}&status=failed`,
      headers: viewerHeaders,
    });
    const failedRows = (failed.json() as { deliveries: Array<{ lastError: string | null }> })
      .deliveries;
    expect(failedRows).toHaveLength(1);
    expect(failedRows[0]?.lastError).toBe('el webhook respondió 500');

    const bogus = await app.inject({
      method: 'GET',
      url: `/api/deliveries?workspaceId=${workspaceId}&status=inventado`,
      headers: viewerHeaders,
    });
    expect(bogus.statusCode).toBe(400);
  });

  it('el aviso de prueba entrega por el canal real y no encola nada', async () => {
    const before = received.length;

    const ok = await app.inject({
      method: 'POST',
      url: `/api/channels/${channelId}/test`,
      headers: adminHeaders,
    });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as { ok: boolean }).ok).toBe(true);

    expect(received).toHaveLength(before + 1);
    const last = received[received.length - 1];
    expect(last?.url).toBe('/ok');
    expect(last?.body).toContain('Prueba de Centinela');
    expect(last?.body).toContain('no hay ninguna incidencia real');

    // Un canal que rechaza: 502 con el motivo tal cual lo dio el canal.
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/channels/${channelId}`,
      headers: adminHeaders,
      payload: { config: { url: `${webhookBase}/fail` } },
    });
    expect(patched.statusCode).toBe(200);

    const failed = await app.inject({
      method: 'POST',
      url: `/api/channels/${channelId}/test`,
      headers: adminHeaders,
    });
    expect(failed.statusCode).toBe(502);
    expect((failed.json() as { error: string }).error).toContain('500');

    // Un viewer no puede lanzar pruebas.
    const viewer = await app.inject({
      method: 'POST',
      url: `/api/channels/${channelId}/test`,
      headers: viewerHeaders,
    });
    expect(viewer.statusCode).toBe(403);

    // La prueba no crea filas en la cola de entregas.
    const list = await app.inject({
      method: 'GET',
      url: `/api/deliveries?workspaceId=${workspaceId}`,
      headers: adminHeaders,
    });
    expect((list.json() as { deliveries: unknown[] }).deliveries).toHaveLength(2);

    // Y queda en la auditoría del espacio.
    const audit = await app.inject({
      method: 'GET',
      url: `/api/audit?workspaceId=${workspaceId}`,
      headers: adminHeaders,
    });
    const entries = (audit.json() as { entries: Array<{ action: string }> }).entries;
    expect(entries.filter((entry) => entry.action === 'channel.test')).toHaveLength(2);
  });
});
