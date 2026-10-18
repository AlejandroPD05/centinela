// Arranque de las pruebas E2E: recrea la base `centinela_e2e`, aplica las
// migraciones, siembra lo mínimo (operador, espacio y un monitor apuntando al
// servidor víctima) y levanta la API real en este mismo proceso, para que
// Playwright pueda pararla de un golpe al terminar.
//
// Requiere el build de la API hecho (`pnpm --filter @centinela/api build`);
// el script raíz `pnpm e2e` ya se encarga.
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { hashPassword } from '@centinela/api/dist/auth/password.js';
import { createDatabase } from '@centinela/api/dist/db/client.js';
import { memberships, monitors, users, workspaces } from '@centinela/api/dist/db/schema.js';
import { API_PORT, E2E_DATABASE, E2E_EMAIL, E2E_PASSWORD, VICTIM_PORT } from './ports.mjs';

const repoRoot = new URL('../../../', import.meta.url);

try {
  process.loadEnvFile(fileURLToPath(new URL('.env', repoRoot)));
} catch {
  // Sin .env: el error de abajo lo explica.
}

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error('[e2e] falta DATABASE_URL: copia .env.example a .env y arranca la base.');
  process.exit(1);
}

// 1) Base efímera propia de las pruebas (la de desarrollo no se toca).
const admin = new pg.Pool({ connectionString: baseUrl, max: 1 });
await admin.query(`drop database if exists ${E2E_DATABASE} with (force)`);
await admin.query(`create database ${E2E_DATABASE}`);

const e2eUrl = new URL(baseUrl);
e2eUrl.pathname = `/${E2E_DATABASE}`;

const { db, pool } = createDatabase(e2eUrl.toString());
await migrate(db, {
  migrationsFolder: fileURLToPath(new URL('../../api/drizzle', import.meta.url)),
});

// 2) Siembra mínima: operador, espacio con status page pública y un monitor
//    que apunta al servidor víctima de las pruebas.
const [user] = await db
  .insert(users)
  .values({
    email: E2E_EMAIL,
    name: 'Operador E2E',
    passwordHash: await hashPassword(E2E_PASSWORD),
  })
  .returning();
const [workspace] = await db
  .insert(workspaces)
  .values({ name: 'Vitrina E2E', slug: 'e2e' })
  .returning();
if (!user || !workspace) throw new Error('no se pudo sembrar el usuario o el espacio');

await db.insert(memberships).values({ userId: user.id, workspaceId: workspace.id, role: 'admin' });

await db.insert(monitors).values({
  workspaceId: workspace.id,
  name: 'Caja fuerte',
  slug: 'caja-fuerte',
  type: 'http',
  url: `http://127.0.0.1:${VICTIM_PORT}/`,
  isPublic: true,
  intervalSeconds: 30,
  timeoutMs: 3000,
  confirmFailures: 1,
  confirmRecoveries: 1,
  // Las pruebas fuerzan los checks por SQL: aquí solo se aleja el primero.
  nextCheckAt: new Date(Date.now() + 3_600_000),
});

await pool.end();
await admin.end();
console.log('[e2e] base y siembra listas');

// 3) La API real, en este proceso: fija el entorno antes de importar el entry.
process.env.NODE_ENV = 'development';
process.env.DATABASE_URL = e2eUrl.toString();
process.env.HOST = '127.0.0.1';
process.env.PORT = String(API_PORT);
process.env.LOG_LEVEL = process.env.E2E_LOG_LEVEL ?? 'warn';
process.env.WORKER_ENABLED = 'true';
process.env.WORKER_TICK_MS = '250';
process.env.ALLOW_PRIVATE_TARGETS = 'true';
process.env.JWT_SECRET = 'secreto-solo-para-las-pruebas-e2e-de-centinela';
process.env.RATE_LIMIT_PER_MINUTE = '100000';
process.env.PUBLIC_RATE_LIMIT_PER_MINUTE = '100000';

await import('@centinela/api/dist/index.js');
