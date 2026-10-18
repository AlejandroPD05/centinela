import { randomUUID } from 'node:crypto';
import { createServer, type Server as HttpServer } from 'node:http';
import type { NotificationPayload } from '@centinela/shared';
import { asc, eq, sql } from 'drizzle-orm';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
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
  notificationChannels,
  users,
  workspaces,
} from '../db/schema.js';
import {
  canReachDatabase,
  createEphemeralDatabase,
  type EphemeralDatabase,
} from '../test/support.js';
import { recordSslResult } from '../worker/process.js';
import { runWorkerOnce } from '../worker/worker.js';

loadEnvFileIfPresent();

const databaseUrl = process.env.DATABASE_URL ?? '';
const dbAvailable = databaseUrl !== '' && (await canReachDatabase(databaseUrl));

if (!dbAvailable) {
  console.warn('PostgreSQL no disponible: la prueba de integración de avisos se salta.');
}

const JWT_SECRET = 'secreto-de-integracion-de-avisos-1234567890';

/** Logger mudo: los tests no ensucian la salida. */
const silentLog = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as FastifyBaseLogger;

/**
 * Integración de punta a punta de M3: canales por API, latidos que entran y
 * caducan, incidencias que avisan por webhook (servidor local que apunta lo
 * recibido), reintentos con backoff y etapas de aviso SSL.
 */
