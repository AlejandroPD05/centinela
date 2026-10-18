import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import type { Socket } from 'node:net';
import { createServer as createTlsServer, type Server as TlsServer } from 'node:tls';
import { asc, eq, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnvFileIfPresent } from '../config/env.js';
import { checkResults, incidentEvents, incidents, monitors, workspaces } from '../db/schema.js';
import {
  canReachDatabase,
  createEphemeralDatabase,
  type EphemeralDatabase,
} from '../test/support.js';
import { runWorkerOnce, startWorker } from './worker.js';

loadEnvFileIfPresent();

const databaseUrl = process.env.DATABASE_URL ?? '';
const tlsKey = readFileSync(new URL('../checks/__fixtures__/tls-key.pem', import.meta.url));
const tlsCert = readFileSync(new URL('../checks/__fixtures__/tls-cert.pem', import.meta.url));

/** Logger mudo: los tests no ensucian la salida. */
const silentLog = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as FastifyBaseLogger;

/** Espera activa: sondea una condición hasta que se cumple o se agota el plazo. */
async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('no se cumplió la condición a tiempo');
}

const dbAvailable = databaseUrl !== '' && (await canReachDatabase(databaseUrl));

if (!dbAvailable) {
  console.warn('PostgreSQL no disponible: la prueba de integración del worker se salta.');
}

/**
 * Integración real: base de datos efímera con migraciones, un servidor HTTP
 * local como servicio vigilado, un servidor TLS para comprobar el sondeo de
 * certificados y un puerto cerrado para simular caídas.
 */
