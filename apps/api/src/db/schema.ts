import {
  bigserial,
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Esquema de datos de Centinela (M0–M1).
 *
 * Criterios:
 * - UUID para entidades; bigserial para series temporales (check_results).
 * - Todo cambio de esquema se aplica por migración (drizzle-kit generate).
 * - Las tablas de incidencias, canales y avisos SSL llegan en M2–M3.
 */

export const roleEnum = pgEnum('role', ['admin', 'editor', 'viewer']);
export const monitorTypeEnum = pgEnum('monitor_type', ['http', 'tcp', 'heartbeat']);
export const httpMethodEnum = pgEnum('http_method', ['GET', 'HEAD']);
export const checkStatusEnum = pgEnum('check_status', ['up', 'degraded', 'down', 'error']);

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  passwordHash: text('password_hash').notNull(),
  createdAt: createdAt(),
});

export const workspaces = pgTable('workspaces', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  createdAt: createdAt(),
});

/** Pertenencia de un usuario a un espacio de trabajo, con su rol. */
export const memberships = pgTable(
  'memberships',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    role: roleEnum('role').notNull().default('viewer'),
    createdAt: createdAt(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.workspaceId] })],
);

export const monitors = pgTable(
  'monitors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Identificador legible y único dentro del espacio: /status/:slug, /badge/:slug.svg */
    slug: text('slug').notNull(),
    type: monitorTypeEnum('type').notNull().default('http'),

    // HTTP
    url: text('url'),
    method: httpMethodEnum('method').notNull().default('GET'),
    expectedStatus: smallint('expected_status').notNull().default(200),
    /** Palabra clave obligatoria en el cuerpo para dar el check por bueno. */
    keyword: text('keyword'),

    // TCP
    host: text('host'),
    port: integer('port'),

    // Heartbeat: el servicio avisa a Centinela; si el ping no llega, alerta.
    heartbeatToken: text('heartbeat_token').unique(),
    heartbeatPeriodSeconds: integer('heartbeat_period_seconds'),
    heartbeatGraceSeconds: integer('heartbeat_grace_seconds'),

    // Comportamiento del check
    intervalSeconds: integer('interval_seconds').notNull().default(300),
    timeoutMs: integer('timeout_ms').notNull().default(10_000),
    /** Latencia a partir de la cual el check pasa a `degraded`. */
    degradedLatencyMs: integer('degraded_latency_ms'),
    /** Fallos consecutivos necesarios para confirmar una caída. */
    confirmFailures: integer('confirm_failures').notNull().default(2),
    /** Éxitos consecutivos necesarios para confirmar la recuperación. */
    confirmRecoveries: integer('confirm_recoveries').notNull().default(1),

    // Visibilidad y estado
    isPublic: boolean('is_public').notNull().default(false),
    paused: boolean('paused').notNull().default(false),

    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex('monitors_workspace_slug_key').on(table.workspaceId, table.slug),
    index('monitors_workspace_idx').on(table.workspaceId),
  ],
);

/** Serie temporal de resultados: materia prima de la cinta y los percentiles. */
export const checkResults = pgTable(
  'check_results',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    monitorId: uuid('monitor_id')
      .notNull()
      .references(() => monitors.id, { onDelete: 'cascade' }),
    status: checkStatusEnum('status').notNull(),
    latencyMs: integer('latency_ms'),
    statusCode: integer('status_code'),
    /** Motivo del fallo cuando lo hay (timeout, DNS, código inesperado...). */
    error: text('error'),
    checkedAt: timestamp('checked_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('check_results_monitor_time_idx').on(table.monitorId, table.checkedAt)],
);
