import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { asc, eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { FastifyBaseLogger } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnvFileIfPresent } from '../config/env.js';
import { createDatabase, type Database } from '../db/client.js';
import { checkResults, monitors, workspaces } from '../db/schema.js';
import { runWorkerOnce } from './worker.js';

loadEnvFileIfPresent();

const TEST_DB_NAME = 'centinela_test';
const databaseUrl = process.env.DATABASE_URL ?? '';
const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));

/** Logger mudo: los tests no ensucian la salida. */
const silentLog = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as FastifyBaseLogger;

async function canReachDatabase(url: string): Promise<boolean> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 2000 });
  try {
    await client.connect();
    await client.query('select 1');
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

const dbAvailable = databaseUrl !== '' && (await canReachDatabase(databaseUrl));

if (!dbAvailable) {
  console.warn('PostgreSQL no disponible: la prueba de integración del worker se salta.');
}

/**
 * Integración real: base de datos propia y efímera (`centinela_test`), el
 * esquema aplicado con migraciones y un servidor HTTP local como vigilado.
 */
describe.runIf(dbAvailable)('worker — integración con PostgreSQL', () => {
  let admin: pg.Pool;
  let pool: pg.Pool;
  let db: Database;
  let server: Server;
  let closedPort: number;
  let monitorId: string;

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    await admin.query(`drop database if exists ${TEST_DB_NAME} with (force)`);
    await admin.query(`create database ${TEST_DB_NAME}`);

    const testUrl = new URL(databaseUrl);
    testUrl.pathname = `/${TEST_DB_NAME}`;
    const created = createDatabase(testUrl.toString());
    pool = created.pool;
    db = created.db;
    await migrate(db, { migrationsFolder });

    // Servidor que hará de "servicio vigilado".
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('centinela ok');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const openPort = typeof address === 'object' && address ? address.port : 0;

    // Y un puerto cerrado para simular una caída.
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const probeAddress = probe.address();
    closedPort = typeof probeAddress === 'object' && probeAddress ? probeAddress.port : 0;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const [workspace] = await db
      .insert(workspaces)
      .values({ name: 'Tests', slug: `tests-${randomUUID()}` })
      .returning();
    if (!workspace) throw new Error('no se pudo crear el espacio de trabajo');

    const [monitor] = await db
      .insert(monitors)
      .values({
        workspaceId: workspace.id,
        name: 'Servicio de prueba',
        slug: 'servicio-de-prueba',
        type: 'http',
        url: `http://127.0.0.1:${openPort}/`,
        intervalSeconds: 60,
        confirmFailures: 1,
        confirmRecoveries: 1,
      })
      .returning();
    if (!monitor) throw new Error('no se pudo crear el monitor');
    monitorId = monitor.id;
  });

  afterAll(async () => {
    await pool?.end().catch(() => {});
    await admin?.query(`drop database if exists ${TEST_DB_NAME} with (force)`).catch(() => {});
    await admin?.end().catch(() => {});
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  const deps = () => ({
    db,
    log: silentLog,
    config: { tickMs: 500, batchSize: 10, concurrency: 3, allowPrivateTargets: true },
  });

  it('reclama el monitor vencido, lo chequea y programa el siguiente', async () => {
    const processed = await runWorkerOnce(deps());

    expect(processed).toBe(1);

    const [monitor] = await db.select().from(monitors).where(eq(monitors.id, monitorId));
    expect(monitor?.state).toBe('up');
    expect(monitor?.lastCheckAt).not.toBeNull();
    expect(monitor?.lastStateChangeAt).not.toBeNull();
    expect(monitor?.consecutiveSuccesses).toBe(1);

    // El siguiente check queda programado con el intervalo (±10 % de jitter).
    const secondsAhead = (monitor!.nextCheckAt.getTime() - Date.now()) / 1000;
    expect(secondsAhead).toBeGreaterThan(45);
    expect(secondsAhead).toBeLessThan(75);

    const results = await db
      .select()
      .from(checkResults)
      .where(eq(checkResults.monitorId, monitorId))
      .orderBy(asc(checkResults.id));

    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe('up');
    expect(results[0]?.statusCode).toBe(200);
  });

  it('no vuelve a reclamar un monitor ya programado', async () => {
    const processed = await runWorkerOnce(deps());

    expect(processed).toBe(0);
  });

  it('un fallo confirmado cambia el estado a down y queda registrado', async () => {
    await db
      .update(monitors)
      .set({ url: `http://127.0.0.1:${closedPort}/`, nextCheckAt: sql`now()` })
      .where(eq(monitors.id, monitorId));

    const processed = await runWorkerOnce(deps());

    expect(processed).toBe(1);

    const [monitor] = await db.select().from(monitors).where(eq(monitors.id, monitorId));
    expect(monitor?.state).toBe('down');
    expect(monitor?.consecutiveFailures).toBe(1);

    const results = await db
      .select()
      .from(checkResults)
      .where(eq(checkResults.monitorId, monitorId))
      .orderBy(asc(checkResults.id));

    const last = results.at(-1);
    expect(last?.status).toBe('down');
    expect(last?.error).toContain('rechazada');
  });

  it('un monitor pausado no se reclama', async () => {
    await db
      .update(monitors)
      .set({ paused: true, nextCheckAt: sql`now()` })
      .where(eq(monitors.id, monitorId));

    const processed = await runWorkerOnce(deps());

    expect(processed).toBe(0);
  });
});
