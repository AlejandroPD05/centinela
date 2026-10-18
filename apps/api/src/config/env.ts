import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/** Acepta `true/false` y `1/0` en el entorno (que siempre llega como texto). */
const booleanish = (defaultValue: boolean) =>
  z
    .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
    .default(defaultValue)
    .transform((value) => value === true || value === 'true' || value === '1');

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

  // Motor de checks (worker embebido en la API).
  WORKER_ENABLED: booleanish(true),
  WORKER_TICK_MS: z.coerce.number().int().min(50).max(60_000).default(1000),
  WORKER_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(10),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(5),

  // Guarda SSRF: desactivable solo para desarrollo local y tests.
  ALLOW_PRIVATE_TARGETS: booleanish(false),

  // Accesos y sesiones (M4).
  JWT_SECRET: z.string().min(32, 'JWT_SECRET debe tener al menos 32 caracteres'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(3_600),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(3_650).default(30),
  LOGIN_ATTEMPTS_PER_MINUTE: z.coerce.number().int().min(1).max(1_000).default(10),

  // Revisión del certificado TLS de los monitores https.
  SSL_RECHECK_HOURS: z.coerce.number().int().min(1).max(720).default(24),

  // Avisos por email vía Resend (opcionales: sin claves, el canal email falla
  // con un motivo claro en lugar de tumbar el worker).
  RESEND_API_KEY: z.string().min(1).optional(),
  EMAIL_FROM: z.string().min(1).optional(),
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
