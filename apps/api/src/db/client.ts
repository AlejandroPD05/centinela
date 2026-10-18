import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.js';

/** Pool de PostgreSQL + instancia de Drizzle con el esquema completo. */
export function createDatabase(connectionString: string) {
  const pool = new Pool({ connectionString, max: 10 });
  const db = drizzle(pool, { schema });

  return { pool, db };
}

export type Database = ReturnType<typeof createDatabase>['db'];
