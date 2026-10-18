import { useState, type FormEvent } from 'react';
import { ConfirmBoton } from '../components/confirmar';
import { CampoSelect, CampoTexto } from '../components/form';
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
import { ApiError, mensajeDeIssue } from '../lib/api';
import { useAuth } from '../lib/auth';
import {
  useChannels,
  useCreateChannel,
  useDeleteChannel,
  useTestChannel,
  useUpdateChannel,
} from '../lib/queries';
import type { Channel, ChannelType } from '../lib/types';

const TIPO_ETIQUETA: Record<ChannelType, string> = {
  discord: 'Discord',
  webhook: 'Webhook',
  email: 'Email',
};

const DESTINO_ETIQUETA: Record<ChannelType, string> = {
  discord: 'URL del webhook de Discord',
  webhook: 'URL de destino',
  email: 'Correo de destino',
};

function destinoDe(channel: Channel): string {
  const config = channel.config as Record<string, unknown>;
  const valor =
    channel.type === 'discord'
      ? config.webhookUrl
      : channel.type === 'email'
        ? config.to
        : config.url;
  return typeof valor === 'string' ? valor : '';
}

function configDe(tipo: ChannelType, destino: string): Record<string, unknown> {
  if (tipo === 'discord') return { webhookUrl: destino.trim() };
  if (tipo === 'email') return { to: destino.trim() };
  return { url: destino.trim() };
}

interface Borrador {
  id: string | null;
  tipo: ChannelType;
  nombre: string;
  destino: string;
}

const BORRADOR_VACIO: Borrador = { id: null, tipo: 'discord', nombre: '', destino: '' };

