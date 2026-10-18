import type { CheckStatus } from './types.js';

export interface CheckLike {
  status: CheckStatus;
}

/** Un check cuenta como servicio disponible si está arriba o degradado. */
export function isAvailable(status: CheckStatus): boolean {
  return status === 'up' || status === 'degraded';
}

/**
 * Proporción de checks disponibles (0–1).
 * Devuelve `null` sin datos: la ausencia de medidas no es un 0 %, es una incógnita.
 */
export function availability(checks: readonly CheckLike[]): number | null {
  if (checks.length === 0) return null;

  const available = checks.filter((check) => isAvailable(check.status)).length;
  return available / checks.length;
}

/** Percentil (0–100) sobre una lista de números, con interpolación lineal. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  if (p < 0 || p > 100) {
    throw new RangeError(`percentile: p debe estar entre 0 y 100 (recibido ${p})`);
  }

  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0] ?? null;

  const rank = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  const weight = rank - lower;

  const low = sorted[lower] ?? 0;
  const high = sorted[upper] ?? low;
  return low + (high - low) * weight;
}

/** Formatea una disponibilidad 0–1 como porcentaje legible: 0.9998 → `99.98%`. */
export function formatAvailability(value: number | null, digits = 2): string {
  if (value === null) return '—';
  return `${(value * 100).toFixed(digits)}%`;
}
