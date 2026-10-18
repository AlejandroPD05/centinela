import type { CheckStatus, MonitorState, MonitorView } from './types';

// Semáforo de la consola: el mismo criterio de color que la status page.
// `down` en texto usa el rojo legible (AA); la lámpara, el rojo de señal.
export type Tone = 'up' | 'warn' | 'down' | 'off';

export const TONE_LAMP: Record<Tone, string> = {
  up: 'bg-lamp-up',
  warn: 'bg-lamp-warn',
  down: 'bg-lamp-down',
  off: 'bg-ink-dim',
};

export const TONE_TEXT: Record<Tone, string> = {
  up: 'text-lamp-up',
  warn: 'text-lamp-warn',
  down: 'text-hazard-ink',
  off: 'text-ink-dim',
};

export const STATE_LABEL: Record<MonitorState, string> = {
  pending: 'ESPERANDO',
  up: 'OPERATIVA',
  degraded: 'DEGRADADA',
  down: 'SIN RESPUESTA',
};

export function monitorTone(monitor: { state: MonitorState; paused: boolean }): Tone {
  if (monitor.paused) return 'off';

  switch (monitor.state) {
    case 'up':
      return 'up';
    case 'degraded':
      return 'warn';
    case 'down':
      return 'down';
    default:
      return 'off';
  }
}

export function monitorLabel(monitor: { state: MonitorState; paused: boolean }): string {
  return monitor.paused ? 'EN PAUSA' : STATE_LABEL[monitor.state];
}

export function checkTone(status: CheckStatus): Tone {
  switch (status) {
    case 'up':
      return 'up';
    case 'degraded':
      return 'warn';
    default:
      return 'down';
  }
}

/** Objetivo vigilado en una línea: URL, host:puerto o «latido entrante». */
export function monitorTarget(
  monitor: Pick<MonitorView, 'type' | 'url' | 'host' | 'port'>,
): string {
  if (monitor.type === 'http') return monitor.url ?? '';
  if (monitor.type === 'tcp') {
    if (monitor.host === null) return '';
    return monitor.port === null ? monitor.host : `${monitor.host}:${monitor.port}`;
  }

  return 'latido entrante';
}

/** Tono de una celda de la cinta: el mismo corte que usa la status page. */
export function bucketTone(bucket: { total: number; degraded: number; down: number }): Tone {
  if (bucket.total === 0) return 'off';
  if (bucket.down > 0) return 'down';
  if (bucket.degraded > 0) return 'warn';
  return 'up';
}
