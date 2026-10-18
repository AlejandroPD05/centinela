import { formatDuration, uptimeWindows } from '@centinela/shared';
import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ConfirmBoton } from '../components/confirmar';
import { BotonCopiar } from '../components/copiar';
import { Cinta, GraficaLatencia, Lampara } from '../components/devices';
import {
  Aviso,
  Cabecera,
  Cargando,
  ErrorPanel,
  Seccion,
  TD_CLASS,
  TH_CLASS,
  Vacio,
  claseBoton,
} from '../components/ui';
import { useAuth } from '../lib/auth';
import {
  formatAgo,
  formatDateTime,
  formatLatency,
  formatNumber,
  formatPercent,
  formatShortDateTime,
  formatUntil,
} from '../lib/format';
import {
  useCheckNow,
  useChecks,
  useDeleteMonitor,
  useHistory,
  useMonitor,
  useMonitorIncidents,
  useUpdateMonitor,
  useUptime,
} from '../lib/queries';
import {
  checkTone,
  monitorLabel,
  monitorTarget,
  monitorTone,
  TONE_TEXT,
  type Tone,
} from '../lib/tone';
import type { CheckStatus, MonitorDetail, UptimeWindowName } from '../lib/types';
import { useNow } from '../lib/useNow';

const ETIQUETA_VENTANA: Record<UptimeWindowName, string> = {
  '24h': '24 horas',
  '7d': '7 días',
  '30d': '30 días',
  '90d': '90 días',
};

const ETIQUETA_CHECK: Record<CheckStatus, string> = {
  up: 'OK',
  degraded: 'DEGRADADO',
  down: 'CAÍDO',
  error: 'ERROR',
};

const ETIQUETA_EVENTO: Record<string, string> = {
  opened: 'caída confirmada',
  recovered: 'recuperación',
  notified: 'aviso enviado',
  comment: 'nota',
};

function BloqueVentana({ monitorId, ventana }: { monitorId: string; ventana: UptimeWindowName }) {
  const resumen = useUptime(monitorId, ventana);
  const datos = resumen.data;

  return (
    <div className="border border-line p-3">
      <p className="font-data text-[12px] tracking-[0.12em] text-ink-dim uppercase">
        {ETIQUETA_VENTANA[ventana]}
      </p>
      <p className="mt-1 font-display text-[24px] leading-none">
        {datos ? formatPercent(datos.availability) : '—'}
      </p>
      <dl className="mt-2 space-y-0.5 font-data text-[12px] text-ink-dim">
        <div className="flex justify-between">
          <dt>checks</dt>
          <dd>{datos ? formatNumber(datos.checks.total) : '—'}</dd>
        </div>
        <div className="flex justify-between">
          <dt>fallos</dt>
          <dd>{datos ? formatNumber(datos.checks.failed) : '—'}</dd>
        </div>
        <div className="flex justify-between">
          <dt>p50</dt>
          <dd>{formatLatency(datos?.latencyMs.p50 ?? null)}</dd>
        </div>
        <div className="flex justify-between">
          <dt>p95</dt>
          <dd>{formatLatency(datos?.latencyMs.p95 ?? null)}</dd>
        </div>
        <div className="flex justify-between">
          <dt>p99</dt>
          <dd>{formatLatency(datos?.latencyMs.p99 ?? null)}</dd>
        </div>
      </dl>
    </div>
  );
}

function Leyenda({ tono, children }: { tono: Tone; children: ReactNode }) {
  return (
    <span className="flex items-center gap-1.5">
      <Lampara tono={tono} />
      {children}
    </span>
  );
}

