import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.js';

/**
 * Pool de PostgreSQL + instancia de Drizzle con el esquema completo.
 *
 * Un pool de node-postgres sin oyente de `error` tumba el proceso entero en
 * cuanto una conexión en reposo recibe un corte: mantenimiento del servidor,
 * un parpadeo de red, o —en las pruebas— el `drop … with (force)` de las
 * bases efímeras, que alcanza a los sockets que todavía se están cerrando
 * después de `pool.end()`. Aquí se dejan oyentes que absorben esos avisos de
 * conexión; quien necesite enterarse (el servicio, para su registro) añade su
 * propio `pool.on('error', …)`.
 */
export function createDatabase(connectionString: string) {
  const pool = new Pool({ connectionString, max: 10 });
  pool.on('connect', (client) => {
    client.on('error', () => {});
  });
  pool.on('error', () => {});
  const db = drizzle(pool, { schema });

  return { pool, db };
}

export type Database = ReturnType<typeof createDatabase>['db'];
