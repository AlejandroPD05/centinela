import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { hashPassword } from './auth/password.js';
import type { Database } from './db/client.js';
import {
  checkResults,
  incidentEvents,
  incidents,
  memberships,
  monitors,
  sessions,
  users,
  workspaces,
} from './db/schema.js';

/**
 * Semilla de demostración: un espacio con monitores realistas e histórico de
 * 90 días (resultados, incidencias y certificados), pensado para enseñar la
 * status page y el panel sin datos de mentira improvisados.
 *
 * Es idempotente: cada ejecución borra y recrea el espacio demo, y reutiliza
 * (o crea) el usuario indicado. Los monitores apuntan a hosts estables
 * (example.com y el TLD reservado `.invalid`), así que el worker los puede
 * seguir vigilando sin que la demo se ensucie sola.
 */

export interface SeedDemoOptions {
  email: string;
  password: string;
  workspaceName: string;
  /** Días de histórico a generar. */
  days: number;
}

export interface SeedDemoResult {
  workspaceId: string;
  userId: string;
  monitors: number;
  checkResults: number;
  incidents: number;
}

/** PRNG determinista (mulberry32): la demo sale igual en cada máquina. */
function createRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface SeedIncident {
  /** Minutos desde el inicio del histórico hasta la caída. */
  startedMinutesAgo: number;
  /** Duración; `null` si sigue abierta. */
  durationMinutes: number | null;
  cause: string;
  error: string;
}

interface SeedMonitor {
  name: string;
  slug: string;
  type: 'http' | 'tcp' | 'heartbeat';
  url: string | null;
  host: string | null;
  port: number | null;
  isPublic: boolean;
  paused: boolean;
  state: 'up' | 'degraded' | 'down';
  intervalSeconds: number;
  timeoutMs: number;
  degradedLatencyMs: number | null;
  confirmFailures: number;
  confirmRecoveries: number;
  /** Milisegundos base y ruido del PRNG para la latencia. */
  baseLatency: number;
  jitter: number;
  latencyFactor: number;
  /** Caídas pintadas en el histórico (y su incidencia asociada). */
  incident?: SeedIncident;
  /** Si está pausado: minutos desde el inicio hasta que se pausó. */
  pausedAfterMinutes?: number;
  /** El sondeo TLS con su información. */
  ssl?: { expiresInDays: number; issuer: string };
}

const day = 24 * 60;

const SEED_MONITORS: SeedMonitor[] = [
  {
    name: 'Portfolio y proyectos',
    slug: 'portfolio',
    type: 'http',
    url: 'https://example.com',
    host: null,
    port: null,
    isPublic: true,
    paused: false,
    state: 'up',
    intervalSeconds: 300,
    timeoutMs: 10_000,
    degradedLatencyMs: 1500,
    confirmFailures: 2,
    confirmRecoveries: 1,
    baseLatency: 180,
    jitter: 90,
    latencyFactor: 1,
    // Una caída de seis minutos tras un despliegue, hace 40 días.
    incident: {
      startedMinutesAgo: 40 * day,
      durationMinutes: 6,
      cause: 'timeout de 10 s tras el despliegue',
      error: 'tiempo de espera agotado',
    },
    ssl: { expiresInDays: 63, issuer: "Let's Encrypt" },
  },
  {
    name: 'API de demos',
    slug: 'api-demo',
    type: 'http',
    url: 'https://example.net',
    host: null,
    port: null,
    isPublic: true,
    paused: false,
    state: 'degraded',
    intervalSeconds: 300,
    timeoutMs: 10_000,
    degradedLatencyMs: 400,
    confirmFailures: 2,
    confirmRecoveries: 1,
    baseLatency: 310,
    jitter: 160,
    latencyFactor: 1.15,
    ssl: { expiresInDays: 21, issuer: "Let's Encrypt" },
  },
  {
    name: 'Blog de notas',
    slug: 'blog',
    type: 'http',
    url: 'https://example.org',
    host: null,
    port: null,
    isPublic: true,
    paused: false,
    state: 'up',
    intervalSeconds: 600,
    timeoutMs: 10_000,
    degradedLatencyMs: 2000,
    confirmFailures: 3,
    confirmRecoveries: 2,
    baseLatency: 240,
    jitter: 120,
    latencyFactor: 1,
    // Caída de 22 minutos al renovar el certificado, hace 12 días.
    incident: {
      startedMinutesAgo: 12 * day + 300,
      durationMinutes: 22,
      cause: '502 del proxy al renovar el certificado',
      error: 'código 502; se esperaba 200',
    },
    ssl: { expiresInDays: 71, issuer: "Let's Encrypt" },
  },
  {
    name: 'Copias de seguridad',
    slug: 'copias',
    type: 'tcp',
    url: null,
    host: 'example.com',
    port: 443,
    isPublic: true,
    paused: false,
    state: 'up',
    intervalSeconds: 900,
    timeoutMs: 5000,
    degradedLatencyMs: null,
    confirmFailures: 2,
    confirmRecoveries: 1,
    baseLatency: 45,
    jitter: 30,
    latencyFactor: 1,
  },
  {
    name: 'Pasarela de pagos',
    slug: 'pasarela',
    type: 'http',
    url: 'https://example.com',
    host: null,
    port: null,
    isPublic: true,
    paused: false,
    state: 'up',
    intervalSeconds: 600,
    timeoutMs: 10_000,
    degradedLatencyMs: 2000,
    confirmFailures: 2,
    confirmRecoveries: 1,
    baseLatency: 190,
    jitter: 80,
    latencyFactor: 1,
  },
  {
    name: 'Panel de automatización (n8n)',
    slug: 'n8n',
    type: 'http',
    url: 'https://api.invalid',
    host: null,
    port: null,
    isPublic: true,
    paused: false,
    state: 'down',
    intervalSeconds: 300,
    timeoutMs: 10_000,
    degradedLatencyMs: null,
    confirmFailures: 1,
    confirmRecoveries: 1,
    baseLatency: 60,
    jitter: 40,
    latencyFactor: 1,
    // Incidencia abierta: el subdominio dejó de resolver hace 6 días.
    incident: {
      startedMinutesAgo: 6 * day + 95,
      durationMinutes: null,
      cause: 'el dominio no resuelve (DNS)',
      error: 'el dominio no resuelve (DNS)',
    },
  },
  {
    name: 'CRM interno',
    slug: 'crm',
    type: 'http',
    url: 'https://example.org/crm',
    host: null,
    port: null,
    isPublic: false,
    paused: true,
    state: 'up',
    intervalSeconds: 300,
    timeoutMs: 10_000,
    degradedLatencyMs: null,
    confirmFailures: 2,
    confirmRecoveries: 1,
    baseLatency: 210,
    jitter: 70,
    latencyFactor: 1,
    // Pausado hace 15 días (migración interna en marcha).
    pausedAfterMinutes: 15 * day,
  },
];

