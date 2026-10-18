import type { MonitorState } from '@centinela/shared';
import { and, desc, eq, gte, inArray, isNull, or, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { checkResults, incidents, monitors, workspaces } from '../db/schema.js';

/** Días que cubre la cinta de disponibilidad. */
export const TAPE_DAYS = 90;
/** Ventana de incidencias que muestra la status page. */
export const INCIDENT_WINDOW_DAYS = 30;

export interface PublicWorkspace {
  id: string;
  name: string;
  slug: string;
}

/** Tono de un día de la cinta: el peor resultado registrado ese día. */
export type TapeTone = 'up' | 'warn' | 'down' | 'nodata';

export interface TapeDay {
  /** Día UTC en YYYY-MM-DD. */
  date: string;
  total: number;
  available: number;
  /** Proporción 0–1 (null si no hubo checks). */
  availability: number | null;
  degraded: number;
  down: number;
  tone: TapeTone;
}

export interface UptimeWindowCounts {
  available: number;
  total: number;
  /** Proporción 0–1 (null sin datos). */
  ratio: number | null;
}

export interface PublicMonitorStatus {
  id: string;
  name: string;
  slug: string;
  type: 'http' | 'tcp' | 'heartbeat';
  /** Destino para mostrar: host de la URL, host:puerto TCP o null. */
  target: string | null;
  state: MonitorState;
  paused: boolean;
  lastCheckAt: string | null;
  lastStateChangeAt: string | null;
  /** Disponibilidad en 24 h, 7 y 30 días. */
  uptime: { day: UptimeWindowCounts; week: UptimeWindowCounts; month: UptimeWindowCounts };
  /** Cinta de 90 días, sin huecos. */
  tape: TapeDay[];
}

export interface PublicIncident {
  id: string;
  monitorId: string;
  monitorName: string;
  monitorSlug: string;
  startedAt: string;
  resolvedAt: string | null;
  /** Hasta la recuperación; si sigue abierta, hasta ahora mismo. */
  durationSeconds: number;
  cause: string | null;
}

/** Espacio de trabajo por su slug público, o null si no existe. */
export async function publicWorkspaceBySlug(
  db: Database,
  slug: string,
): Promise<PublicWorkspace | null> {
  const [row] = await db
    .select({ id: workspaces.id, name: workspaces.name, slug: workspaces.slug })
    .from(workspaces)
    .where(eq(workspaces.slug, slug));

  return row ?? null;
}

/** Ids de los monitores públicos de un espacio (filtro del flujo SSE). */
export async function publicMonitorIds(db: Database, workspaceId: string): Promise<string[]> {
  const rows = await db
    .select({ id: monitors.id })
    .from(monitors)
    .where(and(eq(monitors.workspaceId, workspaceId), eq(monitors.isPublic, true)));

  return rows.map((row) => row.id);
}

/** Estado mínimo para pintar un badge, o null si no es público o no existe. */
export async function publicMonitorCard(
  db: Database,
  workspaceId: string,
  slug: string,
): Promise<{ state: MonitorState; paused: boolean } | null> {
  const [row] = await db
    .select({ state: monitors.state, paused: monitors.paused })
    .from(monitors)
    .where(
      and(
        eq(monitors.workspaceId, workspaceId),
        eq(monitors.slug, slug),
        eq(monitors.isPublic, true),
      ),
    );

  return row ?? null;
}

/**
 * Todo lo que pinta la status page, en tres consultas: monitores públicos,
 * disponibilidad agrupada por monitor y cinta diaria agrupada por monitor
 * (nada de N+1 por largo que sea el espacio).
 */
export async function publicStatusData(
  db: Database,
  workspaceId: string,
): Promise<{ monitors: PublicMonitorStatus[]; incidents: PublicIncident[] }> {
  const monitorRows = await db
    .select({
      id: monitors.id,
      name: monitors.name,
      slug: monitors.slug,
      type: monitors.type,
      url: monitors.url,
      host: monitors.host,
      port: monitors.port,
      state: monitors.state,
      paused: monitors.paused,
      lastCheckAt: monitors.lastCheckAt,
      lastStateChangeAt: monitors.lastStateChangeAt,
    })
    .from(monitors)
    .where(and(eq(monitors.workspaceId, workspaceId), eq(monitors.isPublic, true)))
    .orderBy(monitors.name);

  if (monitorRows.length === 0) return { monitors: [], incidents: [] };

  const ids = monitorRows.map((row) => row.id);
  const available = sql`${checkResults.status} in ('up', 'degraded')`;

  const uptimeRows = await db
    .select({
      monitorId: checkResults.monitorId,
      dayTotal: sql<number>`(count(*) filter (where ${checkResults.checkedAt} >= now() - interval '24 hours'))::int`,
      dayAvailable: sql<number>`(count(*) filter (where ${checkResults.checkedAt} >= now() - interval '24 hours' and ${available}))::int`,
      weekTotal: sql<number>`(count(*) filter (where ${checkResults.checkedAt} >= now() - interval '7 days'))::int`,
      weekAvailable: sql<number>`(count(*) filter (where ${checkResults.checkedAt} >= now() - interval '7 days' and ${available}))::int`,
      monthTotal: sql<number>`(count(*) filter (where ${checkResults.checkedAt} >= now() - interval '30 days'))::int`,
      monthAvailable: sql<number>`(count(*) filter (where ${checkResults.checkedAt} >= now() - interval '30 days' and ${available}))::int`,
    })
    .from(checkResults)
    .where(inArray(checkResults.monitorId, ids))
    .groupBy(checkResults.monitorId);

  const sinceTape = startOfUtcDay(new Date(Date.now() - (TAPE_DAYS - 1) * 86_400_000));

  const bucketRows = await db
    .select({
      monitorId: checkResults.monitorId,
      day: sql<string>`to_char(date_trunc('day', ${checkResults.checkedAt} at time zone 'UTC'), 'YYYY-MM-DD')`,
      total: sql<number>`count(*)::int`,
      available: sql<number>`(count(*) filter (where ${available}))::int`,
      degraded: sql<number>`(count(*) filter (where ${checkResults.status} = 'degraded'))::int`,
      down: sql<number>`(count(*) filter (where ${checkResults.status} in ('down', 'error')))::int`,
    })
    .from(checkResults)
    .where(and(inArray(checkResults.monitorId, ids), gte(checkResults.checkedAt, sinceTape)))
    .groupBy(checkResults.monitorId, sql`2`);

  const uptimeByMonitor = new Map(uptimeRows.map((row) => [row.monitorId, row]));
  const bucketsByMonitor = new Map<string, Map<string, (typeof bucketRows)[number]>>();
  for (const row of bucketRows) {
    const byDay = bucketsByMonitor.get(row.monitorId) ?? new Map();
    byDay.set(row.day, row);
    bucketsByMonitor.set(row.monitorId, byDay);
  }

  const statuses: PublicMonitorStatus[] = monitorRows.map((monitor) => {
    const uptime = uptimeByMonitor.get(monitor.id);
    const byDay = bucketsByMonitor.get(monitor.id) ?? new Map();

    return {
      id: monitor.id,
      name: monitor.name,
      slug: monitor.slug,
      type: monitor.type,
      target: displayTarget(monitor),
      state: monitor.state,
      paused: monitor.paused,
      lastCheckAt: monitor.lastCheckAt?.toISOString() ?? null,
      lastStateChangeAt: monitor.lastStateChangeAt?.toISOString() ?? null,
      uptime: {
        day: windowCounts(uptime?.dayAvailable, uptime?.dayTotal),
        week: windowCounts(uptime?.weekAvailable, uptime?.weekTotal),
        month: windowCounts(uptime?.monthAvailable, uptime?.monthTotal),
      },
      tape: zeroFilledTape(sinceTape, byDay),
    };
  });

  return { monitors: statuses, incidents: await recentIncidents(db, workspaceId, ids) };
}

/** Incidencias recientes de los monitores públicos (las abiertas cuentan siempre). */
async function recentIncidents(
  db: Database,
  workspaceId: string,
  monitorIds: string[],
): Promise<PublicIncident[]> {
  const since = new Date(Date.now() - INCIDENT_WINDOW_DAYS * 86_400_000);

  const rows = await db
    .select({
      id: incidents.id,
      monitorId: incidents.monitorId,
      monitorName: monitors.name,
      monitorSlug: monitors.slug,
      startedAt: incidents.startedAt,
      resolvedAt: incidents.resolvedAt,
      cause: incidents.cause,
    })
    .from(incidents)
    .innerJoin(monitors, eq(monitors.id, incidents.monitorId))
    .where(
      and(
        eq(monitors.workspaceId, workspaceId),
        inArray(incidents.monitorId, monitorIds),
        or(gte(incidents.startedAt, since), isNull(incidents.resolvedAt)),
      ),
    )
    .orderBy(desc(incidents.startedAt))
    .limit(20);

  const now = Date.now();
  return rows.map((row) => ({
    id: row.id,
    monitorId: row.monitorId,
    monitorName: row.monitorName,
    monitorSlug: row.monitorSlug,
    startedAt: row.startedAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    durationSeconds: Math.max(
      0,
      Math.round(((row.resolvedAt?.getTime() ?? now) - row.startedAt.getTime()) / 1000),
    ),
    cause: row.cause,
  }));
}

/** Host legible del destino vigilado (sin esquema ni ruta). */
function displayTarget(monitor: {
  type: 'http' | 'tcp' | 'heartbeat';
  url: string | null;
  host: string | null;
  port: number | null;
}): string | null {
  if (monitor.type === 'http' && monitor.url !== null) {
    try {
      return new URL(monitor.url).hostname;
    } catch {
      return monitor.url;
    }
  }

  if (monitor.type === 'tcp' && monitor.host !== null) {
    return monitor.port === null ? monitor.host : `${monitor.host}:${monitor.port}`;
  }

  return null;
}

function windowCounts(
  available: number | undefined,
  total: number | undefined,
): UptimeWindowCounts {
  const safeAvailable = available ?? 0;
  const safeTotal = total ?? 0;
  return {
    available: safeAvailable,
    total: safeTotal,
    ratio: safeTotal === 0 ? null : safeAvailable / safeTotal,
  };
}

/** Rellena la cinta con todos los días del rango, con su tono ya decidido. */
function zeroFilledTape(
  since: Date,
  byDay: Map<string, { total: number; available: number; degraded: number; down: number }>,
): TapeDay[] {
  const tape: TapeDay[] = [];

  for (let index = 0; index < TAPE_DAYS; index++) {
    const date = new Date(since.getTime() + index * 86_400_000);
    const key = date.toISOString().slice(0, 10);
    const row = byDay.get(key);
    const total = row?.total ?? 0;
    const down = row?.down ?? 0;
    const degraded = row?.degraded ?? 0;

    tape.push({
      date: key,
      total,
      available: row?.available ?? 0,
      availability: total === 0 ? null : (row?.available ?? 0) / total,
      degraded,
      down,
      tone: total === 0 ? 'nodata' : down > 0 ? 'down' : degraded > 0 ? 'warn' : 'up',
    });
  }

  return tape;
}

function startOfUtcDay(date: Date): Date {
  const copy = new Date(date);
  copy.setUTCHours(0, 0, 0, 0);
  return copy;
}
