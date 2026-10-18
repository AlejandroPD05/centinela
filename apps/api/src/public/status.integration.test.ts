import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../app.js';
import { loadEnv, loadEnvFileIfPresent } from '../config/env.js';
import { checkResults, incidents, monitors, workspaces } from '../db/schema.js';
import { listenerCount, publish } from '../events/hub.js';
import {
  canReachDatabase,
  createEphemeralDatabase,
  type EphemeralDatabase,
} from '../test/support.js';

loadEnvFileIfPresent();

const databaseUrl = process.env.DATABASE_URL ?? '';
const dbAvailable = databaseUrl !== '' && (await canReachDatabase(databaseUrl));

if (!dbAvailable) {
  console.warn('PostgreSQL no disponible: la prueba de integración del estado público se salta.');
}

const JWT_SECRET = 'secreto-de-integracion-del-estado-publico-2026';

/** Espera activa: los flujos SSE llegan cuando llegan. */
async function waitFor(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('se agotó el tiempo de espera');
}

describe.runIf(dbAvailable)('estado público — integración con PostgreSQL', () => {
  let ephemeral: EphemeralDatabase;
  let app: FastifyInstance;
  let port: number;

  let workspaceId: string;
  let publicMonitorId: string;
  let privateMonitorId: string;

  const slug = 'aurora-de-pruebas';

  beforeAll(async () => {
    ephemeral = await createEphemeralDatabase(databaseUrl, 'centinela_test_public');
    const { db } = ephemeral;

    const env = loadEnv({
      NODE_ENV: 'test',
      DATABASE_URL: databaseUrl,
      LOG_LEVEL: 'silent',
      JWT_SECRET,
    });

    const [workspace] = await db.insert(workspaces).values({ name: 'Aurora', slug }).returning();
    if (!workspace) throw new Error('no se pudo crear el espacio de trabajo');
    workspaceId = workspace.id;

    const now = Date.now();
    const [publicMonitor] = await db
      .insert(monitors)
      .values({
        workspaceId,
        name: 'Web pública',
        slug: 'web',
        type: 'http',
        url: 'https://example.com',
        isPublic: true,
        state: 'up',
        lastCheckAt: new Date(now - 60_000),
        lastStateChangeAt: new Date(now - 3_600_000 * 3),
      })
      .returning();
    if (!publicMonitor) throw new Error('no se pudo crear el monitor público');
    publicMonitorId = publicMonitor.id;

    const [privateMonitor] = await db
      .insert(monitors)
      .values({
        workspaceId,
        name: 'Panel privado',
        slug: 'panel',
        type: 'http',
        url: 'https://panel.example.com',
        isPublic: false,
        state: 'down',
      })
      .returning();
    if (!privateMonitor) throw new Error('no se pudo crear el monitor privado');
    privateMonitorId = privateMonitor.id;

    await db.insert(monitors).values({
      workspaceId,
      name: 'Latido de copias',
      slug: 'copias',
      type: 'heartbeat',
      isPublic: true,
      paused: true,
      state: 'pending',
      heartbeatToken: 'hb_pruebas_de_integracion_del_estado',
      heartbeatPeriodSeconds: 3_600,
      heartbeatGraceSeconds: 300,
    });

    // Serie de ejemplo: tres checks correctos y uno degradado hoy.
    await db.insert(checkResults).values([
      {
        monitorId: publicMonitorId,
        status: 'up',
        latencyMs: 120,
        checkedAt: new Date(now - 3_600_000 * 4),
      },
      {
        monitorId: publicMonitorId,
        status: 'up',
        latencyMs: 140,
        checkedAt: new Date(now - 3_600_000 * 3),
      },
      {
        monitorId: publicMonitorId,
        status: 'degraded',
        latencyMs: 4_200,
        checkedAt: new Date(now - 3_600_000 * 2),
      },
      {
        monitorId: publicMonitorId,
        status: 'up',
        latencyMs: 110,
        checkedAt: new Date(now - 60_000),
      },
    ]);

    // Una incidencia ya resuelta y otra del monitor privado (no debe salir).
    await db.insert(incidents).values([
      {
        monitorId: publicMonitorId,
        startedAt: new Date(now - 7_200_000),
        resolvedAt: new Date(now - 3_600_000),
        cause: 'conexión rechazada',
      },
      {
        monitorId: privateMonitorId,
        startedAt: new Date(now - 7_200_000),
        cause: 'secreto interno del panel',
      },
    ]);

    app = buildServer({ env, database: db });
    await app.ready();
    await app.listen({ port: 0, host: '127.0.0.1' });

    const address = app.server.address();
    if (address === null || typeof address === 'string') throw new Error('sin puerto de escucha');
    port = address.port;
  });

  afterAll(async () => {
    await app?.close();
    await ephemeral?.drop();
  });

  it('la status page muestra solo los monitores públicos', async () => {
    const response = await app.inject({ method: 'GET', url: `/status/${slug}` });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');

    const html = response.body;
    expect(html).toContain('Web pública');
    expect(html).toContain('Latido de copias');
    expect(html).not.toContain('Panel privado');
    expect(html).not.toContain('secreto interno del panel');
    expect(html).toContain('conexión rechazada');
    expect(html).toContain('/badge/aurora-de-pruebas/web.svg');
    expect(html).toContain('data-monitor="' + publicMonitorId + '"');
    // Un monitor activo + uno pausado: tres cintas (hero + fila + fila).
    expect(html.match(/data-tone="/g)).toHaveLength(3 * 90);
  });

  it('la status page se comprime cuando el cliente lo pide', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/status/${slug}`,
      headers: { 'accept-encoding': 'gzip' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-encoding']).toBe('gzip');
  });

  it('una revalidación con ETag ahorra la página', async () => {
    const first = await app.inject({ method: 'GET', url: `/status/${slug}` });
    const etag = first.headers.etag;
    expect(etag).toBeTruthy();

    const second = await app.inject({
      method: 'GET',
      url: `/status/${slug}`,
      headers: { 'if-none-match': String(etag) },
    });

    expect(second.statusCode).toBe(304);
  });

  it('un espacio inexistente devuelve 404 con página', async () => {
    const response = await app.inject({ method: 'GET', url: '/status/no-existe' });
    expect(response.statusCode).toBe(404);
    expect(response.body).toContain('Ese espacio no existe.');
  });

  it('el widget permite incrustarse en otras webs', async () => {
    const response = await app.inject({ method: 'GET', url: `/embed/${slug}` });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-security-policy']).toBe('frame-ancestors *');
    expect(response.body).toContain('Web pública');
    expect(response.body).toContain('noindex');
    expect(response.body).not.toContain('Panel privado');
  });

  it('el badge público se cachea con ETag y el privado no existe', async () => {
    const response = await app.inject({ method: 'GET', url: `/badge/${slug}/web.svg` });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('image/svg+xml');
    expect(response.body).toContain('responde');

    const revalidated = await app.inject({
      method: 'GET',
      url: `/badge/${slug}/web.svg`,
      headers: { 'if-none-match': String(response.headers.etag) },
    });
    expect(revalidated.statusCode).toBe(304);

    const privado = await app.inject({ method: 'GET', url: `/badge/${slug}/panel.svg` });
    expect(privado.statusCode).toBe(404);

    const sinSvg = await app.inject({ method: 'GET', url: `/badge/${slug}/web.txt` });
    expect(sinSvg.statusCode).toBe(404);

    const espacio = await app.inject({ method: 'GET', url: `/badge/otro/web.svg` });
    expect(espacio.statusCode).toBe(404);
  });

  it('sirve las fuentes self-host con caché inmutable', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/assets/fonts/archivo-black-latin.woff2',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('font/woff2');
    expect(response.headers['cache-control']).toContain('immutable');

    const desconocida = await app.inject({
      method: 'GET',
      url: '/assets/fonts/no-existe.woff2',
    });
    expect(desconocida.statusCode).toBe(404);
  });

  it('el flujo SSE entrega avisos públicos y calla los privados', async () => {
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${port}/status/${slug}/events`, {
      headers: { accept: 'text/event-stream' },
      signal: controller.signal,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    if (!response.body) throw new Error('sin cuerpo SSE');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const readNext = async () => {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
    };

    await readNext();
    expect(buffer).toContain('retry: 8000');
    await waitFor(() => listenerCount(workspaceId) === 1);

    // El monitor privado no debe viajar aunque el worker lo anuncie.
    publish(workspaceId, {
      type: 'check',
      monitorId: privateMonitorId,
      monitorSlug: 'panel',
      state: 'down',
      status: 'down',
      latencyMs: 10,
      changed: true,
      at: '2026-10-18T10:00:00.000Z',
    });
    publish(workspaceId, {
      type: 'check',
      monitorId: publicMonitorId,
      monitorSlug: 'web',
      state: 'down',
      status: 'down',
      latencyMs: 12,
      changed: true,
      at: '2026-10-18T10:00:01.000Z',
    });

    while (!buffer.includes('"monitorSlug":"web"')) await readNext();

    expect(buffer).toContain('"monitorSlug":"web"');
    expect(buffer).not.toContain('"monitorSlug":"panel"');
    expect(buffer).toContain('data: ');

    controller.abort();
    await waitFor(() => listenerCount(workspaceId) === 0);
  });
});
