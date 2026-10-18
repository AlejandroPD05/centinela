import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/**
 * Configuración validada al arrancar: si algo falta o está mal, el proceso no
 * sale a flote. Mejor un error explícito en el log que un fallo raro a medias.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(0).max(65535).default(4100),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z
    .string()
    .min(1)
    .refine(
      (value) => value.startsWith('postgres'),
      'DATABASE_URL debe ser una cadena de conexión de PostgreSQL',
    ),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Carga `.env` en desarrollo; en producción las variables vienen del entorno.
 *
 * Los scripts se ejecutan con CWD en `apps/api`, así que además del `.env`
 * local se busca el `.env` de la raíz del monorepo (el único que el proyecto
 * pide copiar: `Copy-Item .env.example .env`).
 */
export function loadEnvFileIfPresent(): void {
  if (process.env.NODE_ENV === 'production') return;

  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.resolve(process.cwd(), '.env'), path.resolve(here, '../../../../.env')];

  for (const candidate of candidates) {
    try {
      process.loadEnvFile(candidate);
      return;
    } catch {
      // Siguiente candidato.
    }
  }
}

/** Valida el entorno (con overrides opcionales, útil en tests). */
export function loadEnv(overrides: Record<string, string | undefined> = {}): Env {
  const parsed = envSchema.safeParse({ ...process.env, ...overrides });

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Configuración inválida:\n${issues}`);
  }

  return parsed.data;
}
