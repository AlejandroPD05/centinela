import { buildServer } from './app.js';
import { loadEnv, loadEnvFileIfPresent } from './config/env.js';
import { createDatabase } from './db/client.js';
import { shutdown as shutdownHub } from './events/hub.js';
import { startWorker, type WorkerHandle } from './worker/worker.js';

loadEnvFileIfPresent();

const env = loadEnv();
const { pool, db } = createDatabase(env.DATABASE_URL);

let worker: WorkerHandle | null = null;
const app = buildServer({ env, database: db, workerHealth: () => worker?.health() ?? null });

worker = env.WORKER_ENABLED
  ? startWorker({
      db,
      log: app.log,
      config: {
        tickMs: env.WORKER_TICK_MS,
        batchSize: env.WORKER_BATCH_SIZE,
        concurrency: env.WORKER_CONCURRENCY,
        allowPrivateTargets: env.ALLOW_PRIVATE_TARGETS,
        sslRecheckHours: env.SSL_RECHECK_HOURS,
        stallSeconds: env.WORKER_STALL_SECONDS,
        selfPingUrl: env.SELF_PING_URL,
        selfPingSeconds: env.SELF_PING_SECONDS,
        resendApiKey: env.RESEND_API_KEY,
        emailFrom: env.EMAIL_FROM,
      },
    })
  : null;

if (worker) {
  app.log.info(
    {
      batchSize: env.WORKER_BATCH_SIZE,
      concurrency: env.WORKER_CONCURRENCY,
      deadMan: env.SELF_PING_URL ? 'configurado' : 'no configurado',
    },
    'motor de checks activo',
  );
}

// Vigilante del motor: si el bucle lleva demasiado sin cerrar un ciclo, deja
// constancia en el log una sola vez por atasco (y /api/health lo refleja).
// Este intervalo vive fuera del bucle a propósito: un bucle atascado no puede
// avisar de su propio atasco.
let stallReported = false;
const watchdog = setInterval(() => {
  if (!worker) return;

  const health = worker.health();

  if (health.stalled && !stallReported) {
    stallReported = true;
    app.log.error(
      {
        ciclos: health.cycles,
        ultimoCiclo: health.lastCycleAt,
        retrasoSegundos: health.lagSeconds,
      },
      'el motor de checks lleva demasiado sin cerrar un ciclo',
    );
  } else if (!health.stalled && stallReported) {
    stallReported = false;
    app.log.info({ ciclos: health.cycles }, 'el motor de checks vuelve a cerrar ciclos');
  }
}, 30_000);
watchdog.unref();

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'apagando Centinela');

  // Red de seguridad: si algo se atasca (una conexión que no suelta), se sale
  // igualmente en unos segundos.
  const hardExit = setTimeout(() => {
    app.log.error('el apagado no terminó a tiempo; salida forzada');
    process.exit(1);
  }, 15_000);
  hardExit.unref();

  try {
    clearInterval(watchdog);
    await worker?.stop();
    // Despide las conexiones SSE antes de cerrar: las páginas reconectarán
    // solas cuando el servicio vuelva.
    shutdownHub();
    await app.close();
    await pool.end();
    process.exit(0);
  } catch (error) {
    app.log.error({ err: error }, 'error durante el apagado');
    process.exit(1);
  }
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ host: env.HOST, port: env.PORT });
} catch (error) {
  app.log.error({ err: error }, 'no se pudo arrancar el servidor');
  process.exit(1);
}
