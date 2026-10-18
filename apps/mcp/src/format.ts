import type { MonitorState, MonitorView } from './types.js';

/**
 * Formato en español y determinista (fechas en UTC) para que un asistente lea
 * los datos sin sorpresas de zona horaria o idioma de la máquina.
 */

const SIN_DATOS = '—';

/** Proporción 0–1 → «99,9 %» (o «—» sin datos). */
export function formatearRatio(ratio: number | null): string {
  if (ratio === null) return SIN_DATOS;
  const porcentaje = ratio * 100;
  return `${porcentaje.toLocaleString('es-ES', { maximumFractionDigits: 1 })} %`;
}

/** Segundos → «45 s», «12 min», «3 h 20 min», «2 d 4 h». */
export function formatearDuracion(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))} s`;

  const minutos = Math.floor(seconds / 60);
  if (minutos < 60) return `${minutos} min`;

  const horas = Math.floor(minutos / 60);
  const restoMinutos = minutos % 60;
  if (horas < 24) return restoMinutos === 0 ? `${horas} h` : `${horas} h ${restoMinutos} min`;

  const dias = Math.floor(horas / 24);
  const restoHoras = horas % 24;
  return restoHoras === 0 ? `${dias} d` : `${dias} d ${restoHoras} h`;
}

/** ISO → «18 oct 2026, 17:05» (UTC). */
export function formatearFechaHora(iso: string): string {
  return new Date(iso).toLocaleString('es-ES', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  });
}

/** ISO → «hace 3 min» respecto a `now` (inyectable en pruebas). */
export function formatearHace(iso: string | null, now: number = Date.now()): string {
  if (iso === null) return SIN_DATOS;
  const segundos = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  return `hace ${formatearDuracion(segundos)}`;
}

const EMOJI_ESTADO: Record<MonitorState, string> = {
  up: '🟢',
  degraded: '🟡',
  down: '🔴',
  pending: '⚪',
};

/** Semáforo del monitor: pausado gana a cualquier estado. */
export function emojiEstado(monitor: Pick<MonitorView, 'paused' | 'state'>): string {
  return monitor.paused ? '⏸️' : EMOJI_ESTADO[monitor.state];
}

/** Etiqueta humana del estado («sin respuesta», «todo en orden»…). */
export function etiquetaEstado(monitor: Pick<MonitorView, 'paused' | 'state'>): string {
  if (monitor.paused) return 'en pausa';
  return { up: 'up', degraded: 'degraded', down: 'down', pending: 'sin datos' }[monitor.state];
}
