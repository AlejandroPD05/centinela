import { sslAlertStage } from '@centinela/shared';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { runMonitorCheck, type MonitorRow } from '../checks/run.js';
import { checkSsl, type SslCheckResult } from '../checks/ssl.js';
import type { CheckOutcome } from '../checks/types.js';
import type { Database } from '../db/client.js';
import { monitors } from '../db/schema.js';
import { buildSslPayload } from '../notify/payload.js';
import { enqueueDeliveries } from '../notify/queue.js';
import { persistOutcome } from './persist.js';

export interface ProcessDeps {
  db: Database;
  log: FastifyBaseLogger;
  allowPrivateTargets: boolean;
}

/** Sondea el certificado TLS de un monitor https y guarda el resultado. */
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

  await recordSslResult(deps, monitor, result);
}

/**
 * Guarda el resultado del sondeo TLS y avanza la etapa de aviso por caducidad:
 * solo se encola cuando se cruza un umbral nuevo (30, 14, 7, 3 y 1 días), y al
 * renovar el certificado la etapa vuelve a cero sin avisar.
 */
export async function recordSslResult(
  deps: ProcessDeps,
  monitor: MonitorRow,
  result: SslCheckResult,
): Promise<void> {
  const checkedAt = new Date();

  if (!result.ok) {
    await deps.db
      .update(monitors)
      .set({ sslError: result.error })
      .where(eq(monitors.id, monitor.id));

    deps.log.debug(
      { monitorId: monitor.id, error: result.error },
      'no se pudo leer el certificado TLS',
    );
    return;
  }

  const daysLeft = Math.floor((result.expiresAt.getTime() - checkedAt.getTime()) / 86_400_000);
  const stage = sslAlertStage(daysLeft);

  await deps.db.transaction(async (tx) => {
    // La etapa actual se relee dentro de la transacción: la fila reclamada
    // puede venir de antes y no queremos duplicar el aviso de un umbral.
    const [fresh] = await tx
      .select({ sslAlertStage: monitors.sslAlertStage })
      .from(monitors)
      .where(eq(monitors.id, monitor.id));
    const currentStage = fresh?.sslAlertStage ?? 0;

    await tx
      .update(monitors)
      .set({
        sslExpiresAt: result.expiresAt,
        sslIssuer: result.issuer,
        sslError: null,
        sslAlertStage: stage,
      })
      .where(eq(monitors.id, monitor.id));

    if (stage > currentStage) {
      const queued = await enqueueDeliveries(tx, monitor, {
        kind: 'ssl',
        incidentId: null,
        payload: buildSslPayload(monitor, result, daysLeft, checkedAt),
      });

      deps.log.info(
        { monitorId: monitor.id, daysLeft, stage, avisos: queued },
        'aviso de caducidad SSL encolado',
      );
      return;
    }

    deps.log.debug(
      { monitorId: monitor.id, daysLeft, stage, issuer: result.issuer },
      'certificado TLS revisado',
    );
  });
}

/** Ejecuta el chequeo de un monitor y persiste su resultado. */
export async function processMonitor(deps: ProcessDeps, monitor: MonitorRow): Promise<void> {
  if (monitor.type === 'heartbeat') {
    await processHeartbeatMonitor(deps, monitor);
    return;
  }

  const outcome = await runMonitorCheck(monitor, {
    allowPrivateTargets: deps.allowPrivateTargets,
  });

  const checkedAt = new Date();
  const result = await persistOutcome(deps.db, monitor, outcome, checkedAt);

  if (result.changed) {
    deps.log.info(
      {
        monitorId: monitor.id,
        slug: monitor.slug,
        from: monitor.state,
        to: result.state,
        status: outcome.status,
        latencyMs: outcome.latencyMs,
      },
      `monitor ${monitor.slug}: ${monitor.state} → ${result.state}`,
    );
    return;
  }

  deps.log.debug(
    { monitorId: monitor.id, status: outcome.status, latencyMs: outcome.latencyMs },
    'check completado',
  );
}

/**
 * Supervisión pasiva de un latido: el worker solo despierta cuando se cumple
 * el plazo (periodo + gracia desde el último latido). Si aun así no llegó
 * ninguno, cuenta como fallo; cada latido entrante cuenta como éxito.
 */
async function processHeartbeatMonitor(deps: ProcessDeps, monitor: MonitorRow): Promise<void> {
  const period = monitor.heartbeatPeriodSeconds ?? monitor.intervalSeconds;
  const grace = monitor.heartbeatGraceSeconds ?? 0;
  const lastAt = monitor.lastCheckAt ?? monitor.createdAt;
  const now = new Date();
  const deadline = new Date(lastAt.getTime() + (period + grace) * 1000);

  if (now < deadline) {
    // Reclamo adelantado (jitter o creación): aún queda plazo, solo reprograma.
    await deps.db
      .update(monitors)
      .set({ nextCheckAt: deadline })
      .where(eq(monitors.id, monitor.id));
    return;
  }

  const missedSeconds = Math.max(0, Math.round((now.getTime() - lastAt.getTime()) / 1000));
  const outcome: CheckOutcome = {
    status: 'down',
    latencyMs: 0,
    error: `sin latidos desde hace ${missedSeconds} s (se esperaba uno cada ${period} s)`,
  };

  const result = await persistOutcome(deps.db, monitor, outcome, now, {
    nextCheckAt: new Date(now.getTime() + (period + grace) * 1000),
  });

  if (result.changed) {
    deps.log.info(
      { monitorId: monitor.id, slug: monitor.slug, to: result.state },
      `monitor ${monitor.slug}: ${monitor.state} → ${result.state} (latido ausente)`,
    );
    return;
  }

  deps.log.debug(
    { monitorId: monitor.id, missedSeconds },
    'latido ausente; esperando confirmación de caída',
  );
}
