import { describe, expect, it } from 'vitest';
import {
  availability,
  formatAvailability,
  isAvailable,
  percentile,
  uptimeWindowHours,
} from './uptime.js';

describe('uptimeWindowHours', () => {
  it('traduce cada ventana a sus horas', () => {
    expect(uptimeWindowHours('24h')).toBe(24);
    expect(uptimeWindowHours('7d')).toBe(168);
    expect(uptimeWindowHours('30d')).toBe(720);
    expect(uptimeWindowHours('90d')).toBe(2160);
  });
});

describe('isAvailable', () => {
  it('considera disponibles los servicios arriba y degradados', () => {
    expect(isAvailable('up')).toBe(true);
    expect(isAvailable('degraded')).toBe(true);
  });

  it('no considera disponibles los servicios caídos ni los errores de check', () => {
    expect(isAvailable('down')).toBe(false);
    expect(isAvailable('error')).toBe(false);
  });
});

describe('availability', () => {
  it('devuelve null sin datos: la ausencia de medidas no es un 0 %', () => {
    expect(availability([])).toBeNull();
  });

  it('calcula la proporción de checks disponibles', () => {
    const checks = [
      { status: 'up' },
      { status: 'up' },
      { status: 'degraded' },
      { status: 'down' },
    ] as const;

    expect(availability(checks)).toBeCloseTo(0.75);
  });

  it('devuelve 1 cuando todo está disponible', () => {
    const checks = [{ status: 'up' }, { status: 'degraded' }] as const;

    expect(availability(checks)).toBe(1);
  });
});

describe('percentile', () => {
  it('devuelve null sin valores', () => {
    expect(percentile([], 50)).toBeNull();
  });

  it('interpola linealmente entre los puntos', () => {
    expect(percentile([100, 200, 300, 400], 50)).toBeCloseTo(250);
    expect(percentile([100, 200, 300, 400], 95)).toBeCloseTo(385);
    expect(percentile([100, 200, 300, 400], 0)).toBeCloseTo(100);
    expect(percentile([100, 200, 300, 400], 100)).toBeCloseTo(400);
  });

  it('con un único valor devuelve ese valor', () => {
    expect(percentile([42], 95)).toBeCloseTo(42);
  });

  it('rechaza percentiles fuera de rango', () => {
    expect(() => percentile([1, 2], 101)).toThrow(RangeError);
    expect(() => percentile([1, 2], -1)).toThrow(RangeError);
  });
});

describe('formatAvailability', () => {
  it('formatea con dos decimales por defecto', () => {
    expect(formatAvailability(0.9998)).toBe('99.98%');
    expect(formatAvailability(1)).toBe('100.00%');
  });

  it('usa una raya cuando no hay datos', () => {
    expect(formatAvailability(null)).toBe('—');
  });
});
