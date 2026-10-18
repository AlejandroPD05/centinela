import { useState } from 'react';
import { Link } from 'react-router';
import { Cabecera, Cargando, ErrorPanel, TD_CLASS, TH_CLASS, Vacio } from '../components/ui';
import { useAuth } from '../lib/auth';
import { formatDuration } from '@centinela/shared';
import { formatAgo, formatShortDateTime } from '../lib/format';
import { useIncidents } from '../lib/queries';
import { useNow } from '../lib/useNow';

type Filtro = 'abiertas' | 'todas' | 'resueltas';

const FILTROS: Array<{ valor: Filtro; etiqueta: string }> = [
  { valor: 'abiertas', etiqueta: 'Abiertas' },
  { valor: 'todas', etiqueta: 'Todas' },
  { valor: 'resueltas', etiqueta: 'Resueltas' },
];

export function IncidenciasPage() {
  const { workspaceId } = useAuth();
  const incidencias = useIncidents(workspaceId);
  const now = useNow(1_000);
  const [filtro, setFiltro] = useState<Filtro>('abiertas');

  const todas = incidencias.data ?? [];
  const visibles = todas.filter((incidencia) => {
    if (filtro === 'abiertas') return incidencia.open;
    if (filtro === 'resueltas') return !incidencia.open;
    return true;
  });
  const abiertas = todas.filter((incidencia) => incidencia.open).length;

  return (
    <>
      <Cabecera titulo="Incidencias">
        <p aria-live="polite" className="font-data text-[13px] text-ink-dim">
          {incidencias.isSuccess
            ? `${abiertas} ${abiertas === 1 ? 'abierta' : 'abiertas'} · ${todas.length} en la ventana reciente`
            : 'Consultando el registro…'}
        </p>
      </Cabecera>

      <div role="group" aria-label="Filtrar incidencias" className="mb-6 flex flex-wrap gap-1">
        {FILTROS.map((opcion) => (
          <button
            key={opcion.valor}
            type="button"
            aria-pressed={filtro === opcion.valor}
            onClick={() => setFiltro(opcion.valor)}
            className={`border px-3 py-1.5 font-data text-[13px] tracking-[0.08em] uppercase transition-colors ${
              filtro === opcion.valor
                ? 'border-ink bg-ink text-ground'
                : 'border-line text-ink-dim hover:border-ink hover:text-ink'
            }`}
          >
            {opcion.etiqueta}
          </button>
        ))}
      </div>

      {incidencias.isPending ? <Cargando>Cargando incidencias…</Cargando> : null}
      {incidencias.isError ? <ErrorPanel error={incidencias.error} /> : null}

      {incidencias.isSuccess && visibles.length === 0 ? (
        <Vacio>
          {filtro === 'abiertas' ? 'Nada abierto. Buena señal.' : 'Sin incidencias que mostrar.'}
        </Vacio>
      ) : null}

      {visibles.length > 0 ? (
        <table className="w-full border-collapse">
          <caption className="sr-only">Incidencias del espacio activo</caption>
          <thead>
            <tr>
              <th scope="col" className={TH_CLASS}>
                Estado
              </th>
              <th scope="col" className={TH_CLASS}>
                Monitor
              </th>
              <th scope="col" className={TH_CLASS}>
                Inicio
              </th>
              <th scope="col" className={TH_CLASS}>
                Duración
              </th>
              <th scope="col" className={`${TH_CLASS} hidden md:table-cell`}>
                Causa
              </th>
            </tr>
          </thead>
          <tbody>
            {visibles.map((incidencia) => (
              <tr key={incidencia.id}>
                <td className={`${TD_CLASS} text-[12px] tracking-[0.08em] uppercase`}>
                  <span className={incidencia.open ? 'text-hazard-ink' : 'text-lamp-up'}>
                    {incidencia.open ? 'ABIERTA' : 'RESUELTA'}
                  </span>
                </td>
                <td className={TD_CLASS}>
                  <Link
                    to={`/monitores/${incidencia.monitorId}`}
                    className="text-ink hover:underline hover:underline-offset-2"
                  >
                    {incidencia.monitorName}
                  </Link>
                </td>
                <td className={TD_CLASS}>
                  {formatShortDateTime(incidencia.startedAt)}
                  <span className="block text-[12px] text-ink-dim">
                    {formatAgo(incidencia.startedAt, now)}
                  </span>
                </td>
                <td className={`${TD_CLASS} text-ink-dim`}>
                  {formatDuration(incidencia.durationSeconds)}
                  {incidencia.open ? ' (en curso)' : ''}
                </td>
                <td
                  className={`${TD_CLASS} hidden max-w-[300px] truncate text-ink-dim md:table-cell`}
                  title={incidencia.cause ?? undefined}
                >
                  {incidencia.cause ?? '⸺'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </>
  );
}
