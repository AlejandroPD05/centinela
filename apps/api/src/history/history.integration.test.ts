import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../app.js';
import { loadEnv, loadEnvFileIfPresent } from '../config/env.js';
import { checkResults, incidentEvents, incidents, monitors, workspaces } from '../db/schema.js';
import {
  canReachDatabase,
  createEphemeralDatabase,
  type EphemeralDatabase,
} from '../test/support.js';
import type { DailyBucket, IncidentRecord, UptimeSummary } from './queries.js';

loadEnvFileIfPresent();

const databaseUrl = process.env.DATABASE_URL ?? '';
const dbAvailable = databaseUrl !== '' && (await canReachDatabase(databaseUrl));

if (!dbAvailable) {
  console.warn('PostgreSQL no disponible: la prueba de integración del histórico se salta.');
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * Integración del histórico de punta a punta: base efímera con datos
 * sembrados a mano y la API real respondiendo por `app.inject()`. Las marcas
 * de tiempo se calculan sobre `now` para que las ventanas no dependan del
 * reloj del día en que se ejecute el test.
 */
describe.runIf(dbAvailable)('histórico — integración con PostgreSQL', () => {
  let ephemeral: EphemeralDatabase;
  let app: FastifyInstance;
  let monitorId: string;
  const now = Date.now();

  beforeAll(async () => {
    ephemeral = await createEphemeralDatabase(databaseUrl, 'centinela_test_history');
    const { db } = ephemeral;

    const [workspace] = await db
      .insert(workspaces)
      .values({ name: 'Histórico', slug: `historico-${randomUUID()}` })
      .returning();
    if (!workspace) throw new Error('no se pudo crear el espacio de trabajo');

    const [monitor] = await db
      .insert(monitors)
      .values({
        workspaceId: workspace.id,
        name: 'API de ejemplo',
        slug: 'api-de-ejemplo',
        type: 'http',
        url: 'https://example.com/',
      })
      .returning();
    if (!monitor) throw new Error('no se pudo crear el monitor');
    monitorId = monitor.id;

    // Cuatro checks recientes (3 h de margen para no depender de la hora
    // exacta) y uno de hace 10 días, fuera de las ventanas cortas.
    await db.insert(checkResults).values([
      {
        monitorId,
        status: 'up',
        latencyMs: 100,
        statusCode: 200,
        checkedAt: new Date(now - 3 * HOUR),
      },
      {
        monitorId,
        status: 'up',
        latencyMs: 200,
        statusCode: 200,
        checkedAt: new Date(now - 2 * HOUR),
      },
      { monitorId, status: 'down', error: 'conexión rechazada', checkedAt: new Date(now - HOUR) },
      {
        monitorId,
        status: 'degraded',
        latencyMs: 300,
        statusCode: 200,
        checkedAt: new Date(now - HOUR / 2),
      },
      {
        monitorId,
        status: 'up',
        latencyMs: 50,
        statusCode: 200,
        checkedAt: new Date(now - 10 * DAY),
      },
    ]);

    const [incident] = await db
      .insert(incidents)
      .values({
        monitorId,
        startedAt: new Date(now - HOUR),
        resolvedAt: new Date(now - HOUR / 2),
        cause: 'conexión rechazada',
      })
      .returning();
    if (!incident) throw new Error('no se pudo crear la incidencia');

    await db.insert(incidentEvents).values([
      {
        incidentId: incident.id,
        kind: 'opened',
        detail: 'conexión rechazada',
        happenedAt: new Date(now - HOUR),
      },
      { incidentId: incident.id, kind: 'recovered', happenedAt: new Date(now - HOUR / 2) },
    ]);

    const env = loadEnv({ NODE_ENV: 'test', DATABASE_URL: databaseUrl, LOG_LEVEL: 'silent' });
    app = buildServer({ env, database: db });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await ephemeral?.drop();
  });

  it('el resumen 24h calcula disponibilidad y percentiles', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/monitors/${monitorId}/uptime?window=24h`,
    });

    expect(response.statusCode).toBe(200);

    const payload = response.json<UptimeSummary>();
    expect(payload.checks).toEqual({ total: 4, available: 3, failed: 1 });
    expect(payload.availability).toBeCloseTo(0.75, 5);
    expect(payload.latencyMs.p50).toBeCloseTo(200, 1);
    expect(payload.latencyMs.p95).toBeCloseTo(290, 1);
    expect(payload.latencyMs.p99).toBeCloseTo(298, 1);
  });

  it('cada ventana acota los datos que le tocan', async () => {
    const week = await app.inject({
      method: 'GET',
      url: `/api/monitors/${monitorId}/uptime?window=7d`,
    });
    const month = await app.inject({
      method: 'GET',
      url: `/api/monitors/${monitorId}/uptime?window=30d`,
    });

    expect(week.json<UptimeSummary>().checks.total).toBe(4);
    expect(month.json<UptimeSummary>().checks).toEqual({ total: 5, available: 4, failed: 1 });
    expect(month.json<UptimeSummary>().availability).toBeCloseTo(0.8, 5);
  });

  it('la serie diaria rellena los días sin datos con null', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/monitors/${monitorId}/history?days=30`,
    });

    expect(response.statusCode).toBe(200);

    const payload = response.json<{ days: number; buckets: DailyBucket[] }>();
    expect(payload.days).toBe(30);
    expect(payload.buckets).toHaveLength(30);

    const byDate = new Map(payload.buckets.map((bucket) => [bucket.date, bucket]));
    const dayKey = (msAgo: number) => new Date(now - msAgo).toISOString().slice(0, 10);

    const old = byDate.get(dayKey(10 * DAY));
    expect(old?.total).toBe(1);
    expect(old?.availability).toBe(1);
    expect(old?.avgLatencyMs).toBe(50);

    const gap = byDate.get(dayKey(5 * DAY));
    expect(gap?.total).toBe(0);
    expect(gap?.availability).toBeNull();
    expect(gap?.avgLatencyMs).toBeNull();

    const recent = payload.buckets.filter(
      (bucket) => bucket.total > 0 && bucket.date !== dayKey(10 * DAY),
    );
    const total = recent.reduce((sum, bucket) => sum + bucket.total, 0);
    const available = recent.reduce((sum, bucket) => sum + bucket.available, 0);
    expect(total).toBe(4);
    expect(available).toBe(3);
  });

  it('lista las incidencias con su timeline y duración', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/monitors/${monitorId}/incidents`,
    });

    expect(response.statusCode).toBe(200);

    const payload = response.json<{ incidents: IncidentRecord[] }>();
    expect(payload.incidents).toHaveLength(1);

    const incident = payload.incidents[0];
    expect(incident?.durationSeconds).toBe(1800);
    expect(incident?.cause).toBe('conexión rechazada');
    expect(incident?.resolvedAt).not.toBeNull();
    expect(incident?.events.map((event) => event.kind)).toEqual(['opened', 'recovered']);
  });

  it('el listado de monitores no filtra el token de heartbeat', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/monitors' });

    expect(response.statusCode).toBe(200);

    const payload = response.json<{ monitors: Array<Record<string, unknown>> }>();
    const listed = payload.monitors.find((candidate) => candidate.id === monitorId);
    expect(listed).toBeDefined();
    expect('heartbeatToken' in listed!).toBe(false);
    expect((listed!.ssl as { expiresAt: string | null } | null)?.expiresAt).toBeNull();
  });

  it('responde con 400 o 404 cuando la petición no es válida', async () => {
    const missing = await app.inject({
      method: 'GET',
      url: `/api/monitors/${randomUUID()}/uptime`,
    });
    expect(missing.statusCode).toBe(404);

    const badWindow = await app.inject({
      method: 'GET',
      url: `/api/monitors/${monitorId}/uptime?window=99y`,
    });
    expect(badWindow.statusCode).toBe(400);

    const badDays = await app.inject({
      method: 'GET',
      url: `/api/monitors/${monitorId}/history?days=0`,
    });
    expect(badDays.statusCode).toBe(400);

    const badId = await app.inject({ method: 'GET', url: '/api/monitors/no-es-uuid' });
    expect(badId.statusCode).toBe(400);
  });
});
