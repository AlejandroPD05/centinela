import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnvFileIfPresent } from './config/env.js';
import {
  checkResults,
  incidentEvents,
  incidents,
  monitors,
  users,
  workspaces,
} from './db/schema.js';
import {
  canReachDatabase,
  createEphemeralDatabase,
  type EphemeralDatabase,
} from './test/support.js';
import { seedDemo } from './seed.js';

loadEnvFileIfPresent();

const databaseUrl = process.env.DATABASE_URL ?? '';
const dbAvailable = databaseUrl !== '' && (await canReachDatabase(databaseUrl));

if (!dbAvailable) {
  console.warn('PostgreSQL no disponible: la prueba de integración del seed se salta.');
}

const OPTIONS = {
  email: 'demo-seed@example.com',
  password: 'prueba-de-integracion-2026',
  workspaceName: 'Centinela Demo',
  // 13 días: suficiente para que la incidencia cerrada de «blog» (hace 12
  // días) quede dentro del histórico, que es lo que pinta este test.
  days: 13,
};

/**
 * Integración del seed de demostración: base efímera real, dos siembras
 * seguidas y comprobación de que los datos cuadran (estados, incidencias,
 * huecos de caída e idempotencia).
 */
describe.runIf(dbAvailable)('seed de la demo — integración con PostgreSQL', () => {
  let ephemeral: EphemeralDatabase;

  beforeAll(async () => {
    ephemeral = await createEphemeralDatabase(databaseUrl, 'centinela_test_seed');
  });

  afterAll(async () => {
    await ephemeral?.drop();
  });

  it('siembra el espacio demo con monitores, histórico e incidencias', async () => {
    const result = await seedDemo(ephemeral.db, OPTIONS);

    expect(result.monitors).toBe(7);
    expect(result.incidents).toBe(3);
    expect(result.checkResults).toBeGreaterThan(5_000);

    const [workspace] = await ephemeral.db
      .select()
      .from(workspaces)
      .where(eq(workspaces.slug, 'demo'));
    expect(workspace?.id).toBe(result.workspaceId);

    const monitorRows = await ephemeral.db
      .select()
      .from(monitors)
      .where(eq(monitors.workspaceId, result.workspaceId));
    expect(monitorRows).toHaveLength(7);

    // El monitor caído lleva su incidencia abierta, sin evento de recuperación.
    const n8n = monitorRows.find((monitor) => monitor.slug === 'n8n');
    expect(n8n?.state).toBe('down');

    const [openIncident] = await ephemeral.db
      .select()
      .from(incidents)
      .where(and(eq(incidents.monitorId, n8n!.id), sql`${incidents.resolvedAt} is null`));
    expect(openIncident).toBeDefined();

    const openEvents = await ephemeral.db
      .select({ kind: incidentEvents.kind })
      .from(incidentEvents)
      .where(eq(incidentEvents.incidentId, openIncident!.id));
    expect(openEvents.map((event) => event.kind)).toEqual(['opened', 'notified']);

    // La incidencia cerrada de «blog» deja su hueco de caída en el histórico.
    const blog = monitorRows.find((monitor) => monitor.slug === 'blog');
    const [{ down: downBlog }] = await ephemeral.db
      .select({ down: sql<number>`count(*)::int` })
      .from(checkResults)
      .where(and(eq(checkResults.monitorId, blog!.id), eq(checkResults.status, 'down')));
    expect(downBlog).toBeGreaterThan(0);

    const [closedIncident] = await ephemeral.db
      .select()
      .from(incidents)
      .where(and(eq(incidents.monitorId, blog!.id), sql`${incidents.resolvedAt} is not null`));
    expect(closedIncident).toBeDefined();

    // El pausado no se programa para ya y su histórico termina donde se pausó.
    const crm = monitorRows.find((monitor) => monitor.slug === 'crm');
    expect(crm?.paused).toBe(true);
    expect(crm!.nextCheckAt.getTime()).toBeGreaterThan(Date.now());

    // Ningún monitor queda con la próxima comprobación en el pasado.
    for (const monitor of monitorRows) {
      expect(monitor.nextCheckAt.getTime()).toBeGreaterThan(Date.now());
    }
  });

  it('es idempotente: volver a sembrar reemplaza la demo sin duplicar nada', async () => {
    const result = await seedDemo(ephemeral.db, OPTIONS);

    const [counts] = await ephemeral.db
      .select({
        workspaces: sql<number>`(select count(*)::int from workspaces where slug = 'demo')`,
        monitors: sql<number>`(select count(*)::int from monitors m join workspaces w on w.id = m.workspace_id where w.slug = 'demo')`,
        usuarios: sql<number>`(select count(*)::int from users where email = ${OPTIONS.email})`,
      })
      .from(workspaces)
      .limit(1);

    expect(counts?.workspaces).toBe(1);
    expect(counts?.monitors).toBe(7);
    expect(counts?.usuarios).toBe(1);

    // El espacio se recrea (otra id) pero el usuario se reutiliza.
    const [workspace] = await ephemeral.db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.slug, 'demo'));
    expect(workspace?.id).toBe(result.workspaceId);

    const [user] = await ephemeral.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, OPTIONS.email));
    expect(user?.id).toBe(result.userId);
  });
});
