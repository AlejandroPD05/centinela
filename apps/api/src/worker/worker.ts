import type { FastifyBaseLogger } from 'fastify';
import type { Database } from '../db/client.js';
import { sendDelivery } from '../notify/adapters.js';
import { DELIVERY_BATCH_SIZE, NOTIFICATION_TIMEOUT_MS } from '../notify/config.js';
import { claimDueDeliveries, markDelivered, markFailedAttempt } from '../notify/queue.js';
import { claimDueMonitors, claimMonitorsForSslCheck } from './claim.js';
import { processMonitor, processSslCheck } from './process.js';

export interface WorkerConfig {
  /** Sonda entre ciclos cuando no hay trabajo (ms). */
  tickMs: number;
  /** Monitores vencidos que se reclaman por ciclo. */
  batchSize: number;
  /** Checks que se ejecutan en paralelo. */
  concurrency: number;
  allowPrivateTargets: boolean;
  /** Cada cuántas horas se revisa el certificado TLS de los monitores https. */
  sslRecheckHours: number;
  /** Umbral de atasco del bucle (segundos): a partir de ahí, `stalled`. */
  stallSeconds: number;
  /** Dead-man switch: URL avisada cada `selfPingSeconds` (opcional). */
  selfPingUrl?: string | undefined;
  /** Cada cuántos segundos se avisa al servicio dead-man. */
  selfPingSeconds: number;
  /** Claves opcionales para el canal email (Resend). */
  resendApiKey?: string | undefined;
  emailFrom?: string | undefined;
}

export interface WorkerDeps {
  db: Database;
  log: FastifyBaseLogger;
  config: WorkerConfig;
}

/** Señal de vida del motor, para /api/health y el vigilante del proceso. */
export interface WorkerHealth {
  /** Ciclos completados desde el arranque. */
  cycles: number;
  /** Fin del último ciclo (ISO); `null` si aún no cerró ninguno. */
  lastCycleAt: string | null;
  /** Segundos desde el fin del último ciclo (o desde el arranque). */
  lagSeconds: number;
  /** `true` si el bucle lleva más de `stallSeconds` sin cerrar un ciclo. */
  stalled: boolean;
  /** Último aviso al servicio dead-man (ISO); `null` si no hay o no toca. */
  lastSelfPingAt: string | null;
}

export interface WorkerHandle {
  /** Procesa un único ciclo: reclama y ejecuta los checks vencidos. */
  runOnce(): Promise<number>;
  /** Detiene el bucle y espera a que terminen los checks en curso. */
  stop(): Promise<void>;
  /** Señal de vida del bucle (para la salud y el vigilante). */
  health(): WorkerHealth;
}

const SSL_BATCH_SIZE = 5;

/** Ejecuta un ciclo completo del worker y devuelve cuántos checks procesó. */
export async function runWorkerOnce(deps: WorkerDeps): Promise<number> {
  const processed = await runCheckBatch(deps);
  await runSslBatch(deps);
  await runDeliveryBatch(deps);
  return processed;
}

async function runCheckBatch(deps: WorkerDeps): Promise<number> {
  const claimed = await claimDueMonitors(deps.db, deps.config.batchSize);
  if (claimed.length === 0) return 0;

  await mapWithConcurrency(claimed, deps.config.concurrency, async (monitor) => {
    try {
      await processMonitor(
        { db: deps.db, log: deps.log, allowPrivateTargets: deps.config.allowPrivateTargets },
        monitor,
      );
    } catch (error) {
      // Un monitor problemático nunca debe tumbar el lote.
      deps.log.error(
        { err: error, monitorId: monitor.id, slug: monitor.slug },
        'fallo al procesar un monitor',
      );
    }
  });

  deps.log.debug({ claimed: claimed.length }, 'ciclo de checks completado');
  return claimed.length;
}

async function runSslBatch(deps: WorkerDeps): Promise<void> {
  const claimed = await claimMonitorsForSslCheck(
    deps.db,
    SSL_BATCH_SIZE,
    deps.config.sslRecheckHours,
  );
  if (claimed.length === 0) return;

  await mapWithConcurrency(claimed, deps.config.concurrency, async (monitor) => {
    try {
      await processSslCheck(
        { db: deps.db, log: deps.log, allowPrivateTargets: deps.config.allowPrivateTargets },
        monitor,
      );
    } catch (error) {
      deps.log.error({ err: error, monitorId: monitor.id }, 'fallo al sondear el certificado TLS');
    }
  });
}

