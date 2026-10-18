import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { monitors } from '../db/schema.js';
import type { MonitorRow } from '../checks/run.js';

/**
 * Reclama los monitores vencidos y programa su siguiente check.
 *
 * Un único UPDATE con `SELECT … FOR UPDATE SKIP LOCKED`: varias instancias del
 * worker pueden competir por la cola sin pisarse (patrón de cola de PostgreSQL).
 * El siguiente check lleva un jitter de ±10 % para evitar rebaños a la misma hora.
 *
 * Los heartbeats aún no pasan por el scheduler (su supervisión llega en M3).
 */
export async function claimDueMonitors(db: Database, limit: number): Promise<MonitorRow[]> {
  const due = db
    .select({ id: monitors.id })
    .from(monitors)
    .where(
      and(
        eq(monitors.paused, false),
        lte(monitors.nextCheckAt, sql`now()`),
        inArray(monitors.type, ['http', 'tcp']),
      ),
    )
    .orderBy(asc(monitors.nextCheckAt))
    .limit(limit)
    .for('update', { skipLocked: true });

  return db
    .update(monitors)
    .set({
      nextCheckAt: sql`now() + make_interval(secs => ${monitors.intervalSeconds} * (0.9 + random() * 0.2))`,
    })
    .where(inArray(monitors.id, due))
    .returning();
}

/**
 * Reclama los monitores https cuyo certificado toca revisar (cada
 * `recheckHours`). Marca `ssl_checked_at` al reclamar: si el sondeo falla, se
 * reintentará en el siguiente ciclo de revisión.
 */
export async function claimMonitorsForSslCheck(
  db: Database,
  limit: number,
  recheckHours: number,
): Promise<MonitorRow[]> {
  const due = db
    .select({ id: monitors.id })
    .from(monitors)
    .where(
      and(
        eq(monitors.paused, false),
        eq(monitors.type, 'http'),
        sql`${monitors.url} like 'https://%'`,
        sql`(${monitors.sslCheckedAt} is null or ${monitors.sslCheckedAt} < now() - make_interval(hours => ${recheckHours}))`,
      ),
    )
    .orderBy(sql`${monitors.sslCheckedAt} asc nulls first`)
    .limit(limit)
    .for('update', { skipLocked: true });

  return db
    .update(monitors)
    .set({ sslCheckedAt: sql`now()` })
    .where(inArray(monitors.id, due))
    .returning();
}