function Certificado({ monitor }: { monitor: MonitorDetail }) {
  const ssl = monitor.ssl;
  if (ssl === null) return null;

  const dias =
    ssl.expiresAt === null
      ? null
      : Math.floor((new Date(ssl.expiresAt).getTime() - Date.now()) / 86_400_000);
  const tono =
    ssl.error !== null
      ? 'text-hazard-ink'
      : dias === null
        ? ''
        : dias <= 7
          ? 'text-hazard-ink'
          : dias <= 30
            ? 'text-lamp-warn'
            : '';

  return (
    <Seccion titulo="Certificado TLS">
      {ssl.error !== null ? <Aviso tono="error">{ssl.error}</Aviso> : null}
      <dl className="grid gap-x-8 font-data text-[13px] sm:grid-cols-2">
        <div className="flex justify-between border-b border-line py-1">
          <dt className="text-ink-dim">caduca</dt>
          <dd>{formatDateTime(ssl.expiresAt)}</dd>
        </div>
        <div className="flex justify-between border-b border-line py-1">
          <dt className="text-ink-dim">quedan</dt>
          <dd className={tono}>{dias === null ? '—' : `${dias} días`}</dd>
        </div>
        <div className="flex justify-between border-b border-line py-1">
          <dt className="text-ink-dim">emisor</dt>
          <dd>{ssl.issuer ?? '—'}</dd>
        </div>
        <div className="flex justify-between border-b border-line py-1">
          <dt className="text-ink-dim">revisado</dt>
          <dd>{formatShortDateTime(ssl.checkedAt)}</dd>
        </div>
      </dl>
    </Seccion>
  );
}

function Latido({ monitor }: { monitor: MonitorDetail }) {
  const heartbeat = monitor.heartbeat;
  if (heartbeat === null || heartbeat.token === null) return null;

  const url = `${window.location.origin}/api/heartbeats/${heartbeat.token}`;

  return (
    <Seccion titulo="Latido de entrada">
      <p className="font-data text-[13px] text-ink-dim">
        La tarea debe avisar al menos cada {formatDuration(heartbeat.periodSeconds ?? 0)} (con{' '}
        {heartbeat.graceSeconds ?? 0} s de gracia). Si calla, la incidencia se abre sola.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <code className="border border-line px-2 py-1 font-data text-[12px] break-all">{url}</code>
        <BotonCopiar texto={url} />
      </div>
      <p className="mt-2 font-data text-[12px] text-hazard-ink">
        Esta URL es secreta: quien la tenga puede reportar latidos en tu nombre.
      </p>
      <pre className="mt-3 overflow-x-auto border border-line p-3 font-data text-[12px] text-ink-dim">{`curl -fsS -X POST ${url}`}</pre>
    </Seccion>
  );
}

function Publicacion({ monitor }: { monitor: MonitorDetail }) {
  const { workspace } = useAuth();
  if (workspace === null) return null;

  const base = window.location.origin;
  const filas: Array<[string, string]> = [
    ['Status page', `${base}/status/${workspace.slug}`],
    ['Distintivo SVG', `${base}/badge/${workspace.slug}/${monitor.slug}.svg`],
    ['Widget embebible', `${base}/embed/${workspace.slug}`],
  ];

  return (
    <Seccion titulo="Publicación">
      {!monitor.isPublic ? (
        <Aviso tono="aviso" className="mb-3">
          Este monitor no aparece en la status page;{' '}
          <Link to={`/monitores/${monitor.id}/editar`} className="underline underline-offset-2">
            márcalo como público
          </Link>{' '}
          para publicarlo.
        </Aviso>
      ) : null}
      <div className="space-y-2">
        {filas.map(([etiqueta, valor]) => (
          <div key={etiqueta} className="flex flex-wrap items-center gap-2">
            <span className="w-36 font-data text-[12px] tracking-[0.08em] text-ink-dim uppercase">
              {etiqueta}
            </span>
            <code className="border border-line px-2 py-1 font-data text-[12px] break-all">
              {valor}
            </code>
            <BotonCopiar texto={valor} />
          </div>
        ))}
        {monitor.isPublic ? (
          <img
            src={`/badge/${workspace.slug}/${monitor.slug}.svg`}
            alt="Distintivo de estado del monitor"
            className="mt-2 h-5"
          />
        ) : null}
      </div>
    </Seccion>
  );
}

