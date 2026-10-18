import type { CheckStatus, MonitorState } from './types.js';

export interface StateSnapshot {
  state: MonitorState;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
}

export interface StateThresholds {
  /** Fallos consecutivos necesarios para confirmar una caída. */
  confirmFailures: number;
  /** Éxitos consecutivos necesarios para confirmar la recuperación. */
  confirmRecoveries: number;
}

export interface StateTransition extends StateSnapshot {
  /** `true` si el estado agregado ha cambiado con este check. */
  changed: boolean;
}

/**
 * Máquina de estados de un monitor.
 *
 * Un check disponible (`up` o `degraded`) cuenta como éxito; `down` o `error`
 * cuentan como fallo. El estado solo cambia al alcanzar los umbrales de
 * confirmación, para no abrir incidencias por un hipo de un segundo.
 */
export function nextMonitorState(
  snapshot: StateSnapshot,
  thresholds: StateThresholds,
  check: CheckStatus,
): StateTransition {
  if (check === 'down' || check === 'error') {
    return applyFailure(snapshot, thresholds);
  }

  return applySuccess(snapshot, thresholds, check);
}

function applyFailure(snapshot: StateSnapshot, thresholds: StateThresholds): StateTransition {
  const consecutiveFailures = snapshot.consecutiveFailures + 1;
  const confirmed = consecutiveFailures >= Math.max(1, thresholds.confirmFailures);
  const state: MonitorState = confirmed ? 'down' : snapshot.state;

  return {
    state,
    consecutiveFailures,
    consecutiveSuccesses: 0,
    changed: state !== snapshot.state,
  };
}

function applySuccess(
  snapshot: StateSnapshot,
  thresholds: StateThresholds,
  observed: 'up' | 'degraded',
): StateTransition {
  const consecutiveSuccesses = snapshot.consecutiveSuccesses + 1;
  const confirmed = consecutiveSuccesses >= Math.max(1, thresholds.confirmRecoveries);
  const state: MonitorState = confirmed ? observed : snapshot.state;

  return {
    state,
    consecutiveFailures: 0,
    consecutiveSuccesses,
    changed: state !== snapshot.state,
  };
}
