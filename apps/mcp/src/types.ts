/** Formas de la API de Centinela que consume el servidor MCP (solo lectura). */

export interface WorkspaceSummary {
  id: string;
  name: string;
  slug: string;
  role: 'admin' | 'editor' | 'viewer';
}

export interface UptimeWindowStat {
  total: number;
  available: number;
  ratio: number | null;
}

export type MonitorState = 'up' | 'degraded' | 'down' | 'pending';

export interface MonitorSsl {
  expiresAt: string | null;
  checkedAt: string | null;
  issuer: string | null;
  error: string | null;
}

export interface MonitorView {
  id: string;
  workspaceId: string;
  name: string;
  slug: string;
  type: 'http' | 'tcp' | 'heartbeat';
  url: string | null;
  host: string | null;
  port: number | null;
  state: MonitorState;
  isPublic: boolean;
  paused: boolean;
  intervalSeconds: number;
  timeoutMs: number;
  lastCheckAt: string | null;
  nextCheckAt: string;
  ssl: MonitorSsl | null;
  stats: { day: UptimeWindowStat; week: UptimeWindowStat; openIncidents: number } | null;
}

export interface IncidentSummary {
  id: string;
  monitorId: string;
  monitorName: string;
  monitorSlug: string;
  workspaceId: string;
  startedAt: string;
  resolvedAt: string | null;
  durationSeconds: number;
  cause: string;
  open: boolean;
}

export interface UptimeSummary {
  window: string;
  since: string;
  checks: { total: number; available: number; failed: number };
  availability: number | null;
  latencyMs: { p50: number | null; p95: number | null; p99: number | null };
}
