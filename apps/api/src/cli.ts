import { parseArgs } from 'node:util';
import { roles, slugify, type Role } from '@centinela/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { recordAudit } from './audit/record.js';
import { hashPassword } from './auth/password.js';
import { loadEnv, loadEnvFileIfPresent } from './config/env.js';
import { createDatabase } from './db/client.js';
import { pgErrorInfo } from './db/errors.js';
import { memberships, users, workspaces } from './db/schema.js';
import { seedDemo } from './seed.js';

/**
 * Utilidades de operación de Centinela, fuera del ciclo de la API.
 * Requiere build previo: `pnpm build` y luego `pnpm api:cli <comando>`.
 */

const USAGE = `Centinela — utilidades de operación

  create-user  Crea un usuario (y opcionalmente lo añade a un espacio de trabajo)

               Uso: pnpm api:cli create-user --email <correo> --password <contraseña>
                    [--name <nombre>] [--workspace <slug>] [--role admin|editor|viewer]

               Con --workspace, el espacio se crea si no existe y el rol por
               defecto es admin.

  seed-demo    Recrea el espacio de demostración (slug «demo») con monitores
               realistas e histórico de 90 días. Idempotente: lo borra y lo
               vuelve a crear en cada ejecución.

               Uso: pnpm api:cli seed-demo [--email <correo>] [--password <contraseña>]
                    [--workspace <nombre>] [--days <n>]

               Por defecto: alejandro@centinela.local / centinela-demo-2026,
               espacio «Centinela Demo» y 90 días de histórico.`.trim();

interface CreateUserValues {
  email?: string;
  password?: string;
  name?: string;
  workspace?: string;
  role?: string;
}

async function createUser(argv: string[]): Promise<number> {
  let values: CreateUserValues;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        email: { type: 'string' },
        password: { type: 'string' },
        name: { type: 'string' },
        workspace: { type: 'string' },
        role: { type: 'string' },
      },
    }));
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    console.error(USAGE);
    return 2;
  }

  const email = values.email?.trim().toLowerCase();
  if (email === undefined || !z.email().safeParse(email).success) {
    console.error('error: --email debe ser un correo válido');
    return 2;
  }

  const password = values.password;
  if (password === undefined || password.length < 8) {
    console.error('error: --password es obligatorio y debe tener al menos 8 caracteres');
    return 2;
  }

  const name = values.name?.trim() || email.split('@')[0] || 'sin nombre';

  const role = (values.role ?? 'admin') as Role;
  if (!roles.includes(role)) {
    console.error(`error: --role debe ser uno de: ${roles.join(', ')}`);
    return 2;
  }

  loadEnvFileIfPresent();
  const env = loadEnv();
  const { db, pool } = createDatabase(env.DATABASE_URL);

  try {
    let user;
    try {
      [user] = await db
        .insert(users)
        .values({ email, name, passwordHash: await hashPassword(password) })
        .returning();
    } catch (error) {
      if (pgErrorInfo(error).code === '23505') {
        console.error(`error: ya existe un usuario con el correo ${email}`);
        return 1;
      }
      throw error;
    }
    if (!user) throw new Error('sin fila al crear el usuario');

    let membershipInfo: string | null = null;
    const workspaceName = values.workspace?.trim();
    if (workspaceName) {
      const slug = slugify(workspaceName) || workspaceName.toLowerCase();

      let [workspace] = await db.select().from(workspaces).where(eq(workspaces.slug, slug));
      if (!workspace) {
        [workspace] = await db.insert(workspaces).values({ name: workspaceName, slug }).returning();
        if (!workspace) throw new Error('sin fila al crear el espacio de trabajo');
      }

      await db
        .insert(memberships)
        .values({ userId: user.id, workspaceId: workspace.id, role })
        .onConflictDoUpdate({
          target: [memberships.userId, memberships.workspaceId],
          set: { role },
        });

      membershipInfo = `${workspace.name} (${workspace.slug}) con rol ${role}`;
    }

    await recordAudit(db, {
      userId: null,
      action: 'user.create',
      targetType: 'user',
      targetId: user.id,
      detail: {
        email,
        via: 'cli',
        ...(membershipInfo !== null ? { workspace: membershipInfo } : {}),
      },
    });

    console.log('Usuario creado:');
    console.log(`  id:     ${user.id}`);
    console.log(`  correo: ${user.email}`);
    console.log(`  nombre: ${user.name}`);
    if (membershipInfo !== null) console.log(`  espacio: ${membershipInfo}`);
    console.log('Entra con POST /api/auth/login.');

    return 0;
  } finally {
    await pool.end();
  }
}

async function runSeedDemo(argv: string[]): Promise<number> {
  let values: { email?: string; password?: string; workspace?: string; days?: string };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        email: { type: 'string' },
        password: { type: 'string' },
        workspace: { type: 'string' },
        days: { type: 'string' },
      },
    }));
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    console.error(USAGE);
    return 2;
  }

  const email = values.email?.trim().toLowerCase() ?? 'alejandro@centinela.local';
  if (!z.email().safeParse(email).success) {
    console.error('error: --email debe ser un correo válido');
    return 2;
  }

  const password = values.password ?? 'centinela-demo-2026';
  if (password.length < 8) {
    console.error('error: --password debe tener al menos 8 caracteres');
    return 2;
  }

  const days = values.days === undefined ? 90 : Number.parseInt(values.days, 10);
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    console.error('error: --days debe ser un entero entre 1 y 365');
    return 2;
  }

  loadEnvFileIfPresent();
  const env = loadEnv();
  const { db, pool } = createDatabase(env.DATABASE_URL);

  try {
    console.log(`Sembrando la demo (${days} días de histórico)…`);
    const result = await seedDemo(db, {
      email,
      password,
      workspaceName: values.workspace?.trim() || 'Centinela Demo',
      days,
    });

    await recordAudit(db, {
      userId: null,
      action: 'seed.demo',
      targetType: 'workspace',
      targetId: result.workspaceId,
      detail: { via: 'cli', days, monitors: result.monitors },
    });

    console.log('Demo lista:');
    console.log(`  espacio:   ${result.workspaceId} (slug demo)`);
    console.log(`  usuario:   ${email}`);
    console.log(`  monitores: ${result.monitors}`);
    console.log(`  histórico: ${result.checkResults.toLocaleString('es-ES')} checks`);
    console.log(`  incidencias: ${result.incidents}`);
    console.log('Status page: /status/demo');
    return 0;
  } finally {
    await pool.end();
  }
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);

  switch (command) {
    case 'create-user':
      return createUser(rest);
    case 'seed-demo':
      return runSeedDemo(rest);
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      console.log(USAGE);
      return 0;
    default:
      console.error(`error: comando desconocido «${command}»`);
      console.error(USAGE);
      return 2;
  }
}

process.exitCode = await main().catch((error: unknown) => {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  return 1;
});
