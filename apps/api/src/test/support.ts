import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { createDatabase, type Database } from '../db/client.js';

/** ¿Hay PostgreSQL detrás de esa URL? (sonda rápida y silenciosa). */
export async function canReachDatabase(url: string): Promise<boolean> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 2000 });
  try {
    await client.connect();
    await client.query('select 1');
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

export interface EphemeralDatabase {
  db: Database;
  drop(): Promise<void>;
}

const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));

/**
 * Crea una base de datos efímera con su nombre propio y le aplica las
 * migraciones programáticamente. Cada suite de integración usa la suya para
 * poder correr en paralelo sin pisarse; `drop()` la borra al terminar.
 */
export async function createEphemeralDatabase(
  adminUrl: string,
  name: string,
): Promise<EphemeralDatabase> {
  const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
  await admin.query(`drop database if exists ${name} with (force)`);
  await admin.query(`create database ${name}`);

  const testUrl = new URL(adminUrl);
  testUrl.pathname = `/${name}`;
  const { db, pool } = createDatabase(testUrl.toString());
  await migrate(db, { migrationsFolder });

  return {
    db,
    async drop() {
      await pool.end().catch(() => {});
      await admin.query(`drop database if exists ${name} with (force)`).catch(() => {});
      await admin.end().catch(() => {});
    },
  };
}