/** Drena la cola de avisos: entrega por red y decide reintento o descarte. */
async function runDeliveryBatch(deps: WorkerDeps): Promise<number> {
  const claimed = await claimDueDeliveries(deps.db, DELIVERY_BATCH_SIZE);
  if (claimed.length === 0) return 0;

  await mapWithConcurrency(claimed, deps.config.concurrency, async (delivery) => {
    try {
      const result = await sendDelivery(delivery.channel, delivery.payload, {
        timeoutMs: NOTIFICATION_TIMEOUT_MS,
        resendApiKey: deps.config.resendApiKey,
        emailFrom: deps.config.emailFrom,
        allowPrivateTargets: deps.config.allowPrivateTargets,
      });

      if (result.ok) {
        await markDelivered(deps.db, delivery);
        deps.log.info(
          { deliveryId: delivery.id, canal: delivery.channel.name, tipo: delivery.payload.kind },
          'aviso entregado',
        );
        return;
      }

      const exhausted = await markFailedAttempt(deps.db, delivery, result.error);
      deps.log.warn(
        {
          deliveryId: delivery.id,
          canal: delivery.channel.name,
          intentos: delivery.attempts,
          error: result.error,
        },
        exhausted
          ? 'aviso descartado tras agotar los reintentos'
          : 'fallo al entregar el aviso; se reintentará',
      );
    } catch (error) {
      deps.log.error(
        { err: error, deliveryId: delivery.id },
        'fallo inesperado al entregar un aviso',
      );
    }
  });

  deps.log.debug({ claimed: claimed.length }, 'lote de avisos entregado');
  return claimed.length;
}

/**
 * Arranca el bucle del worker, embebido en la API: con WORKER_ENABLED=true el
 * mismo proceso sirve HTTP y ejecuta los checks. `stop()` espera a que acabe
 * el ciclo en curso.
 */
export function startWorker(deps: WorkerDeps): WorkerHandle {
  let running = true;
  let cycles = 0;
  let lastCycleAt: number | null = null;
  let lastSelfPingAt: number | null = null;
  const startedAt = Date.now();

  /**
   * Dead-man switch: avisa a un servicio externo (healthchecks.io y similares)
   * de que el motor sigue vivo. Si el bucle se atasca o el proceso muere, los
   * avisos cesan y el servicio externo quien da la alarma. La URL viene del
   * entorno (operador), no de usuarios: se visita tal cual.
   */
  const pingDeadMan = async (): Promise<void> => {
    const url = deps.config.selfPingUrl;
    if (!url) return;
    if (
      lastSelfPingAt !== null &&
      Date.now() - lastSelfPingAt < deps.config.selfPingSeconds * 1000
    ) {
      return;
    }

    lastSelfPingAt = Date.now();

    try {
      const response = await fetch(url, {
        headers: { 'user-agent': 'Centinela/0.1' },
        signal: AbortSignal.timeout(NOTIFICATION_TIMEOUT_MS),
      });
      await response.body?.cancel().catch(() => undefined);
      if (!response.ok) {
        deps.log.warn({ status: response.status }, 'el servicio dead-man no aceptó el aviso');
      }
    } catch (error) {
      deps.log.warn({ err: error }, 'no se pudo avisar al servicio dead-man');
    }
  };

  const loop = (async () => {
    while (running) {
      try {
        const processed = await runWorkerOnce(deps);
        cycles += 1;
        lastCycleAt = Date.now();
        await pingDeadMan();
        if (processed === 0) await sleep(deps.config.tickMs);
      } catch (error) {
        // La base de datos puede estar de mantenimiento: esperar y reintentar.
        deps.log.error({ err: error }, 'error en el ciclo del worker; reintento con espera');
        await sleep(deps.config.tickMs * 5);
      }
    }
  })();

  return {
    runOnce: () => runWorkerOnce(deps),
    async stop() {
      running = false;
      await loop;
    },
    health() {
      const since = lastCycleAt ?? startedAt;
      const lagMs = Date.now() - since;

      return {
        cycles,
        lastCycleAt: lastCycleAt === null ? null : new Date(lastCycleAt).toISOString(),
        lagSeconds: Math.round(lagMs / 1000),
        stalled: lagMs > deps.config.stallSeconds * 1000,
        lastSelfPingAt: lastSelfPingAt === null ? null : new Date(lastSelfPingAt).toISOString(),
      };
    },
  };
}

async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (;;) {
      const item = queue.shift();
      if (item === undefined) return;
      await task(item);
    }
  });

  await Promise.all(runners);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
