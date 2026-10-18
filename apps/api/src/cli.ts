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

/**
 * Utilidades de operación de Centinela, fuera del ciclo de la API.
 * Requiere build previo: `pnpm build` y luego `pnpm api:cli <comando>`.
 */

const USAGE = `Centinela — utilidades de operación

  create-user  Crea un usuario (y opcionalmente lo añade a un espacio de trabajo)

               Uso: pnpm api:cli create-user --email <correo> --password <contraseña>
                    [--name <nombre>] [--workspace <slug>] [--role admin|editor|viewer]

               Con --workspace, el espacio se crea si no existe y el rol por
               defecto es admin.`.trim();

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

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);

  switch (command) {
    case 'create-user':
      return createUser(rest);
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
