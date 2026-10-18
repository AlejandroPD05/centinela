#!/usr/bin/env node
// Copia de seguridad de la base de datos de Centinela.
//
// Uso:
//   pnpm db:backup                    (lee DATABASE_URL del entorno o del .env)
//   BACKUP_DIR=ruta BACKUP_KEEP=30 pnpm db:backup
//
// Estrategia: `pg_dump` en formato custom (restaurable con `pg_restore`) y
// rotación de las últimas N copias. Si no hay `pg_dump` en el PATH pero sí
// Docker con el contenedor de desarrollo (docker-compose), se hace el volcado
// con `docker exec` contra la base local.
//
// La restauración está documentada en docs/OPERATIONS.md.

import { spawn } from 'node:child_process';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** DATABASE_URL del entorno o, si no, del .env del repo (fuera de producción). */
function loadDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

  try {
    process.loadEnvFile(path.join(repoRoot, '.env'));
  } catch {
    // Sin .env: se decide justo debajo.
  }

  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('Falta DATABASE_URL: expórtala o define el .env del repo.');
    process.exit(1);
  }
  return url;
}

/** Ejecuta un comando y devuelve `{ code, error }` sin heredar stdio. */
function run(command, args, onStdout) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ['ignore', onStdout ? 'pipe' : 'inherit', 'pipe'],
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    if (onStdout) child.stdout.on('data', onStdout);

    child.on('error', (error) => resolve({ code: -1, error, stderr }));
    child.on('close', (code) => resolve({ code, error: null, stderr }));
  });
}

const stamp = new Date().toISOString().slice(0, 19).replace('T', '_').replaceAll(':', '-');

const databaseUrl = loadDatabaseUrl();
const backupDir = path.resolve(repoRoot, process.env.BACKUP_DIR ?? 'backups');
const keep = Number.parseInt(process.env.BACKUP_KEEP ?? '14', 10);
const file = path.join(backupDir, `centinela_${stamp}.dump`);

await mkdir(backupDir, { recursive: true });

// 1) Camino directo: pg_dump del PATH.
console.log(`Volcando la base a ${file}…`);
let result = await run('pg_dump', [
  '--format=custom',
  '--no-owner',
  '--no-privileges',
  '--file',
  file,
  databaseUrl,
]);

// 2) Sin pg_dump pero con Docker: la base local del docker-compose.
if (result.error?.code === 'ENOENT') {
  const url = new URL(databaseUrl);
  const host = url.hostname;
  const local = host === 'localhost' || host === '127.0.0.1' || host === '::1';

  if (!local) {
    console.error('No hay `pg_dump` en el PATH y la base no es local: instala postgresql-client.');
    process.exit(1);
  }

  const container = process.env.CENTINELA_DB_CONTAINER ?? 'centinela-db-1';
  const dbName = url.pathname.replace(/^\//, '') || 'centinela';
  const user = decodeURIComponent(url.username) || 'centinela';

  console.log(`Sin pg_dump local; se usa Docker (contenedor ${container})…`);
  const fileHandle = (await import('node:fs')).createWriteStream(file);
  result = await run(
    'docker',
    [
      'exec',
      container,
      'pg_dump',
      '-U',
      user,
      '-d',
      dbName,
      '--format=custom',
      '--no-owner',
      '--no-privileges',
    ],
    (chunk) => fileHandle.write(chunk),
  );
  await new Promise((resolve) => fileHandle.end(resolve));

  if (result.code !== 0) {
    console.error(`docker exec falló: ${result.stderr.trim() || 'sin detalle'}`);
  }
}

if (result.code !== 0) {
  await rm(file, { force: true });
  console.error('La copia de seguridad falló; no se dejó ningún archivo a medias.');
  process.exit(1);
}

// 3) Rotación: se conservan las últimas `keep` copias.
const entries = (await readdir(backupDir))
  .filter((name) => name.startsWith('centinela_') && name.endsWith('.dump'))
  .sort()
  .reverse();

for (const old of entries.slice(keep)) {
  await rm(path.join(backupDir, old), { force: true });
}

const { size } = await stat(file);
const sizeMb = (size / (1024 * 1024)).toFixed(2);

console.log(`Copia lista: ${file} (${sizeMb} MB)`);
console.log(`Se conservan ${Math.min(entries.length, keep)} copias en ${backupDir}`);
