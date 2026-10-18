import type { NotificationPayload } from '@centinela/shared';
import type { MonitorRow } from '../checks/run.js';
import type { incidents } from '../db/schema.js';

type IncidentRow = typeof incidents.$inferSelect;

/** Objetivo legible del monitor para los mensajes. */
export function monitorTarget(monitor: MonitorRow): string {
  switch (monitor.type) {
    case 'http':
      return monitor.url ?? 'URL sin configurar';
    case 'tcp':
      return `${monitor.host ?? '?'}:${monitor.port ?? '?'}`;
    case 'heartbeat':
      return `latido cada ${monitor.heartbeatPeriodSeconds ?? monitor.intervalSeconds} s`;
  }
}

function monitorView(monitor: MonitorRow): NotificationPayload['monitor'] {
  return {
    id: monitor.id,
    name: monitor.name,
    slug: monitor.slug,
    type: monitor.type,
    target: monitorTarget(monitor),
  };
}

/** Instantánea del evento de caída o recuperación para la cola de avisos. */
export function buildIncidentPayload(
  monitor: MonitorRow,
  incident: IncidentRow,
  kind: 'down' | 'recovered',
  at: Date,
): NotificationPayload {
  return {
    kind,
    at: at.toISOString(),
    monitor: monitorView(monitor),
    incident: {
      id: incident.id,
      startedAt: incident.startedAt.toISOString(),
      cause: incident.cause,
      durationSeconds:
        kind === 'recovered' && incident.resolvedAt
          ? Math.max(
              0,
              Math.floor((incident.resolvedAt.getTime() - incident.startedAt.getTime()) / 1000),
            )
          : null,
    },
    ssl: null,
  };
}

/** Instantánea del aviso por caducidad del certificado. */
export function buildSslPayload(
  monitor: MonitorRow,
  ssl: { expiresAt: Date; issuer: string | null },
  daysLeft: number,
  at: Date,
): NotificationPayload {
  return {
    kind: 'ssl',
    at: at.toISOString(),
    monitor: monitorView(monitor),
    incident: null,
    ssl: {
      expiresAt: ssl.expiresAt.toISOString(),
      issuer: ssl.issuer,
      daysLeft,
    },
  };
}