export function MonitorDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const now = useNow(1_000);

  const monitor = useMonitor(id);
  const historial = useHistory(id, 90);
  const checks = useChecks(id, 30);
  const incidencias = useMonitorIncidents(id, 20);
  const actualizar = useUpdateMonitor(id ?? '');
  const borrar = useDeleteMonitor();
  const comprobar = useCheckNow();

  const [aviso, setAviso] = useState<{ tono: 'ok' | 'error'; texto: string } | null>(null);

  if (monitor.isPending) return <Cargando>Cargando el monitor…</Cargando>;
  if (monitor.isError) return <ErrorPanel error={monitor.error} />;
  if (!monitor.data) return null;

  const m = monitor.data;
  const tono = monitorTone(m);

  return (
    <>
      <Cabecera
        titulo={m.name}
        acciones={
          <>
            {m.type !== 'heartbeat' ? (
              <button
                type="button"
                className={claseBoton('normal')}
                disabled={comprobar.isPending || m.paused}
                onClick={() =>
                  comprobar.mutate(m.id, {
                    onSuccess: (resultado) => setAviso({ tono: 'ok', texto: resultado.message }),
                    onError: (error) => setAviso({ tono: 'error', texto: error.message }),
                  })
                }
              >
                Comprobar ahora
              </button>
            ) : null}
            <button
              type="button"
              className={claseBoton('normal')}
              disabled={actualizar.isPending}
              onClick={() =>
                actualizar.mutate(
                  { paused: !m.paused },
                  {
                    onSuccess: () =>
                      setAviso({
                        tono: 'ok',
                        texto: m.paused ? 'Monitor reanudado.' : 'Monitor en pausa.',
                      }),
                    onError: (error) => setAviso({ tono: 'error', texto: error.message }),
                  },
                )
              }
            >
              {m.paused ? 'Reanudar' : 'Pausar'}
            </button>
            <Link to={`/monitores/${m.id}/editar`} className={claseBoton('normal')}>
              Editar
            </Link>
            <ConfirmBoton
              etiqueta="Eliminar"
              pregunta="Confirmar borrado"
              pendiente={borrar.isPending}
              onConfirm={() =>
                borrar.mutate(m.id, {
                  onSuccess: () => void navigate('/', { replace: true }),
                  onError: (error) => setAviso({ tono: 'error', texto: error.message }),
                })
              }
            />
          </>
        }
      >
        <p className="flex flex-wrap items-center gap-x-4 gap-y-1 font-data text-[13px]">
          <span className="flex items-center gap-2">
            <Lampara tono={tono} viva={tono === 'warn'} />
            <span className={`${TONE_TEXT[tono]} text-[12px] tracking-[0.08em] uppercase`}>
              {monitorLabel(m)}
            </span>
          </span>
          <span className="text-ink-dim">{m.type.toUpperCase()}</span>
          <span className="text-ink-dim">{monitorTarget(m)}</span>
        </p>
        <p className="mt-1 font-data text-[12px] text-ink-dim">
          último check {formatAgo(m.lastCheckAt, now)} · siguiente {formatUntil(m.nextCheckAt, now)}{' '}
          · cada {formatDuration(m.intervalSeconds)}
        </p>
      </Cabecera>

      {aviso ? (
        <Aviso tono={aviso.tono} className="mb-4">
          {aviso.texto}
        </Aviso>
      ) : null}

      <Seccion titulo="Disponibilidad">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {uptimeWindows.map((ventana) => (
            <BloqueVentana key={ventana} monitorId={m.id} ventana={ventana} />
          ))}
        </div>
      </Seccion>

      <Seccion titulo="Cinta de 90 días">
        {historial.isPending ? <Cargando /> : null}
        {historial.isError ? <ErrorPanel error={historial.error} /> : null}
        {historial.data ? (
          <>
            <Cinta buckets={historial.data} />
            <p className="mt-2 flex flex-wrap gap-x-5 gap-y-1 font-data text-[12px] text-ink-dim">
              <Leyenda tono="up">día limpio</Leyenda>
              <Leyenda tono="warn">con degradados</Leyenda>
              <Leyenda tono="down">con caídas</Leyenda>
              <Leyenda tono="off">sin datos</Leyenda>
            </p>
            <div className="mt-4">
              <GraficaLatencia buckets={historial.data} />
            </div>
          </>
        ) : null}
      </Seccion>

      <Seccion titulo={`Últimos checks${checks.data ? ` (${checks.data.length})` : ''}`}>
        {checks.isPending ? <Cargando /> : null}
        {checks.isError ? <ErrorPanel error={checks.error} /> : null}
        {checks.data && checks.data.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th scope="col" className={TH_CLASS}>
                    Cuándo
                  </th>
                  <th scope="col" className={TH_CLASS}>
                    Estado
                  </th>
                  <th scope="col" className={TH_CLASS}>
                    Código
                  </th>
                  <th scope="col" className={TH_CLASS}>
                    Latencia
                  </th>
                  <th scope="col" className={TH_CLASS}>
                    Detalle
                  </th>
                </tr>
              </thead>
              <tbody>
                {checks.data.map((check) => {
                  const tonoCheck = checkTone(check.status);
                  return (
                    <tr key={check.id}>
                      <td className={TD_CLASS}>
                        {formatShortDateTime(check.at)}
                        <span className="block text-[12px] text-ink-dim">
                          {formatAgo(check.at, now)}
                        </span>
                      </td>
                      <td
                        className={`${TD_CLASS} ${TONE_TEXT[tonoCheck]} text-[12px] tracking-[0.08em] uppercase`}
                      >
                        {ETIQUETA_CHECK[check.status]}
                      </td>
                      <td className={`${TD_CLASS} text-ink-dim`}>{check.statusCode ?? '—'}</td>
                      <td className={`${TD_CLASS} text-ink-dim`}>
                        {formatLatency(check.latencyMs)}
                      </td>
                      <td
                        className={`${TD_CLASS} max-w-[320px] text-ink-dim`}
                        title={check.error ?? undefined}
                      >
                        {check.error ?? '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
        {checks.data && checks.data.length === 0 ? (
          <Vacio>Sin comprobaciones registradas todavía.</Vacio>
        ) : null}
      </Seccion>

      <Seccion titulo={`Incidencias${incidencias.data ? ` (${incidencias.data.length})` : ''}`}>
        {incidencias.isPending ? <Cargando /> : null}
        {incidencias.isError ? <ErrorPanel error={incidencias.error} /> : null}
        {incidencias.data && incidencias.data.length > 0 ? (
          <ul className="space-y-5">
            {incidencias.data.map((incidencia) => (
              <li key={incidencia.id} className="border-l-2 border-line pl-4">
                <p className="font-data text-[13px]">
                  <span
                    className={incidencia.resolvedAt === null ? 'text-hazard-ink' : 'text-lamp-up'}
                  >
                    {incidencia.resolvedAt === null ? 'ABIERTA' : 'RESUELTA'}
                  </span>
                  <span className="text-ink-dim">
                    {' '}
                    · {formatShortDateTime(incidencia.startedAt)} ·{' '}
                    {formatDuration(incidencia.durationSeconds)}
                    {incidencia.resolvedAt === null ? ' en curso' : ''}
                  </span>
                </p>
                {incidencia.cause !== null ? (
                  <p className="mt-1 font-data text-[13px] text-ink-dim">
                    causa: {incidencia.cause}
                  </p>
                ) : null}
                {incidencia.events.length > 0 ? (
                  <ul className="mt-2 space-y-1">
                    {incidencia.events.map((evento, indice) => (
                      <li
                        key={`${incidencia.id}-${indice}`}
                        className="font-data text-[12px] text-ink-dim"
                      >
                        {formatShortDateTime(evento.happenedAt)} ·{' '}
                        {ETIQUETA_EVENTO[evento.kind] ?? evento.kind}
                        {evento.detail !== null ? ` — ${evento.detail}` : ''}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
        {incidencias.data && incidencias.data.length === 0 ? (
          <Vacio>Ninguna incidencia registrada. Así siga.</Vacio>
        ) : null}
      </Seccion>

      <Certificado monitor={m} />
      <Latido monitor={m} />
      <Publicacion monitor={m} />
    </>
  );
}
