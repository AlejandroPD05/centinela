import { nextMonitorState } from '@centinela/shared';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { runMonitorCheck, type MonitorRow } from '../checks/run.js';
import type { Database } from '../db/client.js';
import { checkResults, monitors } from '../db/schema.js';

export interface ProcessDeps {
  db: Database;
  log: FastifyBaseLogger;
  allowPrivateTargets: boolean;
}

/** Ejecuta el check de un monitor y persiste resultado, estado y contadores. */
export async function processMonitor(deps: ProcessDeps, monitor: MonitorRow): Promise<void> {
  const outcome = await runMonitorCheck(monitor, {
    allowPrivateTargets: deps.allowPrivateTargets,
  });

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

  const checkedAt = new Date();

  await deps.db.transaction(async (tx) => {
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
      })
      .where(eq(monitors.id, monitor.id));
  });

  if (transition.changed) {
    deps.log.info(
      {
        monitorId: monitor.id,
        slug: monitor.slug,
        from: monitor.state,
        to: transition.state,
        status: outcome.status,
        latencyMs: outcome.latencyMs,
      },
      `monitor ${monitor.slug}: ${monitor.state} → ${transition.state}`,
    );
  } else {
    deps.log.debug(
      { monitorId: monitor.id, status: outcome.status, latencyMs: outcome.latencyMs },
      'check completado',
    );
  }
}
