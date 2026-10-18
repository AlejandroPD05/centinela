import type { MonitorState } from '@centinela/shared';

/**
 * Tono visual de una lámpara de la status page.
 * `off` es el gris apagado: sin datos, pausado o esperando el primer check.
 */
export type LampTone = 'up' | 'warn' | 'down' | 'off';

/** Tono de la lámpara de un monitor según su estado. */
export function monitorTone(state: MonitorState, paused: boolean): LampTone {
  if (paused) return 'off';

  switch (state) {
    case 'up':
      return 'up';
    case 'degraded':
      return 'warn';
    case 'down':
      return 'down';
    case 'pending':
      return 'off';
  }
}

/** Palabra de estado que acompaña a la lámpara. */
export function monitorLabel(state: MonitorState, paused: boolean): string {
  if (paused) return 'pausado';

  switch (state) {
    case 'up':
      return 'responde';
    case 'degraded':
      return 'degradado';
    case 'down':
      return 'sin respuesta';
    case 'pending':
      return 'sin datos';
  }
}

/** Valor de `data-state` para el HTML (el pausado se marca aparte del enum). */
export function monitorDataState(state: MonitorState, paused: boolean): string {
  return paused ? 'paused' : state;
}