describe.runIf(dbAvailable)('worker — integración con PostgreSQL', () => {
  let ephemeral: EphemeralDatabase;
  let httpServer: HttpServer;
  let tlsServer: TlsServer;
  const tlsSockets = new Set<Socket>();
  let httpPort = 0;
  let closedPort = 0;
  let monitorId: string;
  let httpsMonitorId: string;
  /** Avisos recibidos en /deadman (prueba del dead-man switch). */
  let deadManPings = 0;

  beforeAll(async () => {
    ephemeral = await createEphemeralDatabase(databaseUrl, 'centinela_test_worker');

    // Servicio vigilado (HTTP); /deadman hace de servicio dead-man.
    httpServer = createHttpServer((request, response) => {
      if (request.url === '/deadman') deadManPings += 1;
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('centinela ok');
    });
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const httpAddress = httpServer.address();
    httpPort = typeof httpAddress === 'object' && httpAddress ? httpAddress.port : 0;

    // Servicio con TLS autofirmado (para el sondeo del certificado).
    tlsServer = createTlsServer({ key: tlsKey, cert: tlsCert }, (socket) => socket.end());
    tlsServer.on('connection', (socket) => {
      tlsSockets.add(socket);
      socket.on('close', () => tlsSockets.delete(socket));
    });
    await new Promise<void>((resolve) => tlsServer.listen(0, '127.0.0.1', resolve));
    const tlsAddress = tlsServer.address();
    const tlsPort = typeof tlsAddress === 'object' && tlsAddress ? tlsAddress.port : 0;

    // Puerto que se cierra al momento: nadie escucha en él.
    const probe = createHttpServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const probeAddress = probe.address();
    closedPort = typeof probeAddress === 'object' && probeAddress ? probeAddress.port : 0;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const { db } = ephemeral;

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
        url: `http://127.0.0.1:${httpPort}/`,
        intervalSeconds: 60,
        confirmFailures: 1,
        confirmRecoveries: 1,
      })
      .returning();
    if (!monitor) throw new Error('no se pudo crear el monitor');
    monitorId = monitor.id;

    // Monitor https que no se chequea aún (programado a una hora vista) pero
    // sí toca sondear su certificado: el worker lo hace en el lote SSL.
    const [httpsMonitor] = await db
      .insert(monitors)
      .values({
        workspaceId: workspace.id,
        name: 'Servicio con TLS',
        slug: 'servicio-tls',
        type: 'http',
        url: `https://127.0.0.1:${tlsPort}/`,
        intervalSeconds: 3600,
        nextCheckAt: sql`now() + interval '1 hour'`,
        confirmFailures: 99,
        confirmRecoveries: 1,
      })
      .returning();
    if (!httpsMonitor) throw new Error('no se pudo crear el monitor https');
    httpsMonitorId = httpsMonitor.id;
  });

  afterAll(async () => {
    await ephemeral?.drop();

    for (const socket of tlsSockets) socket.destroy();

    if (httpServer) {
      httpServer.closeAllConnections();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
    if (tlsServer) {
      await new Promise<void>((resolve) => tlsServer.close(() => resolve()));
    }
  });

  const deps = () => ({
    db: ephemeral.db,
    log: silentLog,
    config: {
      tickMs: 500,
      batchSize: 10,
      concurrency: 3,
      allowPrivateTargets: true,
      sslRecheckHours: 24,
      stallSeconds: 300,
      selfPingSeconds: 300,
    },
  });

  it('reclama el monitor vencido, lo chequea, programa el siguiente y sondea el TLS', async () => {
    const processed = await runWorkerOnce(deps());

    expect(processed).toBe(1);

    const [monitor] = await ephemeral.db.select().from(monitors).where(eq(monitors.id, monitorId));
    expect(monitor?.state).toBe('up');
    expect(monitor?.lastCheckAt).not.toBeNull();
    expect(monitor?.lastStateChangeAt).not.toBeNull();
    expect(monitor?.consecutiveSuccesses).toBe(1);

    // El siguiente check queda programado con el intervalo (±10 % de jitter).
    const secondsAhead = (monitor!.nextCheckAt.getTime() - Date.now()) / 1000;
    expect(secondsAhead).toBeGreaterThan(45);
    expect(secondsAhead).toBeLessThan(75);

    const results = await ephemeral.db
      .select()
      .from(checkResults)
      .where(eq(checkResults.monitorId, monitorId))
      .orderBy(asc(checkResults.id));

    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe('up');
    expect(results[0]?.statusCode).toBe(200);

    // El monitor https no se chequeó (no le toca) pero su certificado sí se leyó.
    const [httpsMonitor] = await ephemeral.db
      .select()
      .from(monitors)
      .where(eq(monitors.id, httpsMonitorId));
    expect(httpsMonitor?.state).toBe('pending');
    expect(httpsMonitor?.sslCheckedAt).not.toBeNull();
    expect(httpsMonitor?.sslExpiresAt).not.toBeNull();
    expect(httpsMonitor?.sslIssuer).toContain('centinela-test');

    const daysToExpiry = (httpsMonitor!.sslExpiresAt!.getTime() - Date.now()) / 86_400_000;
    expect(daysToExpiry).toBeGreaterThan(3600);
  });

  it('no vuelve a reclamar nada ya programado ni revisa otra vez el TLS', async () => {
    const before = await ephemeral.db
      .select({ checkedAt: monitors.sslCheckedAt })
      .from(monitors)
      .where(eq(monitors.id, httpsMonitorId));

    const processed = await runWorkerOnce(deps());

    expect(processed).toBe(0);

    const after = await ephemeral.db
      .select({ checkedAt: monitors.sslCheckedAt })
      .from(monitors)
      .where(eq(monitors.id, httpsMonitorId));
    expect(after[0]?.checkedAt?.getTime()).toBe(before[0]?.checkedAt?.getTime());
  });

  it('al confirmar la caída abre una incidencia con su evento de apertura', async () => {
    await ephemeral.db
      .update(monitors)
      .set({ url: `http://127.0.0.1:${closedPort}/`, nextCheckAt: sql`now()` })
      .where(eq(monitors.id, monitorId));

    const processed = await runWorkerOnce(deps());

    expect(processed).toBe(1);

    const [monitor] = await ephemeral.db.select().from(monitors).where(eq(monitors.id, monitorId));
    expect(monitor?.state).toBe('down');
    expect(monitor?.consecutiveFailures).toBe(1);

    const results = await ephemeral.db
      .select()
      .from(checkResults)
      .where(eq(checkResults.monitorId, monitorId))
      .orderBy(asc(checkResults.id));
    const last = results.at(-1);
    expect(last?.status).toBe('down');
    expect(last?.error).toContain('rechazada');

    const [incident] = await ephemeral.db
      .select()
      .from(incidents)
      .where(eq(incidents.monitorId, monitorId));
    expect(incident?.resolvedAt).toBeNull();
    expect(incident?.cause).toContain('rechazada');

    const events = await ephemeral.db
      .select()
      .from(incidentEvents)
      .where(eq(incidentEvents.incidentId, incident!.id));
    expect(events.map((event) => event.kind)).toEqual(['opened']);
  });

  it('un monitor pausado no se reclama', async () => {
    await ephemeral.db
      .update(monitors)
      .set({ paused: true, nextCheckAt: sql`now()` })
      .where(eq(monitors.id, monitorId));

    const processed = await runWorkerOnce(deps());

    expect(processed).toBe(0);
  });

  it('al recuperar cierra la incidencia y deja el evento de recuperación', async () => {
    await ephemeral.db
      .update(monitors)
      .set({ paused: false, url: `http://127.0.0.1:${httpPort}/`, nextCheckAt: sql`now()` })
      .where(eq(monitors.id, monitorId));

    const processed = await runWorkerOnce(deps());

    expect(processed).toBe(1);

    const [monitor] = await ephemeral.db.select().from(monitors).where(eq(monitors.id, monitorId));
    expect(monitor?.state).toBe('up');

    const [incident] = await ephemeral.db
      .select()
      .from(incidents)
      .where(eq(incidents.monitorId, monitorId));
    expect(incident?.resolvedAt).not.toBeNull();

    const events = await ephemeral.db
      .select()
      .from(incidentEvents)
      .where(eq(incidentEvents.incidentId, incident!.id))
      .orderBy(asc(incidentEvents.id));
    expect(events.map((event) => event.kind)).toEqual(['opened', 'recovered']);
  });

  it('expone su salud y avisa al servicio dead-man cuando toca', async () => {
    const worker = startWorker({
      ...deps(),
      config: {
        ...deps().config,
        tickMs: 100,
        selfPingUrl: `http://127.0.0.1:${httpPort}/deadman`,
        selfPingSeconds: 0,
      },
    });

    try {
      await waitFor(() => worker.health().cycles >= 1);

      const health = worker.health();
      expect(health.stalled).toBe(false);
      expect(health.lastCycleAt).not.toBeNull();
      expect(health.lagSeconds).toBeGreaterThanOrEqual(0);

      await waitFor(() => deadManPings >= 1);
      expect(worker.health().lastSelfPingAt).not.toBeNull();
    } finally {
      await worker.stop();
    }
  });

  it('marca `stalled` cuando el umbral es más fino que el hueco entre ciclos', async () => {
    const worker = startWorker({
      ...deps(),
      config: { ...deps().config, tickMs: 50, stallSeconds: 0.001 },
    });

    try {
      await waitFor(() => worker.health().stalled);
      expect(worker.health().stalled).toBe(true);
    } finally {
      await worker.stop();
    }
  });
});
