import { buildServer } from './app.js';
import { loadEnv, loadEnvFileIfPresent } from './config/env.js';
import { createDatabase } from './db/client.js';
import { startWorker } from './worker/worker.js';

loadEnvFileIfPresent();

const env = loadEnv();
const { pool, db } = createDatabase(env.DATABASE_URL);
const app = buildServer({ env, database: db });

const worker = env.WORKER_ENABLED
  ? startWorker({
      db,
      log: app.log,
      config: {
        tickMs: env.WORKER_TICK_MS,
        batchSize: env.WORKER_BATCH_SIZE,
        concurrency: env.WORKER_CONCURRENCY,
        allowPrivateTargets: env.ALLOW_PRIVATE_TARGETS,
      },
    })
  : null;

if (worker) {
  app.log.info(
    { batchSize: env.WORKER_BATCH_SIZE, concurrency: env.WORKER_CONCURRENCY },
    'motor de checks activo',
  );
}

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'apagando Centinela');

  try {
    await worker?.stop();
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
