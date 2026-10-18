import { formatDay, formatPercent } from '../lib/format';
import { bucketTone, TONE_LAMP, type Tone } from '../lib/tone';
import type { DailyBucket } from '../lib/types';

/** Lámpara de estado: cuadrado fijo (arriba), parpadeo lento (degradado). */
export function Lampara({ tono, viva = false }: { tono: Tone; viva?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`lamp inline-block shrink-0 ${TONE_LAMP[tono]} ${viva ? 'lamp--live' : ''}`}
    />
  );
}

/**
 * Cinta de disponibilidad: un día por celda, mismo corte de tono que la
 * status page (día con caída = rojo; con degradados = ámbar; sin datos = gris).
 */
export function Cinta({
  buckets,
  alto = 'h-6',
  descripcion,
}: {
  buckets: DailyBucket[];
  alto?: string;
  descripcion?: string;
}) {
  const conDatos = buckets.filter((bucket) => bucket.total > 0).length;
  const conAviso = buckets.filter((bucket) => {
    const tono = bucketTone(bucket);
    return tono === 'down' || tono === 'warn';
  }).length;

  return (
    <div
      role="img"
      aria-label={
        descripcion ??
        `Cinta de ${buckets.length} días: ${conDatos} con datos, ${conAviso} con incidencias.`
      }
      className={`flex gap-px ${alto}`}
    >
      {buckets.map((bucket) => {
        const detalle =
          bucket.total === 0
            ? 'sin datos'
            : `${formatPercent(bucket.availability)} · ${bucket.total} checks`;
        return (
          <i
            key={bucket.date}
            className={`min-w-[2px] flex-1 ${TONE_LAMP[bucketTone(bucket)]}`}
            title={`${formatDay(bucket.date)} · ${detalle}`}
          />
        );
      })}
    </div>
  );
}

/** Serie diaria de latencia media como línea con área, dibujada a mano. */
export function GraficaLatencia({
  buckets,
  alto = 160,
}: {
  buckets: DailyBucket[];
  alto?: number;
}) {
  const puntos = buckets.flatMap((bucket, index) =>
    bucket.avgLatencyMs === null ? [] : [{ index, value: bucket.avgLatencyMs, date: bucket.date }],
  );

  if (puntos.length < 2) {
    return (
      <p className="py-2 font-data text-[13px] text-ink-dim">Sin latencias medidas todavía.</p>
    );
  }

  const maximo = Math.max(...puntos.map((punto) => punto.value));
  const techo = Math.max(10, Math.ceil(maximo / 10) * 10);
  const W = 1000;
  const H = alto;
  const margen = 8;

  const x = (index: number) =>
    margen + (index / Math.max(1, buckets.length - 1)) * (W - margen * 2);
  const y = (value: number) => H - margen - (value / techo) * (H - margen * 2);

  const primero = puntos[0]!;
  const ultimo = puntos[puntos.length - 1]!;
  const trazo = puntos
    .map(
      (punto, i) =>
        `${i === 0 ? 'M' : 'L'}${x(punto.index).toFixed(1)} ${y(punto.value).toFixed(1)}`,
    )
    .join(' ');
  const area = `${trazo} L${x(ultimo.index).toFixed(1)} ${H - margen} L${x(primero.index).toFixed(1)} ${H - margen} Z`;

  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full text-ink-dim"
        role="img"
        aria-label={`Latencia media diaria de los últimos ${buckets.length} días; máximo ${Math.round(maximo)} ms.`}
      >
        <line
          x1={margen}
          y1={H - margen}
          x2={W - margen}
          y2={H - margen}
          stroke="currentColor"
          strokeOpacity="0.35"
        />
        <path d={area} fill="currentColor" fillOpacity="0.08" />
        <path d={trazo} fill="none" stroke="currentColor" strokeWidth="1.5" />
      </svg>
      <div className="mt-1 flex justify-between font-data text-[12px] text-ink-dim">
        <span>{formatDay(primero.date)}</span>
        <span>máx {Math.round(maximo)} ms</span>
        <span>{formatDay(ultimo.date)}</span>
      </div>
    </div>
  );
}
