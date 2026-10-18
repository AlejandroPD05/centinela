import { nextMonitorState } from '@centinela/shared';
import { and, eq, isNull } from 'drizzle-orm';
import type { MonitorRow } from '../checks/run.js';
import type { CheckOutcome } from '../checks/types.js';
import type { Database } from '../db/client.js';
import { checkResults, incidentEvents, incidents, monitors } from '../db/schema.js';
import { buildIncidentPayload } from '../notify/payload.js';
import { enqueueDeliveries } from '../notify/queue.js';

export interface PersistOptions {
  /** Reprograma el siguiente check (los latidos se agendan a su ritmo). */
  nextCheckAt?: Date;
}

export interface PersistResult {
  state: MonitorRow['state'];
  changed: boolean;
  /** Incidencia tocada por este resultado: abierta al caer, cerrada al recuperar. */
  incidentId: string | null;
}

/**
 * Aplica un resultado de check a la fila del monitor en una única transacción:
 * serie temporal, estado con confirmaciones, incidencias con sus eventos y
 * avisos encolados. Lo usan tanto el worker como el endpoint de heartbeats.
 */
export async function persistOutcome(
  db: Database,
  monitor: MonitorRow,
  outcome: CheckOutcome,
  checkedAt: Date,
  options: PersistOptions = {},
): Promise<PersistResult> {
  const transition = nextMonitorState(
    {
      state: monitor.state,
      consecutiveFailures: monitor.consecutiveFailures,
      consecutiveSuccesses: monitor.consecutiveSuccesses,
    },
    {
      confirmFailures: monitor.confirmFailures,
      confirmRecoveries: monitor.confirmRecoveries,
    },
    outcome.status,
  );

  let incidentId: string | null = null;

  await db.transaction(async (tx) => {
    await tx.insert(checkResults).values({
      monitorId: monitor.id,
      status: outcome.status,
      latencyMs: outcome.latencyMs,
      statusCode: outcome.statusCode ?? null,
      error: outcome.error ?? null,
      checkedAt,
    });

    await tx
      .update(monitors)
      .set({
        state: transition.state,
        lastCheckAt: checkedAt,
        lastStateChangeAt: transition.changed ? checkedAt : monitor.lastStateChangeAt,
        consecutiveFailures: transition.consecutiveFailures,
        consecutiveSuccesses: transition.consecutiveSuccesses,
        ...(options.nextCheckAt ? { nextCheckAt: options.nextCheckAt } : {}),
      })
      .where(eq(monitors.id, monitor.id));

    if (!transition.changed) return;

    // Incidencias: se abren al confirmar la caída y se cierran al recuperar.
    if (transition.state === 'down') {
      const [incident] = await tx
        .insert(incidents)
        .values({
          monitorId: monitor.id,
          startedAt: checkedAt,
          cause: outcome.error ?? null,
        })
        .returning();

      if (!incident) return;
      incidentId = incident.id;

      await tx.insert(incidentEvents).values({
        incidentId: incident.id,
        kind: 'opened',
        detail: outcome.error ?? null,
        happenedAt: checkedAt,
      });

      await enqueueDeliveries(tx, monitor, {
        kind: 'down',
        incidentId: incident.id,
        payload: buildIncidentPayload(monitor, incident, 'down', checkedAt),
      });
      return;
    }

    if (monitor.state === 'down') {
      const closed = await tx
        .update(incidents)
        .set({ resolvedAt: checkedAt })
        .where(and(eq(incidents.monitorId, monitor.id), isNull(incidents.resolvedAt)))
        .returning();

      for (const incident of closed) {
        incidentId = incident.id;

        await tx.insert(incidentEvents).values({
          incidentId: incident.id,
          kind: 'recovered',
          happenedAt: checkedAt,
        });

        await enqueueDeliveries(tx, monitor, {
          kind: 'recovered',
          incidentId: incident.id,
          payload: buildIncidentPayload(monitor, incident, 'recovered', checkedAt),
        });
      }
    }
  });

  return { state: transition.state, changed: transition.changed, incidentId };
}
