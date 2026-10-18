import type { NotificationChannelConfig, NotificationPayload } from '@centinela/shared';
import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
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
 * Esquema de datos de Centinela (M0–M3).
 *
 * Criterios:
 * - UUID para entidades; bigserial para series temporales (check_results).
 * - Todo cambio de esquema se aplica por migración (drizzle-kit generate).
 * - Los datos externos (config de canales, payload de avisos) viven en jsonb
 *   con su tipo TypeScript y se validan al escribir (zod, rutas).
 */

export const roleEnum = pgEnum('role', ['admin', 'editor', 'viewer']);
export const monitorTypeEnum = pgEnum('monitor_type', ['http', 'tcp', 'heartbeat']);
export const httpMethodEnum = pgEnum('http_method', ['GET', 'HEAD']);
export const checkStatusEnum = pgEnum('check_status', ['up', 'degraded', 'down', 'error']);
export const monitorStateEnum = pgEnum('monitor_state', ['pending', 'up', 'degraded', 'down']);
export const incidentEventKindEnum = pgEnum('incident_event_kind', [
  'opened',
  'recovered',
  'notified',
  'comment',
]);

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

    // Estado agregado, programación y contadores de confirmación
    state: monitorStateEnum('state').notNull().default('pending'),
    nextCheckAt: timestamp('next_check_at', { withTimezone: true }).notNull().defaultNow(),
    lastCheckAt: timestamp('last_check_at', { withTimezone: true }),
    lastStateChangeAt: timestamp('last_state_change_at', { withTimezone: true }),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    consecutiveSuccesses: integer('consecutive_successes').notNull().default(0),

    // Certificado TLS (solo monitores HTTP https; se sondea cada SSL_RECHECK_HOURS)
    sslExpiresAt: timestamp('ssl_expires_at', { withTimezone: true }),
    sslCheckedAt: timestamp('ssl_checked_at', { withTimezone: true }),
    sslIssuer: text('ssl_issuer'),
    sslError: text('ssl_error'),
    /** Última etapa de aviso SSL ya notificada (0–5): evita repetir el aviso. */
    sslAlertStage: integer('ssl_alert_stage').notNull().default(0),

    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex('monitors_workspace_slug_key').on(table.workspaceId, table.slug),
    index('monitors_workspace_idx').on(table.workspaceId),
    /** Índice parcial: el scheduler solo busca monitores activos y vencidos. */
    index('monitors_due_idx')
      .on(table.nextCheckAt)
      .where(sql`paused = false`),
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

/** Caída confirmada de un monitor, desde que se declara hasta que recupera. */
export const incidents = pgTable(
  'incidents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    monitorId: uuid('monitor_id')
      .notNull()
      .references(() => monitors.id, { onDelete: 'cascade' }),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    /** Motivo del primer fallo confirmado. */
    cause: text('cause'),
    createdAt: createdAt(),
  },
  (table) => [
    index('incidents_monitor_started_idx').on(table.monitorId, table.startedAt.desc()),
    /** Invariante: como mucho un incidente abierto por monitor. */
    uniqueIndex('incidents_open_per_monitor_key')
      .on(table.monitorId)
      .where(sql`resolved_at is null`),
  ],
);

/** Timeline de una incidencia: apertura, recuperación, avisos enviados, notas. */
export const incidentEvents = pgTable(
  'incident_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    incidentId: uuid('incident_id')
      .notNull()
      .references(() => incidents.id, { onDelete: 'cascade' }),
    kind: incidentEventKindEnum('kind').notNull(),
    detail: text('detail'),
    happenedAt: timestamp('happened_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('incident_events_incident_idx').on(table.incidentId, table.happenedAt)],
);

export const notificationChannelTypeEnum = pgEnum('notification_channel_type', [
  'discord',
  'webhook',
  'email',
]);
export const deliveryKindEnum = pgEnum('delivery_kind', ['down', 'recovered', 'ssl']);
export const deliveryStatusEnum = pgEnum('delivery_status', ['pending', 'sent', 'failed']);

/** Canal de aviso de un espacio de trabajo (Discord, webhook genérico o email). */
export const notificationChannels = pgTable(
  'notification_channels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    type: notificationChannelTypeEnum('type').notNull(),
    name: text('name').notNull(),
    /** Configuración según el tipo (discord: webhookUrl, ...); validada al escribir. */
    config: jsonb('config')
      .$type<NotificationChannelConfig>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('notification_channels_workspace_name_key').on(table.workspaceId, table.name),
  ],
);

/**
 * Cola de entregas de avisos. El worker la drena con `SKIP LOCKED`; cada
 * intento consume `attempts` y aparca el siguiente con backoff exponencial.
 * La entrega guarda una instantánea del evento: el canal no consulta nada más.
 */
export const deliveries = pgTable(
  'deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => notificationChannels.id, { onDelete: 'cascade' }),
    monitorId: uuid('monitor_id')
      .notNull()
      .references(() => monitors.id, { onDelete: 'cascade' }),
    /** Incidencia asociada, si el aviso nace de una caída o recuperación. */
    incidentId: uuid('incident_id').references(() => incidents.id, { onDelete: 'cascade' }),
    kind: deliveryKindEnum('kind').notNull(),
    payload: jsonb('payload').$type<NotificationPayload>().notNull(),
    status: deliveryStatusEnum('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [index('deliveries_due_idx').on(table.status, table.nextAttemptAt)],
);

/**
 * Sesión de un usuario: guarda el hash del token de refresco (nunca el
 * token), quién y desde dónde la abrió, y cuándo deja de valer. La rotación
 * revoca la usada y emite otra en la misma transacción.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    userAgent: text('user_agent'),
    ip: text('ip'),
    createdAt: createdAt(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    index('sessions_user_idx').on(table.userId),
    index('sessions_expires_idx').on(table.expiresAt),
  ],
);

/** Clave de API de un usuario (`cnt_…`): se guarda solo su huella y prefijo. */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Primeros caracteres visibles (`cnt_ab12cd34`), para identificarla sin revelarla. */
    prefix: text('prefix').notNull(),
    keyHash: text('key_hash').notNull().unique(),
    createdAt: createdAt(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [index('api_keys_user_idx').on(table.userId)],
);

/**
 * Registro de auditoría: quién hizo qué y sobre qué. `userId` y `workspaceId`
 * quedan nulos si la entidad desaparece (el rastro no se borra en cascada).
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'set null' }),
    /** Verbo estable en snake_case: `auth.login`, `monitor.create`… */
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    detail: jsonb('detail').$type<Record<string, unknown>>(),
    ip: text('ip'),
    createdAt: createdAt(),
  },
  (table) => [
    index('audit_log_created_idx').on(table.createdAt.desc()),
    index('audit_log_workspace_idx').on(table.workspaceId),
  ],
);