/** Genera el histórico de un monitor: una fila cada `intervalSeconds`. */
function buildHistory(
  monitor: SeedMonitor,
  { days, nowMs, random }: { days: number; nowMs: number; random: () => number },
): Array<{
  status: 'up' | 'degraded' | 'down' | 'error';
  latencyMs: number | null;
  statusCode: number | null;
  error: string | null;
  checkedAt: Date;
}> {
  const rows = [];

  const totalMinutes = days * day;
  const stepMinutes = Math.max(5, Math.round(monitor.intervalSeconds / 60));
  const stopAt =
    monitor.pausedAfterMinutes !== undefined ? totalMinutes - monitor.pausedAfterMinutes : 0;
  const incident = monitor.incident;
  // La ventana se piensa en «minutos atrás»: se abrió hace `startedMinutesAgo`
  // (borde antiguo) y, si está cerrada, duró lo indicado (borde reciente).
  const incidentStart = incident ? incident.startedMinutesAgo : Number.NaN;
  const incidentEnd = incident
    ? incident.durationMinutes === null
      ? 0
      : incident.startedMinutesAgo - incident.durationMinutes
    : Number.NaN;

  for (let minutesAgo = totalMinutes; minutesAgo >= stopAt; minutesAgo -= stepMinutes) {
    const checkedAt = new Date(nowMs - minutesAgo * 60_000);

    const insideIncident = incident && minutesAgo <= incidentStart && minutesAgo >= incidentEnd;

    if (insideIncident) {
      rows.push({
        status: incident.durationMinutes === null ? ('error' as const) : ('down' as const),
        latencyMs: incident.error.startsWith('código') ? 90 : null,
        statusCode: incident.error.startsWith('código') ? 502 : null,
        error: incident.error,
        checkedAt,
      });
      continue;
    }

    // Variación diurna suave + ruido del PRNG determinista.
    const hourFactor = 0.85 + 0.3 * Math.sin((checkedAt.getUTCHours() / 24) * Math.PI * 2);
    const latency = Math.round(
      (monitor.baseLatency + random() * monitor.jitter) * hourFactor * monitor.latencyFactor,
    );

    const degraded =
      monitor.degradedLatencyMs !== null && latency >= monitor.degradedLatencyMs && random() > 0.35;

    rows.push({
      status: degraded ? ('degraded' as const) : ('up' as const),
      latencyMs: monitor.type === 'heartbeat' ? null : latency,
      statusCode: monitor.type === 'http' ? 200 : null,
      error: null,
      checkedAt,
    });
  }

  return rows;
}

/**
 * Deja el tramo final coherente con el estado agregado del monitor: si está
 * `degraded`, los últimos checks también lo están (y al revés).
 */
function alignTail(monitor: SeedMonitor, rows: ReturnType<typeof buildHistory>): void {
  if (monitor.state !== 'degraded' || monitor.degradedLatencyMs === null) return;

  for (let index = rows.length - 3; index < rows.length; index++) {
    const row = rows[index];
    if (!row) continue;
    row.status = 'degraded';
    row.latencyMs = monitor.degradedLatencyMs + 40 * (index + 1);
    row.error = null;
    row.statusCode = monitor.type === 'http' ? 200 : null;
  }
}

