import { buildServer } from './app.js';
import { loadEnv, loadEnvFileIfPresent } from './config/env.js';
import { createDatabase } from './db/client.js';

loadEnvFileIfPresent();

const env = loadEnv();
const { pool, db } = createDatabase(env.DATABASE_URL);
const app = buildServer({ env, database: db });

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'apagando Centinela');

  try {
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