describe.runIf(dbAvailable)('avisos y latidos — integración con PostgreSQL', () => {
  let ephemeral: EphemeralDatabase;
  let app: FastifyInstance;
  let listener: HttpServer;
  let listenerPort = 0;
  let workspaceId: string;
  let heartbeatMonitorId: string;
  let headers: { authorization: string };
  const received: Array<Record<string, unknown>> = [];
  const heartbeatToken = 'latido-de-prueba-01';

  beforeAll(async () => {
    ephemeral = await createEphemeralDatabase(databaseUrl, 'centinela_test_notify');

    // Servidor local que hace de webhook receptor y apunta lo que le llega.
    listener = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        try {
          received.push(JSON.parse(body) as Record<string, unknown>);
        } catch {
          received.push({ raw: body });
        }
        response.writeHead(202, { 'content-type': 'application/json' });
        response.end('{"ok":true}');
      });
    });
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
    const address = listener.address();
    listenerPort = typeof address === 'object' && address ? address.port : 0;

    const { db } = ephemeral;

    const [workspace] = await db
      .insert(workspaces)
      .values({ name: 'Avisos', slug: `avisos-${randomUUID()}` })
      .returning();
    if (!workspace) throw new Error('no se pudo crear el espacio de trabajo');
    workspaceId = workspace.id;

    // Usuario con acceso al espacio: el CRUD de canales pide token desde M4.
    const [user] = await db
      .insert(users)
      .values({
        email: 'avisos@example.com',
        name: 'Personal de avisos',
        passwordHash: await hashPassword('prueba-de-integracion-2026'),
      })
      .returning();
    if (!user) throw new Error('no se pudo crear el usuario');

    await db.insert(memberships).values({ userId: user.id, workspaceId, role: 'admin' });

    headers = {
      authorization: `Bearer ${signAccessToken(
        { sub: user.id, email: user.email, name: user.name },
        JWT_SECRET,
        3_600,
      )}`,
    };

    const [monitor] = await db
      .insert(monitors)
      .values({
        workspaceId,
        name: 'Cron nocturno',
        slug: 'cron-nocturno',
        type: 'heartbeat',
        heartbeatToken,
        heartbeatPeriodSeconds: 5,
        heartbeatGraceSeconds: 5,
        intervalSeconds: 10,
        confirmFailures: 1,
        confirmRecoveries: 1,
        lastCheckAt: new Date(Date.now() - 60_000),
      })
      .returning();
    if (!monitor) throw new Error('no se pudo crear el monitor de latido');
    heartbeatMonitorId = monitor.id;

    const env = loadEnv({
      NODE_ENV: 'test',
      DATABASE_URL: databaseUrl,
      LOG_LEVEL: 'silent',
      JWT_SECRET,
      // El receptor del test vive en 127.0.0.1: la guarda SSRF debe permitirlo.
      ALLOW_PRIVATE_TARGETS: 'true',
    });
    app = buildServer({ env, database: db });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await ephemeral?.drop();
    listener?.closeAllConnections();
    await new Promise<void>((resolve) => listener?.close(() => resolve()));
  });

  const deps = () => ({
    db: ephemeral.db,
    log: silentLog,
    config: {
      tickMs: 250,
      batchSize: 10,
      concurrency: 4,
      allowPrivateTargets: true,
      sslRecheckHours: 24,
    },
  });

  it('gestiona canales de aviso por API', async () => {
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/channels',
      headers,
      payload: { type: 'discord', name: 'sin webhook', workspaceId, config: {} },
    });
    expect(invalid.statusCode).toBe(400);

    const created = await app.inject({
      method: 'POST',
      url: '/api/channels',
      headers,
      payload: {
        type: 'webhook',
        name: 'bandeja de pruebas',
        workspaceId,
        config: { url: `http://127.0.0.1:${listenerPort}/alertas` },
      },
    });
    expect(created.statusCode).toBe(201);

    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/channels',
      headers,
      payload: {
        type: 'webhook',
        name: 'bandeja de pruebas',
        workspaceId,
        config: { url: `http://127.0.0.1:${listenerPort}/alertas` },
      },
    });
    expect(duplicate.statusCode).toBe(409);

    const list = await app.inject({ method: 'GET', url: '/api/channels', headers });
    expect(list.statusCode).toBe(200);
    expect(list.json<{ channels: unknown[] }>().channels).toHaveLength(1);

    const channelId = created.json<{ channel: { id: string } }>().channel.id;

    const disabled = await app.inject({
      method: 'PATCH',
      url: `/api/channels/${channelId}`,
      headers,
      payload: { enabled: false },
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json<{ channel: { enabled: boolean } }>().channel.enabled).toBe(false);

    const reenabled = await app.inject({
      method: 'PATCH',
      url: `/api/channels/${channelId}`,
      headers,
      payload: { enabled: true },
    });
    expect(reenabled.json<{ channel: { enabled: boolean } }>().channel.enabled).toBe(true);
  });

  it('rechaza canales que apuntan a rangos internos', async () => {
    const strictEnv = loadEnv({
      NODE_ENV: 'test',
      DATABASE_URL: databaseUrl,
      LOG_LEVEL: 'silent',
      JWT_SECRET,
    });
    const strictApp = buildServer({ env: strictEnv, database: ephemeral.db });
    await strictApp.ready();

    const blocked = await strictApp.inject({
      method: 'POST',
      url: '/api/channels',
      headers,
      payload: {
        type: 'webhook',
        name: 'metadatos',
        workspaceId,
        config: { url: 'http://169.254.169.254/latest/meta-data/' },
      },
    });

    expect(blocked.statusCode).toBe(400);
    expect(blocked.json<{ error: string }>().error).toContain('bloqueado');

    await strictApp.close();
  });

  it('devuelve 404 con un token de latido desconocido', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/heartbeats/token-que-no-existe',
    });
    expect(response.statusCode).toBe(404);
  });

  it('la ausencia de latido abre incidencia y entrega el aviso', async () => {
    const processed = await runWorkerOnce(deps());
    expect(processed).toBe(1);

    const [monitor] = await ephemeral.db
      .select()
      .from(monitors)
      .where(eq(monitors.id, heartbeatMonitorId));
    expect(monitor?.state).toBe('down');

    const results = await ephemeral.db
      .select()
      .from(checkResults)
      .where(eq(checkResults.monitorId, heartbeatMonitorId));
    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe('down');
    expect(results[0]?.error).toContain('sin latidos');

    const sent = await ephemeral.db
      .select()
      .from(deliveries)
      .where(eq(deliveries.monitorId, heartbeatMonitorId));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.status).toBe('sent');
    expect(sent[0]?.attempts).toBe(1);

    expect(received).toHaveLength(1);
    const payload = received[0] as {
      kind: string;
      monitor: { name: string };
      summary: string;
    };
    expect(payload.kind).toBe('down');
    expect(payload.monitor.name).toBe('Cron nocturno');
    expect(payload.summary).toContain('CAÍDA');

    const [incident] = await ephemeral.db
      .select()
      .from(incidents)
      .where(eq(incidents.monitorId, heartbeatMonitorId));
    expect(incident?.resolvedAt).toBeNull();

    const events = await ephemeral.db
      .select()
      .from(incidentEvents)
      .where(eq(incidentEvents.incidentId, incident!.id))
      .orderBy(asc(incidentEvents.id));
    expect(events.map((event) => event.kind)).toEqual(['opened', 'notified']);
  });

  it('el latido devuelve el monitor a la vida y avisa de la recuperación', async () => {
    const beat = await app.inject({ method: 'POST', url: `/api/heartbeats/${heartbeatToken}` });
    expect(beat.statusCode).toBe(200);
    expect(beat.json<{ state: string }>().state).toBe('up');

    const [monitor] = await ephemeral.db
      .select()
      .from(monitors)
      .where(eq(monitors.id, heartbeatMonitorId));
    expect(monitor?.state).toBe('up');

    const [incident] = await ephemeral.db
      .select()
      .from(incidents)
      .where(eq(incidents.monitorId, heartbeatMonitorId));
    expect(incident?.resolvedAt).not.toBeNull();

    const processed = await runWorkerOnce(deps());
    expect(processed).toBe(0); // el latido ya reprogramó el plazo

    expect(received).toHaveLength(2);
    const recovered = received[1] as { kind: string; summary: string };
    expect(recovered.kind).toBe('recovered');
    expect(recovered.summary).toContain('RECUPERADO');

    const events = await ephemeral.db
      .select()
      .from(incidentEvents)
      .where(eq(incidentEvents.incidentId, incident!.id))
      .orderBy(asc(incidentEvents.id));
    expect(events.map((event) => event.kind)).toEqual([
      'opened',
      'notified',
      'recovered',
      'notified',
    ]);

    // Aparca el monitor para que no interfiera con los tests siguientes.
    await ephemeral.db
      .update(monitors)
      .set({ nextCheckAt: sql`now() + interval '1 hour'`, lastCheckAt: sql`now()` })
      .where(eq(monitors.id, heartbeatMonitorId));
  });

  it('acepta latidos sin cuerpo ni content-type JSON', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/heartbeats/${heartbeatToken}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ state: string }>().state).toBe('up');
  });

  it('reintenta con backoff y acaba descartando la entrega', async () => {
    const [channel] = await ephemeral.db
      .insert(notificationChannels)
      .values({
        workspaceId,
        type: 'webhook',
        name: 'puerto muerto',
        config: { url: 'http://127.0.0.1:1/' },
      })
      .returning();
    if (!channel) throw new Error('no se pudo crear el canal');

    const payloadFixture: NotificationPayload = {
      kind: 'ssl',
      at: new Date().toISOString(),
      monitor: {
        id: heartbeatMonitorId,
        name: 'Cron nocturno',
        slug: 'cron-nocturno',
        type: 'heartbeat',
        target: 'latido cada 5 s',
      },
      incident: null,
      ssl: { expiresAt: new Date().toISOString(), issuer: 'Test', daysLeft: 20 },
    };

    const [delivery] = await ephemeral.db
      .insert(deliveries)
      .values({
        channelId: channel.id,
        monitorId: heartbeatMonitorId,
        kind: 'ssl',
        payload: payloadFixture,
      })
      .returning();
    if (!delivery) throw new Error('no se pudo crear la entrega');

    await runWorkerOnce(deps());
    let [row] = await ephemeral.db.select().from(deliveries).where(eq(deliveries.id, delivery.id));
    expect(row?.status).toBe('pending');
    expect(row?.attempts).toBe(1);
    expect(row?.lastError).toContain('no se pudo entregar');
    expect(row!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 20_000);

    for (const expected of [2, 3]) {
      await ephemeral.db
        .update(deliveries)
        .set({ nextAttemptAt: sql`now()` })
        .where(eq(deliveries.id, delivery.id));

      await runWorkerOnce(deps());

      [row] = await ephemeral.db.select().from(deliveries).where(eq(deliveries.id, delivery.id));
      expect(row?.attempts).toBe(expected);
    }

    expect(row?.status).toBe('failed');

    // Este canal ya no debe recibir más tráfico.
    await ephemeral.db
      .update(notificationChannels)
      .set({ enabled: false })
      .where(eq(notificationChannels.id, channel.id));
  });

  it('avisa por caducidad SSL solo al cruzar cada umbral', async () => {
    const [sslMonitor] = await ephemeral.db
      .insert(monitors)
      .values({
        workspaceId,
        name: 'Web pública',
        slug: 'web-publica',
        type: 'http',
        url: 'https://example.com/',
        nextCheckAt: sql`now() + interval '1 hour'`,
        sslCheckedAt: sql`now()`,
      })
      .returning();
    if (!sslMonitor) throw new Error('no se pudo crear el monitor https');

    const sslDeps = { db: ephemeral.db, log: silentLog, allowPrivateTargets: true };
    const expiring = (days: number) => ({
      ok: true as const,
      expiresAt: new Date(Date.now() + days * 86_400_000),
      issuer: 'Test CA',
    });

    await recordSslResult(sslDeps, sslMonitor, expiring(20));
    let [row] = await ephemeral.db.select().from(monitors).where(eq(monitors.id, sslMonitor.id));
    expect(row?.sslAlertStage).toBe(1);

    await runWorkerOnce(deps());
    expect((received.at(-1) as { kind: string }).kind).toBe('ssl');
    const afterFirst = received.length;

    // Mismo umbral: no repite aviso aunque se vuelva a sondear.
    await recordSslResult(sslDeps, sslMonitor, expiring(18));
    await runWorkerOnce(deps());
    expect(received.length).toBe(afterFirst);

    // Umbral nuevo: 9 días cruza el segundo umbral (14).
    await recordSslResult(sslDeps, sslMonitor, expiring(10));
    [row] = await ephemeral.db.select().from(monitors).where(eq(monitors.id, sslMonitor.id));
    expect(row?.sslAlertStage).toBe(2);

    await runWorkerOnce(deps());
    expect(received.length).toBe(afterFirst + 1);
    expect((received.at(-1) as { kind: string }).kind).toBe('ssl');

    // Renovación: la etapa vuelve a cero sin avisar.
    await recordSslResult(sslDeps, sslMonitor, expiring(100));
    [row] = await ephemeral.db.select().from(monitors).where(eq(monitors.id, sslMonitor.id));
    expect(row?.sslAlertStage).toBe(0);

    await runWorkerOnce(deps());
    expect(received.length).toBe(afterFirst + 1);

    const sslDeliveries = await ephemeral.db
      .select()
      .from(deliveries)
      .where(eq(deliveries.monitorId, sslMonitor.id));
    expect(sslDeliveries).toHaveLength(2);
    expect(sslDeliveries.every((delivery) => delivery.status === 'sent')).toBe(true);
  });
});
