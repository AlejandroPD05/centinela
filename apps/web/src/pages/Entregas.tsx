import { useState } from 'react';
import { Link } from 'react-router';
import { CampoSelect } from '../components/form';
import { Cabecera, Cargando, ErrorPanel, TD_CLASS, TH_CLASS, Vacio } from '../components/ui';
import { useAuth } from '../lib/auth';
import { formatAgo, formatShortDateTime, formatUntil } from '../lib/format';
import { useDeliveries } from '../lib/queries';
import type { DeliveryKind, DeliveryStatus } from '../lib/types';
import { useNow } from '../lib/useNow';

const AVISO_ETIQUETA: Record<DeliveryKind, string> = {
  down: 'Caída',
  recovered: 'Recuperación',
  ssl: 'Certificado',
};

const ESTADO_ETIQUETA: Record<DeliveryStatus, { texto: string; clase: string }> = {
  pending: { texto: 'EN COLA', clase: 'text-lamp-warn' },
  sent: { texto: 'ENVIADA', clase: 'text-ink-dim' },
  failed: { texto: 'FALLIDA', clase: 'text-hazard-ink' },
};

const TIPO_CANAL: Record<string, string> = {
  discord: 'Discord',
  webhook: 'Webhook',
  email: 'Email',
};

export function EntregasPage() {
  const { workspaceId } = useAuth();
  const [estado, setEstado] = useState('');
  const entregas = useDeliveries(workspaceId, estado);
  const now = useNow(1_000);

  const filas = entregas.data ?? [];

  return (
    <>
      <Cabecera titulo="Entregas">
        <p className="font-data text-[13px] text-ink-dim">
          El registro de avisos: qué salió, por dónde y qué falló por el camino.
        </p>
      </Cabecera>

      <div className="mb-6 max-w-xs">
        <CampoSelect
          etiqueta="Filtrar por estado"
          value={estado}
          onChange={(event) => setEstado(event.target.value)}
        >
          <option value="">Todas</option>
          <option value="pending">En cola</option>
          <option value="sent">Enviadas</option>
          <option value="failed">Fallidas</option>
        </CampoSelect>
      </div>

      {entregas.isPending ? <Cargando>Cargando entregas…</Cargando> : null}
      {entregas.isError ? <ErrorPanel error={entregas.error} /> : null}

      {entregas.isSuccess && filas.length === 0 ? (
        <Vacio>Sin entregas que mostrar. Los avisos aparecerán aquí cuando salten.</Vacio>
      ) : null}

      {filas.length > 0 ? (
        <table className="w-full border-collapse">
          <caption className="sr-only">Entregas de avisos del espacio activo</caption>
          <thead>
            <tr>
              <th scope="col" className={TH_CLASS}>
                Creada
              </th>
              <th scope="col" className={TH_CLASS}>
                Aviso
              </th>
              <th scope="col" className={TH_CLASS}>
                Monitor
              </th>
              <th scope="col" className={TH_CLASS}>
                Canal
              </th>
              <th scope="col" className={TH_CLASS}>
                Estado
              </th>
              <th scope="col" className={`${TH_CLASS} hidden lg:table-cell`}>
                Intentos
              </th>
              <th scope="col" className={`${TH_CLASS} hidden md:table-cell`}>
                Último error
              </th>
              <th scope="col" className={`${TH_CLASS} hidden xl:table-cell`}>
                Siguiente intento
              </th>
            </tr>
          </thead>
          <tbody>
            {filas.map((entrega) => {
              const estadoFila = ESTADO_ETIQUETA[entrega.status];
              return (
                <tr key={entrega.id}>
                  <td className={TD_CLASS}>
                    {formatShortDateTime(entrega.createdAt)}
                    <span className="block text-[12px] text-ink-dim">
                      {formatAgo(entrega.createdAt, now)}
                    </span>
                  </td>
                  <td className={`${TD_CLASS} text-ink-dim`}>{AVISO_ETIQUETA[entrega.kind]}</td>
                  <td className={TD_CLASS}>
                    <Link
                      to={`/monitores/${entrega.monitorId}`}
                      className="text-ink hover:underline hover:underline-offset-2"
                    >
                      {entrega.monitorName}
                    </Link>
                  </td>
                  <td className={`${TD_CLASS} text-ink-dim`}>
                    {entrega.channelName}
                    <span className="block text-[12px] text-ink-dim">
                      {TIPO_CANAL[entrega.channelType] ?? entrega.channelType}
                    </span>
                  </td>
                  <td className={`${TD_CLASS} text-[12px] tracking-[0.08em] uppercase`}>
                    <span className={estadoFila.clase}>{estadoFila.texto}</span>
                    {entrega.sentAt !== null ? (
                      <span className="block text-[12px] text-ink-dim normal-case">
                        {formatAgo(entrega.sentAt, now)}
                      </span>
                    ) : null}
                  </td>
                  <td className={`${TD_CLASS} hidden text-ink-dim lg:table-cell`}>
                    {entrega.attempts}
                  </td>
                  <td
                    className={`${TD_CLASS} hidden max-w-[260px] truncate text-ink-dim md:table-cell`}
                    title={entrega.lastError ?? undefined}
                  >
                    {entrega.lastError ?? '—'}
                  </td>
                  <td className={`${TD_CLASS} hidden text-ink-dim xl:table-cell`}>
                    {entrega.status === 'pending' ? formatUntil(entrega.nextAttemptAt, now) : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}
    </>
  );
}
