/** Formato en español de la consola: fechas, tiempos relativos y cifras. */

const dateTimeFormat = new Intl.DateTimeFormat('es-ES', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

const shortDateTimeFormat = new Intl.DateTimeFormat('es-ES', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

const dayFormat = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short' });

export function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  return dateTimeFormat.format(new Date(iso));
}

export function formatShortDateTime(iso: string | null): string {
  if (!iso) return '—';
  return shortDateTimeFormat.format(new Date(iso));
}

export function formatDay(iso: string): string {
  return dayFormat.format(new Date(iso));
}

/** «hace 12 s», «hace 3 min», «hace 2 h 10 min», «hace 4 d». */
export function formatAgo(iso: string | null, now: number = Date.now()): string {
  if (!iso) return 'nunca';

  const seconds = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000));
  if (seconds < 10) return 'ahora mismo';
  if (seconds < 60) return `hace ${seconds} s`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `hace ${minutes} min`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest === 0 ? `hace ${hours} h` : `hace ${hours} h ${rest} min`;
  }

  return `hace ${Math.floor(hours / 24)} d`;
}

/** «en 3 min» para fechas futuras; si ya pasaron, cae en `formatAgo`. */
export function formatUntil(iso: string | null, now: number = Date.now()): string {
  if (!iso) return '—';

  const diff = new Date(iso).getTime() - now;
  if (diff <= 0) return formatAgo(iso, now);

  const seconds = Math.ceil(diff / 1000);
  if (seconds < 60) return `en ${seconds} s`;

  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `en ${minutes} min`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest === 0 ? `en ${hours} h` : `en ${hours} h ${rest} min`;
  }

  return `en ${Math.floor(hours / 24)} d`;
}

export function formatLatency(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2).replace('.', ',')} s`;
}

/** Proporción 0–1 como porcentaje español (`99,98 %`), `—` sin datos. */
export function formatPercent(ratio: number | null): string {
  if (ratio === null) return '—';

  const pct = ratio * 100;
  if (pct >= 99.995) return '100 %';
  if (pct <= 0.005) return '<0,01 %';
  return `${pct.toFixed(2).replace('.', ',')} %`;
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat('es-ES').format(value);
}

/** Identificadores largos en tablas: `8f14e45f…`. */
export function shortId(id: string): string {
  return `${id.slice(0, 8)}…`;
}
