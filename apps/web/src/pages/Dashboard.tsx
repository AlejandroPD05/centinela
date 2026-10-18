import { useState } from 'react';
import { Link } from 'react-router';
import { Lampara } from '../components/devices';
import {
  Aviso,
  Cabecera,
  Cargando,
  ErrorPanel,
  TD_CLASS,
  TH_CLASS,
  Vacio,
  claseBoton,
} from '../components/ui';
import { useAuth } from '../lib/auth';
import { formatAgo, formatPercent } from '../lib/format';
import { monitorLabel, monitorTarget, monitorTone, TONE_TEXT } from '../lib/tone';
import { useCheckNow, useMonitors, useUpdateMonitor } from '../lib/queries';
import type { MonitorView } from '../lib/types';
import { useNow } from '../lib/useNow';

function Resumen({ monitors }: { monitors: MonitorView[] }) {
  const cuentas = {
    up: monitors.filter((m) => !m.paused && m.state === 'up').length,
    degraded: monitors.filter((m) => !m.paused && m.state === 'degraded').length,
    down: monitors.filter((m) => !m.paused && m.state === 'down').length,
    paused: monitors.filter((m) => m.paused).length,
    pending: monitors.filter((m) => !m.paused && m.state === 'pending').length,
  };
  const abiertas = monitors.reduce((sum, m) => sum + (m.stats?.openIncidents ?? 0), 0);

  const bloques: Array<{ clave: string; etiqueta: string; valor: number; tono?: string }> = [
    { clave: 'total', etiqueta: 'Servicios', valor: monitors.length },
    { clave: 'up', etiqueta: 'Operativos', valor: cuentas.up, tono: 'text-lamp-up' },
    { clave: 'down', etiqueta: 'Caídos', valor: cuentas.down, tono: 'text-hazard-ink' },
    { clave: 'degraded', etiqueta: 'Degradados', valor: cuentas.degraded, tono: 'text-lamp-warn' },
    { clave: 'paused', etiqueta: 'En pausa', valor: cuentas.paused },
    { clave: 'open', etiqueta: 'Incidencias abiertas', valor: abiertas, tono: 'text-hazard-ink' },
  ];

  return (
    <div className="grid grid-cols-2 border-y border-line sm:grid-cols-3 lg:grid-cols-6">
      {bloques.map((bloque) => (
        <div
          key={bloque.clave}
          className="border-r border-b border-line px-3 py-3 last:border-r-0 sm:border-b-0"
        >
          <p className="font-data text-[12px] tracking-[0.12em] text-ink-dim uppercase">
            {bloque.etiqueta}
          </p>
          <p className={`mt-1 font-display text-[30px] leading-none ${bloque.tono ?? ''}`}>
            {bloque.valor}
          </p>
        </div>
      ))}
    </div>
  );
}

/** Acciones de una fila: pausa, comprobación a demanda y edición. */
function AccionesFila({
  monitor,
  onAviso,
}: {
  monitor: MonitorView;
  onAviso: (tono: 'ok' | 'error', texto: string) => void;
}) {
  const actualizar = useUpdateMonitor(monitor.id);
  const comprobar = useCheckNow();

  return (
    <div className="flex flex-wrap justify-end gap-1">
      <button
        type="button"
        className={claseBoton('normal', 'px-2 py-1 text-[12px]')}
        disabled={actualizar.isPending}
        onClick={() =>
          actualizar.mutate(
            { paused: !monitor.paused },
            {
              onSuccess: () =>
                onAviso(
                  'ok',
                  monitor.paused ? `«${monitor.name}» reanudado.` : `«${monitor.name}» en pausa.`,
                ),
              onError: (error) => onAviso('error', error.message),
            },
          )
        }
      >
        {monitor.paused ? 'Reanudar' : 'Pausar'}
      </button>

      {monitor.type !== 'heartbeat' ? (
        <button
          type="button"
          className={claseBoton('normal', 'px-2 py-1 text-[12px]')}
          disabled={comprobar.isPending || monitor.paused}
          onClick={() =>
            comprobar.mutate(monitor.id, {
              onSuccess: (resultado) => onAviso('ok', resultado.message),
              onError: (error) => onAviso('error', error.message),
            })
          }
        >
          Comprobar
        </button>
      ) : null}

      <Link
        to={`/monitores/${monitor.id}/editar`}
        className={claseBoton('normal', 'px-2 py-1 text-[12px]')}
      >
        Editar
      </Link>
    </div>
  );
}

