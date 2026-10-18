import { uptimeWindowHours, type UptimeWindow } from '@centinela/shared';
import { and, asc, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { checkResults, incidentEvents, incidents } from '../db/schema.js';

const availableFilter = sql`${checkResults.status} in ('up', 'degraded')`;

export interface UptimeSummary {
  window: UptimeWindow;
  since: string;
  checks: { total: number; available: number; failed: number };
  /** Proporción 0–1; null si no hay datos en la ventana. */
  availability: number | null;
  latencyMs: { p50: number | null; p95: number | null; p99: number | null };
}

/** Resumen de disponibilidad y percentiles de latencia en una ventana. */
export async function getUptimeSummary(
  db: Database,
  monitorId: string,
  window: UptimeWindow,
): Promise<UptimeSummary> {
  const since = new Date(Date.now() - uptimeWindowHours(window) * 3_600_000);

  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      available: sql<number>`(count(*) filter (where ${availableFilter}))::int`,
      failed: sql<number>`(count(*) filter (where ${checkResults.status} in ('down', 'error')))::int`,
      p50: sql<
        number | null
      >`percentile_cont(0.5) within group (order by ${checkResults.latencyMs}) filter (where ${availableFilter})`,
      p95: sql<
        number | null
      >`percentile_cont(0.95) within group (order by ${checkResults.latencyMs}) filter (where ${availableFilter})`,
      p99: sql<
        number | null
      >`percentile_cont(0.99) within group (order by ${checkResults.latencyMs}) filter (where ${availableFilter})`,
    })
    .from(checkResults)
    .where(and(eq(checkResults.monitorId, monitorId), gte(checkResults.checkedAt, since)));

  const total = row?.total ?? 0;
  const available = row?.available ?? 0;

  return {
    window,
    since: since.toISOString(),
    checks: { total, available, failed: row?.failed ?? 0 },
    availability: total === 0 ? null : available / total,
    latencyMs: {
      p50: round1(row?.p50 ?? null),
      p95: round1(row?.p95 ?? null),
      p99: round1(row?.p99 ?? null),
    },
  };
}

export interface DailyBucket {
  /** Día UTC en formato YYYY-MM-DD. */
  date: string;
  total: number;
  available: number;
  availability: number | null;
  avgLatencyMs: number | null;
  /** Checks degradados y caídos del día (mismo corte que la cinta pública). */
  degraded: number;
  down: number;
}

/**
 * Serie diaria para la cinta de disponibilidad. Devuelve todos los días del
 * rango (aunque no haya datos: `availability` queda null), listo para pintar.
 */
export async function getDailyBuckets(
  db: Database,
  monitorId: string,
  days: number,
): Promise<DailyBucket[]> {
  const since = startOfUtcDay(new Date(Date.now() - (days - 1) * 86_400_000));

  const rows = await db
    .select({
      day: sql<string>`to_char(date_trunc('day', ${checkResults.checkedAt} at time zone 'UTC'), 'YYYY-MM-DD')`,
      total: sql<number>`count(*)::int`,
      available: sql<number>`(count(*) filter (where ${availableFilter}))::int`,
      degraded: sql<number>`(count(*) filter (where ${checkResults.status} = 'degraded'))::int`,
      down: sql<number>`(count(*) filter (where ${checkResults.status} in ('down', 'error')))::int`,
      avgLatency: sql<
        number | null
      >`avg(${checkResults.latencyMs}) filter (where ${availableFilter})`,
    })
    .from(checkResults)
    .where(and(eq(checkResults.monitorId, monitorId), gte(checkResults.checkedAt, since)))
    .groupBy(sql`1`)
    .orderBy(sql`1`);

  const byDay = new Map(rows.map((row) => [row.day, row]));
  const buckets: DailyBucket[] = [];

  for (let index = 0; index < days; index++) {
    const date = new Date(since.getTime() + index * 86_400_000);
    const key = date.toISOString().slice(0, 10);
    const row = byDay.get(key);

    buckets.push({
      date: key,
      total: row?.total ?? 0,
      available: row?.available ?? 0,
      availability: row !== undefined && row.total > 0 ? row.available / row.total : null,
      avgLatencyMs: round1(row?.avgLatency ?? null),
      degraded: row?.degraded ?? 0,
      down: row?.down ?? 0,
    });
  }

  return buckets;
}

export interface IncidentEventRecord {
  kind: 'opened' | 'recovered' | 'notified' | 'comment';
  detail: string | null;
  happenedAt: string;
}

export interface IncidentRecord {
  id: string;
  startedAt: string;
  resolvedAt: string | null;
  /** Hasta la recuperación; si sigue abierta, hasta ahora mismo. */
  durationSeconds: number;
  cause: string | null;
  events: IncidentEventRecord[];
}

/** Incidencias de un monitor, la más reciente primero, con su timeline. */
export async function listIncidents(
  db: Database,
  monitorId: string,
  limit: number,
): Promise<IncidentRecord[]> {
  const incidentRows = await db
    .select()
    .from(incidents)
    .where(eq(incidents.monitorId, monitorId))
    .orderBy(desc(incidents.startedAt))
    .limit(limit);

  if (incidentRows.length === 0) return [];

  const eventRows = await db
    .select()
    .from(incidentEvents)
    .where(
      inArray(
        incidentEvents.incidentId,
        incidentRows.map((row) => row.id),
      ),
    )
    .orderBy(asc(incidentEvents.happenedAt), asc(incidentEvents.id));

  const eventsByIncident = new Map<string, IncidentEventRecord[]>();
  for (const event of eventRows) {
    const list = eventsByIncident.get(event.incidentId) ?? [];
    list.push({
      kind: event.kind,
      detail: event.detail,
      happenedAt: event.happenedAt.toISOString(),
    });
    eventsByIncident.set(event.incidentId, list);
  }

  const now = Date.now();
  return incidentRows.map((incident) => ({
    id: incident.id,
    startedAt: incident.startedAt.toISOString(),
    resolvedAt: incident.resolvedAt?.toISOString() ?? null,
    durationSeconds: Math.max(
      0,
      Math.floor(((incident.resolvedAt?.getTime() ?? now) - incident.startedAt.getTime()) / 1000),
    ),
    cause: incident.cause,
    events: eventsByIncident.get(incident.id) ?? [],
  }));
}

function round1(value: number | null): number | null {
  return value === null ? null : Math.round(value * 10) / 10;
}

function startOfUtcDay(date: Date): Date {
  const copy = new Date(date);
  copy.setUTCHours(0, 0, 0, 0);
  return copy;
}
