import { nextMonitorState } from '@centinela/shared';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { runMonitorCheck, type MonitorRow } from '../checks/run.js';
import { checkSsl } from '../checks/ssl.js';
import type { Database } from '../db/client.js';
import { checkResults, incidentEvents, incidents, monitors } from '../db/schema.js';

export interface ProcessDeps {
  db: Database;
  log: FastifyBaseLogger;
  allowPrivateTargets: boolean;
}

/** Sondea el certificado TLS de un monitor https y deja el resultado en la fila. */
export async function processSslCheck(deps: ProcessDeps, monitor: MonitorRow): Promise<void> {
  if (!monitor.url) return;

  let hostname: string;
  let port = 443;
  try {
    const url = new URL(monitor.url);
    hostname = url.hostname;
    if (url.port) port = Number(url.port);
  } catch {
    return;
  }

  const result = await checkSsl(hostname, port, {
    timeoutMs: monitor.timeoutMs,
    allowPrivateTargets: deps.allowPrivateTargets,
  });

  if (result.ok) {
    await deps.db
      .update(monitors)
      .set({
        sslExpiresAt: result.expiresAt,
        sslIssuer: result.issuer,
        sslError: null,
      })
      .where(eq(monitors.id, monitor.id));

    const daysLeft = Math.floor((result.expiresAt.getTime() - Date.now()) / 86_400_000);
    deps.log.debug(
      { monitorId: monitor.id, daysLeft, issuer: result.issuer },
      'certificado TLS revisado',
    );
  } else {
    await deps.db
      .update(monitors)
      .set({ sslError: result.error })
      .where(eq(monitors.id, monitor.id));

    deps.log.debug(
      { monitorId: monitor.id, error: result.error },
      'no se pudo leer el certificado TLS',
    );
  }
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

    // Incidencias: se abren al confirmar la caída y se cierran al recuperar.
    if (transition.changed) {
      if (transition.state === 'down') {
        const [incident] = await tx
          .insert(incidents)
          .values({
            monitorId: monitor.id,
            startedAt: checkedAt,
            cause: outcome.error ?? null,
          })
          .returning({ id: incidents.id });

        if (incident) {
          await tx.insert(incidentEvents).values({
            incidentId: incident.id,
            kind: 'opened',
            detail: outcome.error ?? null,
            happenedAt: checkedAt,
          });
        }
      } else if (monitor.state === 'down') {
        const closedIncidents = await tx
          .update(incidents)
          .set({ resolvedAt: checkedAt })
          .where(and(eq(incidents.monitorId, monitor.id), isNull(incidents.resolvedAt)))
          .returning({ id: incidents.id });

        for (const incident of closedIncidents) {
          await tx.insert(incidentEvents).values({
            incidentId: incident.id,
            kind: 'recovered',
            happenedAt: checkedAt,
          });
        }
      }
    }
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