export function DashboardPage() {
  const { workspaceId, workspaces } = useAuth();
  const monitores = useMonitors(workspaceId);
  const now = useNow(1_000);
  const [aviso, setAviso] = useState<{ tono: 'ok' | 'error'; texto: string } | null>(null);

  if (workspaces.length === 0) {
    return (
      <>
        <Cabecera titulo="Panel" />
        <Aviso tono="aviso">
          Todavía no perteneces a ningún espacio de trabajo.{' '}
          <Link to="/espacio" className="underline underline-offset-2">
            Crea el primero
          </Link>
          .
        </Aviso>
      </>
    );
  }

  const monitors = monitores.data ?? [];

  return (
    <>
      <Cabecera
        titulo="Panel"
        acciones={
          <>
            <button
              type="button"
              className={claseBoton('normal')}
              disabled={monitores.isFetching}
              onClick={() => void monitores.refetch()}
            >
              {monitores.isFetching ? 'Actualizando…' : 'Actualizar'}
            </button>
            <Link to="/monitores/nuevo" className={claseBoton('primario')}>
              Nuevo monitor
            </Link>
          </>
        }
      >
        <p
          aria-live="polite"
          className="flex items-center gap-2 font-data text-[13px] text-ink-dim"
        >
          <Lampara tono={monitores.isError ? 'down' : 'up'} viva />
          <span>
            EN VIVO · refresco cada 10 s
            {monitores.dataUpdatedAt > 0
              ? ` · actualizado ${formatAgo(new Date(monitores.dataUpdatedAt).toISOString(), now)}`
              : ''}
          </span>
        </p>
      </Cabecera>

      {aviso ? (
        <Aviso tono={aviso.tono} className="mb-4">
          {aviso.texto}
        </Aviso>
      ) : null}

      {monitores.isPending ? <Cargando>Cargando la flota…</Cargando> : null}
      {monitores.isError ? <ErrorPanel error={monitores.error} /> : null}

      {monitores.isSuccess ? (
        <>
          <Resumen monitors={monitors} />

          {monitors.length === 0 ? (
            <Vacio>
              Este espacio no vigila nada todavía.{' '}
              <Link to="/monitores/nuevo" className="text-ink underline underline-offset-2">
                Añade el primer monitor
              </Link>
              .
            </Vacio>
          ) : (
            <table className="mt-6 w-full border-collapse">
              <caption className="sr-only">Monitores del espacio activo</caption>
              <thead>
                <tr>
                  <th scope="col" className={TH_CLASS}>
                    Servicio
                  </th>
                  <th scope="col" className={TH_CLASS}>
                    Estado
                  </th>
                  <th scope="col" className={`${TH_CLASS} hidden sm:table-cell`}>
                    Últimas 24 h
                  </th>
                  <th scope="col" className={`${TH_CLASS} hidden lg:table-cell`}>
                    7 días
                  </th>
                  <th scope="col" className={`${TH_CLASS} hidden lg:table-cell`}>
                    Último check
                  </th>
                  <th scope="col" className={TH_CLASS}>
                    Acciones
                  </th>
                </tr>
              </thead>
              <tbody>
                {monitors.map((monitor) => {
                  const tono = monitorTone(monitor);
                  const stats = monitor.stats;
                  const abiertas = stats?.openIncidents ?? 0;

                  return (
                    <tr key={monitor.id}>
                      <td className={TD_CLASS}>
                        <div className="flex items-start gap-3">
                          <span className="mt-1.5">
                            <Lampara tono={tono} viva={tono === 'warn'} />
                          </span>
                          <span>
                            <Link
                              to={`/monitores/${monitor.id}`}
                              className="text-ink hover:underline hover:underline-offset-2"
                            >
                              {monitor.name}
                            </Link>
                            <span className="block text-[12px] text-ink-dim">
                              {monitorTarget(monitor)}
                            </span>
                          </span>
                        </div>
                      </td>
                      <td
                        className={`${TD_CLASS} ${TONE_TEXT[tono]} text-[12px] tracking-[0.08em] uppercase`}
                      >
                        {monitorLabel(monitor)}
                        {abiertas > 0 ? (
                          <span className="mt-0.5 block text-hazard-ink">
                            {abiertas === 1 ? '1 incidencia' : `${abiertas} incidencias`}
                          </span>
                        ) : null}
                      </td>
                      <td className={`${TD_CLASS} hidden sm:table-cell`}>
                        {formatPercent(stats?.day.ratio ?? null)}
                        {stats && stats.day.total > 0 ? (
                          <span className="block text-[12px] text-ink-dim">
                            {stats.day.total} checks
                          </span>
                        ) : null}
                      </td>
                      <td className={`${TD_CLASS} hidden lg:table-cell`}>
                        {formatPercent(stats?.week.ratio ?? null)}
                      </td>
                      <td className={`${TD_CLASS} hidden text-ink-dim lg:table-cell`}>
                        {formatAgo(monitor.lastCheckAt, now)}
                      </td>
                      <td className={`${TD_CLASS} text-right`}>
                        <AccionesFila
                          monitor={monitor}
                          onAviso={(t, texto) => setAviso({ tono: t, texto })}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </>
      ) : null}
    </>
  );
}
