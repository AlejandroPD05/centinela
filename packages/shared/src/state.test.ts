import { describe, expect, it } from 'vitest';
import { nextMonitorState, type StateSnapshot } from './state.js';

const PENDING: StateSnapshot = {
  state: 'pending',
  consecutiveFailures: 0,
  consecutiveSuccesses: 0,
};
const UP: StateSnapshot = { state: 'up', consecutiveFailures: 0, consecutiveSuccesses: 3 };
const DOWN: StateSnapshot = { state: 'down', consecutiveFailures: 2, consecutiveSuccesses: 0 };
const DEGRADED: StateSnapshot = {
  state: 'degraded',
  consecutiveFailures: 0,
  consecutiveSuccesses: 1,
};

const thresholds = (confirmFailures = 2, confirmRecoveries = 1) => ({
  confirmFailures,
  confirmRecoveries,
});

describe('nextMonitorState — confirmación de caídas', () => {
  it('un monitor nuevo no se declara caído hasta confirmar los fallos', () => {
    const first = nextMonitorState(PENDING, thresholds(), 'down');

    expect(first).toEqual({
      state: 'pending',
      consecutiveFailures: 1,
      consecutiveSuccesses: 0,
      changed: false,
    });

    const second = nextMonitorState(first, thresholds(), 'down');

    expect(second).toEqual({
      state: 'down',
      consecutiveFailures: 2,
      consecutiveSuccesses: 0,
      changed: true,
    });
  });

  it('con confirmFailures=1 la caída se confirma al primer fallo', () => {
    const transition = nextMonitorState(UP, thresholds(1, 2), 'error');

    expect(transition.state).toBe('down');
    expect(transition.changed).toBe(true);
  });

  it('un éxito entre fallos reinicia el contador de fallos', () => {
    const afterFailure = nextMonitorState(UP, thresholds(), 'down');
    const afterSuccess = nextMonitorState(afterFailure, thresholds(), 'up');

    expect(afterSuccess.consecutiveFailures).toBe(0);
    expect(afterFailure.consecutiveFailures).toBe(1);
  });
});

describe('nextMonitorState — confirmación de recuperaciones', () => {
  it('no sale de caída hasta alcanzar confirmRecoveries', () => {
    const first = nextMonitorState(DOWN, thresholds(2, 2), 'up');

    expect(first.state).toBe('down');
    expect(first.consecutiveSuccesses).toBe(1);
    expect(first.consecutiveFailures).toBe(0);
    expect(first.changed).toBe(false);

    const second = nextMonitorState(first, thresholds(2, 2), 'up');

    expect(second.state).toBe('up');
    expect(second.consecutiveSuccesses).toBe(2);
    expect(second.changed).toBe(true);
  });

  it('recupera directamente a degraded si el servicio responde lento', () => {
    const transition = nextMonitorState(DOWN, thresholds(2, 1), 'degraded');

    expect(transition.state).toBe('degraded');
    expect(transition.changed).toBe(true);
  });

  it('el primer check bueno de un monitor nuevo lo deja arriba', () => {
    const transition = nextMonitorState(PENDING, thresholds(), 'up');

    expect(transition.state).toBe('up');
    expect(transition.changed).toBe(true);
  });
});

describe('nextMonitorState — degradado', () => {
  it('un servicio arriba que empieza a ir lento pasa a degraded al confirmarse', () => {
    const transition = nextMonitorState(UP, thresholds(), 'degraded');

    expect(transition.state).toBe('degraded');
    expect(transition.changed).toBe(true);
  });

  it('un servicio degradado que sigue lento no cambia de estado', () => {
    const transition = nextMonitorState(DEGRADED, thresholds(), 'degraded');

    expect(transition.state).toBe('degraded');
    expect(transition.changed).toBe(false);
  });

  it('un servicio degradado que vuelve a ir fino recupera up', () => {
    const transition = nextMonitorState(DEGRADED, thresholds(), 'up');

    expect(transition.state).toBe('up');
    expect(transition.changed).toBe(true);
  });
});