export function CanalesPage() {
  const { workspaceId, workspace } = useAuth();
  const canales = useChannels(workspaceId);
  const crear = useCreateChannel();
  const actualizar = useUpdateChannel();
  const eliminar = useDeleteChannel();
  const probar = useTestChannel();

  const [borrador, setBorrador] = useState<Borrador | null>(null);
  const [errores, setErrores] = useState<Record<string, string>>({});
  const [errorGeneral, setErrorGeneral] = useState<string | null>(null);
  const [pruebas, setPruebas] = useState<Record<string, { tono: 'ok' | 'error'; texto: string }>>(
    {},
  );

  const puedeEditar = workspace !== null && workspace.role !== 'viewer';
  const guardando = crear.isPending || actualizar.isPending;

  function manejarError(cause: unknown) {
    if (cause instanceof ApiError) {
      const mapa: Record<string, string> = {};
      for (const issue of cause.issues) {
        const clave = String(issue.path.filter((parte) => typeof parte === 'string').pop() ?? '');
        if (clave !== '' && mapa[clave] === undefined) mapa[clave] = mensajeDeIssue(issue.message);
      }
      setErrores(mapa);
      setErrorGeneral(cause.issues.length === 0 ? cause.message : 'revisa los campos marcados');
      return;
    }

    setErrorGeneral('no se pudo guardar el canal');
  }

  async function enviar(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!borrador || workspaceId === null) return;

    setErrores({});
    setErrorGeneral(null);

    try {
      if (borrador.id === null) {
        await crear.mutateAsync({
          type: borrador.tipo,
          workspaceId,
          name: borrador.nombre.trim(),
          config: configDe(borrador.tipo, borrador.destino),
        });
      } else {
        await actualizar.mutateAsync({
          id: borrador.id,
          workspaceId,
          name: borrador.nombre.trim(),
          config: configDe(borrador.tipo, borrador.destino),
        });
      }
      setBorrador(null);
    } catch (cause) {
      manejarError(cause);
    }
  }

  return (
    <>
      <Cabecera
        titulo="Canales"
        acciones={
          puedeEditar && borrador === null ? (
            <button
              type="button"
              className={claseBoton('primario')}
              onClick={() => setBorrador(BORRADOR_VACIO)}
            >
              Nuevo canal
            </button>
          ) : null
        }
      >
        <p className="font-data text-[13px] text-ink-dim">
          Por aquí salen los avisos cuando algo se cae, vuelve o su certificado caduca.
        </p>
      </Cabecera>

      {borrador !== null ? (
        <Seccion titulo={borrador.id === null ? 'Nuevo canal' : 'Editar canal'}>
          <form onSubmit={enviar} className="grid gap-4 sm:grid-cols-3" noValidate>
            {errorGeneral ? (
              <div className="sm:col-span-3">
                <Aviso tono="error">{errorGeneral}</Aviso>
              </div>
            ) : null}
            <CampoSelect
              etiqueta="Tipo"
              value={borrador.tipo}
              disabled={borrador.id !== null}
              onChange={(event) =>
                setBorrador({ ...borrador, tipo: event.target.value as ChannelType })
              }
            >
              <option value="discord">Discord</option>
              <option value="webhook">Webhook</option>
              <option value="email">Email</option>
            </CampoSelect>
            <CampoTexto
              etiqueta="Nombre"
              required
              maxLength={80}
              value={borrador.nombre}
              error={errores.name}
              onChange={(event) => setBorrador({ ...borrador, nombre: event.target.value })}
            />
            <CampoTexto
              etiqueta={DESTINO_ETIQUETA[borrador.tipo]}
              type={borrador.tipo === 'email' ? 'email' : 'url'}
              required
              value={borrador.destino}
              error={errores.url ?? errores.webhookUrl ?? errores.to}
              onChange={(event) => setBorrador({ ...borrador, destino: event.target.value })}
            />
            <div className="flex items-center gap-2 sm:col-span-3">
              <button type="submit" className={claseBoton('primario')} disabled={guardando}>
                {guardando ? 'Guardando…' : 'Guardar'}
              </button>
              <button
                type="button"
                className={claseBoton('normal')}
                onClick={() => {
                  setBorrador(null);
                  setErrores({});
                  setErrorGeneral(null);
                }}
              >
                Cancelar
              </button>
            </div>
          </form>
        </Seccion>
      ) : null}

      {canales.isPending ? <Cargando>Cargando los canales…</Cargando> : null}
      {canales.isError ? <ErrorPanel error={canales.error} /> : null}

      {canales.data && canales.data.length === 0 ? (
        <Vacio>
          Sin canales: las incidencias no avisarán a nadie
          {puedeEditar ? '. Crea el primero para estar al tanto.' : '.'}
        </Vacio>
      ) : null}

      {canales.data && canales.data.length > 0 ? (
        <table className="mt-2 w-full border-collapse">
          <caption className="sr-only">Canales de aviso del espacio</caption>
          <thead>
            <tr>
              <th scope="col" className={TH_CLASS}>
                Canal
              </th>
              <th scope="col" className={TH_CLASS}>
                Tipo
              </th>
              <th scope="col" className={`${TH_CLASS} hidden md:table-cell`}>
                Destino
              </th>
              <th scope="col" className={TH_CLASS}>
                Estado
              </th>
              <th scope="col" className={`${TH_CLASS} text-right`}>
                Acciones
              </th>
            </tr>
          </thead>
          <tbody>
            {canales.data.map((canal) => {
              const prueba = pruebas[canal.id];
              return (
                <tr key={canal.id}>
                  <td className={TD_CLASS}>{canal.name}</td>
                  <td className={`${TD_CLASS} text-ink-dim`}>{TIPO_ETIQUETA[canal.type]}</td>
                  <td
                    className={`${TD_CLASS} hidden max-w-[280px] truncate text-ink-dim md:table-cell`}
                    title={destinoDe(canal)}
                  >
                    {destinoDe(canal)}
                  </td>
                  <td className={`${TD_CLASS} text-[12px] tracking-[0.08em] uppercase`}>
                    <span className={canal.enabled ? 'text-lamp-up' : 'text-ink-dim'}>
                      {canal.enabled ? 'ACTIVO' : 'EN PAUSA'}
                    </span>
                    {prueba ? (
                      <span
                        className={`mt-0.5 block normal-case ${prueba.tono === 'ok' ? 'text-lamp-up' : 'text-hazard-ink'}`}
                      >
                        {prueba.texto}
                      </span>
                    ) : null}
                  </td>
                  <td className={`${TD_CLASS} text-right`}>
                    {puedeEditar ? (
                      <div className="flex flex-wrap justify-end gap-1">
                        <button
                          type="button"
                          className={claseBoton('normal', 'px-2 py-1 text-[12px]')}
                          disabled={probar.isPending}
                          onClick={() =>
                            probar.mutate(canal.id, {
                              onSuccess: (resultado) =>
                                setPruebas((prev) => ({
                                  ...prev,
                                  [canal.id]: { tono: 'ok', texto: resultado.message },
                                })),
                              onError: (error) =>
                                setPruebas((prev) => ({
                                  ...prev,
                                  [canal.id]: { tono: 'error', texto: error.message },
                                })),
                            })
                          }
                        >
                          Probar
                        </button>
                        <button
                          type="button"
                          className={claseBoton('normal', 'px-2 py-1 text-[12px]')}
                          disabled={actualizar.isPending}
                          onClick={() =>
                            actualizar.mutate(
                              {
                                id: canal.id,
                                workspaceId: canal.workspaceId,
                                enabled: !canal.enabled,
                              },
                              {
                                onError: (error) =>
                                  setPruebas((prev) => ({
                                    ...prev,
                                    [canal.id]: { tono: 'error', texto: error.message },
                                  })),
                              },
                            )
                          }
                        >
                          {canal.enabled ? 'Pausar' : 'Activar'}
                        </button>
                        <button
                          type="button"
                          className={claseBoton('normal', 'px-2 py-1 text-[12px]')}
                          onClick={() =>
                            setBorrador({
                              id: canal.id,
                              tipo: canal.type,
                              nombre: canal.name,
                              destino: destinoDe(canal),
                            })
                          }
                        >
                          Editar
                        </button>
                        <ConfirmBoton
                          etiqueta="Borrar"
                          pregunta="Confirmar"
                          pendiente={eliminar.isPending}
                          onConfirm={() =>
                            eliminar.mutate(canal.id, {
                              onError: (error) =>
                                setPruebas((prev) => ({
                                  ...prev,
                                  [canal.id]: { tono: 'error', texto: error.message },
                                })),
                            })
                          }
                        />
                      </div>
                    ) : (
                      <span className="text-ink-dim">—</span>
                    )}
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
