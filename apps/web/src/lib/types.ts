// Tipos espejo de las respuestas de la API (apps/api/src/routes/*).
// A mano y deliberadamente planos: el panel consume JSON, no ORM.

export type Role = 'admin' | 'editor' | 'viewer';
export type MonitorType = 'http' | 'tcp' | 'heartbeat';
export type MonitorState = 'pending' | 'up' | 'degraded' | 'down';
export type CheckStatus = 'up' | 'degraded' | 'down' | 'error';
export type ChannelType = 'discord' | 'webhook' | 'email';
export type DeliveryKind = 'down' | 'recovered' | 'ssl';
export type DeliveryStatus = 'pending' | 'sent' | 'failed';
export type UptimeWindowName = '24h' | '7d' | '30d' | '90d';

export interface SessionUser {
  id: string;
  email: string;
  name: string;
}

export interface Session {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  user: SessionUser;
}

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  role: Role;
  createdAt?: string;
}

export interface MeResponse {
  user: { sub: string; email: string; name: string; iat: number; exp: number };
  workspaces: Workspace[];
}

export interface SslView {
  expiresAt: string | null;
  checkedAt: string | null;
  issuer: string | null;
  error: string | null;
}

export interface MonitorStatsWindow {
  total: number;
  available: number;
  ratio: number | null;
}

export interface MonitorStats {
  day: MonitorStatsWindow;
  week: MonitorStatsWindow;
  openIncidents: number;
}

export interface MonitorView {
  id: string;
  workspaceId: string;
  name: string;
  slug: string;
  type: MonitorType;
  url: string | null;
  host: string | null;
  port: number | null;
  state: MonitorState;
  isPublic: boolean;
  paused: boolean;
  intervalSeconds: number;
  timeoutMs: number;
  confirmFailures: number;
  confirmRecoveries: number;
  lastCheckAt: string | null;
  lastStateChangeAt: string | null;
  nextCheckAt: string;
  ssl: SslView | null;
  /** Solo lo rellena el listado (`GET /monitors`). */
  stats: MonitorStats | null;
}

export interface HeartbeatConfig {
  token: string | null;
  periodSeconds: number | null;
  graceSeconds: number | null;
}

export interface MonitorDetail extends MonitorView {
  method: 'GET' | 'HEAD' | null;
  expectedStatus: number | null;
  keyword: string | null;
  degradedLatencyMs: number | null;
  heartbeat: HeartbeatConfig | null;
  createdAt: string;
  updatedAt: string;
}

export interface CheckRow {
  id: number;
  at: string;
  status: CheckStatus;
  latencyMs: number | null;
  statusCode: number | null;
  error: string | null;
}

export interface UptimeSummary {
  window: UptimeWindowName;
  since: string;
  checks: { total: number; available: number; failed: number };
  availability: number | null;
  latencyMs: { p50: number | null; p95: number | null; p99: number | null };
}

export interface DailyBucket {
  date: string;
  total: number;
  available: number;
  availability: number | null;
  avgLatencyMs: number | null;
  degraded: number;
  down: number;
}

export type IncidentEventKind = 'opened' | 'recovered' | 'notified' | 'comment';

export interface IncidentEvent {
  kind: IncidentEventKind;
  detail: string | null;
  happenedAt: string;
}

/** Incidencia de un monitor con su timeline (GET /monitors/:id/incidents). */
export interface IncidentRecord {
  id: string;
  startedAt: string;
  resolvedAt: string | null;
  durationSeconds: number;
  cause: string | null;
  events: IncidentEvent[];
}

/** Incidencia global resuelta con su monitor (GET /incidents). */
export interface IncidentRow {
  id: string;
  monitorId: string;
  monitorName: string;
  monitorSlug: string;
  workspaceId: string;
  startedAt: string;
  resolvedAt: string | null;
  durationSeconds: number;
  cause: string | null;
  open: boolean;
}

export interface Channel {
  id: string;
  workspaceId: string;
  type: ChannelType;
  name: string;
  config: Record<string, unknown>;
  enabled: boolean;
  createdAt: string;
}

export interface DeliveryRow {
  id: string;
  kind: DeliveryKind;
  status: DeliveryStatus;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  nextAttemptAt: string;
  sentAt: string | null;
  incidentId: string | null;
  channelId: string;
  channelName: string;
  channelType: ChannelType;
  monitorId: string;
  monitorName: string;
  monitorSlug: string;
}

export interface Member {
  userId: string;
  email: string;
  name: string;
  role: Role;
  createdAt?: string;
}

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

export interface AuditEntry {
  id: number;
  userId: string | null;
  workspaceId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  detail: Record<string, unknown> | null;
  ip: string | null;
  createdAt: string;
}

/** Alta de monitor: solo los campos que el formulario envía según el tipo. */
export interface MonitorCreateInput {
  workspaceId: string;
  type: MonitorType;
  name: string;
  slug?: string;
  intervalSeconds: number;
  timeoutMs: number;
  confirmFailures: number;
  confirmRecoveries: number;
  isPublic: boolean;
  paused?: boolean;
  url?: string;
  method?: 'GET' | 'HEAD';
  expectedStatus?: number;
  keyword?: string;
  degradedLatencyMs?: number;
  host?: string;
  port?: number;
  heartbeatPeriodSeconds?: number;
  heartbeatGraceSeconds?: number;
}

/** Edición de monitor: subconjunto permitido por PATCH (todo opcional). */
export interface MonitorPatchInput {
  name?: string;
  slug?: string;
  url?: string;
  method?: 'GET' | 'HEAD';
  expectedStatus?: number;
  keyword?: string | null;
  host?: string;
  port?: number;
  intervalSeconds?: number;
  timeoutMs?: number;
  degradedLatencyMs?: number | null;
  confirmFailures?: number;
  confirmRecoveries?: number;
  heartbeatPeriodSeconds?: number;
  heartbeatGraceSeconds?: number;
  isPublic?: boolean;
  paused?: boolean;
}
