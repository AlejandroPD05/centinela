import type { FastifyBaseLogger } from 'fastify';
import type { Database } from '../db/client.js';
import { claimDueMonitors } from './claim.js';
import { processMonitor } from './process.js';

export interface WorkerConfig {
  /** Sonda entre ciclos cuando no hay trabajo (ms). */
  tickMs: number;
  /** Monitores vencidos que se reclaman por ciclo. */
  batchSize: number;
  /** Checks que se ejecutan en paralelo. */
  concurrency: number;
  allowPrivateTargets: boolean;
}

export interface WorkerDeps {
  db: Database;
  log: FastifyBaseLogger;
  config: WorkerConfig;
}

export interface WorkerHandle {
  /** Procesa un único ciclo: reclama y ejecuta los checks vencidos. */
  runOnce(): Promise<number>;
  /** Detiene el bucle y espera a que terminen los checks en curso. */
  stop(): Promise<void>;
}

/** Ejecuta un ciclo completo del worker y devuelve cuántos monitores procesó. */
export async function runWorkerOnce(deps: WorkerDeps): Promise<number> {
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

  deps.log.debug({ claimed: claimed.length }, 'ciclo del worker completado');
  return claimed.length;
}

/**
 * Arranca el bucle del worker, embebido en la API: con WORKER_ENABLED=true el
 * mismo proceso sirve HTTP y ejecuta los checks. `stop()` espera a que acabe
 * el ciclo en curso.
 */
export function startWorker(deps: WorkerDeps): WorkerHandle {
  let running = true;

  const loop = (async () => {
    while (running) {
      try {
        const processed = await runWorkerOnce(deps);
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