export async function seedDemo(db: Database, options: SeedDemoOptions): Promise<SeedDemoResult> {
  const random = createRandom(0xce1717);
  const nowMs = Date.now();
  const now = new Date(nowMs);

  const workspaceSlug = 'demo';

  return db.transaction(async (tx) => {
    // 1) Usuario del panel: se reutiliza si ya existe.
    const email = options.email.trim().toLowerCase();
    const passwordHash = await hashPassword(options.password);

    let [user] = await tx.select().from(users).where(eq(users.email, email));
    if (user) {
      await tx.update(users).set({ passwordHash }).where(eq(users.id, user.id));
      // Sesiones viejas fuera: la contraseña acaba de cambiar.
      await tx.delete(sessions).where(eq(sessions.userId, user.id));
    } else {
      [user] = await tx
        .insert(users)
        .values({ email, name: 'Alejandro', passwordHash })
        .returning();
    }
    if (!user) throw new Error('no se pudo crear el usuario de la demo');

    // 2) Espacio demo: se borra entero (cascada) y se recrea.
    await tx.delete(workspaces).where(eq(workspaces.slug, workspaceSlug));
    const [workspace] = await tx
      .insert(workspaces)
      .values({ name: options.workspaceName, slug: workspaceSlug })
      .returning();
    if (!workspace) throw new Error('no se pudo crear el espacio de la demo');

    await tx
      .insert(memberships)
      .values({ userId: user.id, workspaceId: workspace.id, role: 'admin' });

    let resultCount = 0;
    let incidentCount = 0;

    for (const monitor of SEED_MONITORS) {
      // 3) Monitor con su estado y programación sana (nunca en el pasado).
      const history = buildHistory(monitor, { days: options.days, nowMs, random });
      alignTail(monitor, history);
      const lastCheck = history.at(-1)?.checkedAt ?? null;

      const nextCheck = new Date(
        nowMs +
          (monitor.paused ? 10 * day * 60_000 : monitor.intervalSeconds * 1000) +
          random() * 30_000,
      );

      const [row] = await tx
        .insert(monitors)
        .values({
          workspaceId: workspace.id,
          name: monitor.name,
          slug: monitor.slug,
          type: monitor.type,
          url: monitor.url,
          host: monitor.host,
          port: monitor.port,
          isPublic: monitor.isPublic,
          paused: monitor.paused,
          state: monitor.state,
          intervalSeconds: monitor.intervalSeconds,
          timeoutMs: monitor.timeoutMs,
          degradedLatencyMs: monitor.degradedLatencyMs,
          confirmFailures: monitor.confirmFailures,
          confirmRecoveries: monitor.confirmRecoveries,
          nextCheckAt: nextCheck,
          lastCheckAt: lastCheck,
          lastStateChangeAt: lastCheck,
          consecutiveFailures: monitor.state === 'down' ? 3 : 0,
          consecutiveSuccesses: monitor.state === 'up' ? 3 : 0,
          heartbeatToken: monitor.type === 'heartbeat' ? randomBytes(16).toString('hex') : null,
          heartbeatPeriodSeconds: monitor.type === 'heartbeat' ? 3600 : null,
          heartbeatGraceSeconds: monitor.type === 'heartbeat' ? 300 : null,
          sslExpiresAt: monitor.ssl
            ? new Date(nowMs + monitor.ssl.expiresInDays * day * 60_000)
            : null,
          sslCheckedAt: monitor.ssl ? now : null,
          sslIssuer: monitor.ssl?.issuer ?? null,
        })
        .returning();
      if (!row) throw new Error(`no se pudo crear el monitor ${monitor.slug}`);

      // 4) Histórico por lotes (resultados).
      const chunkSize = 2000;
      for (let index = 0; index < history.length; index += chunkSize) {
        await tx
          .insert(checkResults)
          .values(
            history.slice(index, index + chunkSize).map((item) => ({ ...item, monitorId: row.id })),
          );
      }
      resultCount += history.length;

      // 5) Incidencia (abierta o cerrada) con su timeline.
      if (monitor.incident) {
        const startedAt = new Date(nowMs - monitor.incident.startedMinutesAgo * 60_000);
        const resolvedAt =
          monitor.incident.durationMinutes === null
            ? null
            : new Date(startedAt.getTime() + monitor.incident.durationMinutes * 60_000);

        const [incident] = await tx
          .insert(incidents)
          .values({ monitorId: row.id, startedAt, resolvedAt, cause: monitor.incident.cause })
          .returning();
        if (!incident) throw new Error(`no se pudo crear la incidencia de ${monitor.slug}`);

        await tx
          .insert(incidentEvents)
          .values([
            { incidentId: incident.id, kind: 'opened', happenedAt: startedAt },
            { incidentId: incident.id, kind: 'notified', happenedAt: startedAt },
            ...(resolvedAt
              ? [{ incidentId: incident.id, kind: 'recovered' as const, happenedAt: resolvedAt }]
              : []),
          ]);
        incidentCount += 1;
      }
    }

    return {
      workspaceId: workspace.id,
      userId: user.id,
      monitors: SEED_MONITORS.length,
      checkResults: resultCount,
      incidents: incidentCount,
    };
  });
}
