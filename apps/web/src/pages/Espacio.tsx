import { useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import { ConfirmBoton } from '../components/confirmar';
import { BotonCopiar } from '../components/copiar';
import { CampoSelect, CampoTexto } from '../components/form';
import {
  Aviso,
  Boton,
  Cabecera,
  Cargando,
  ErrorPanel,
  Seccion,
  TD_CLASS,
  TH_CLASS,
  Vacio,
} from '../components/ui';
import { ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import {
  useAddMember,
  useApiKeys,
  useAudit,
  useCreateApiKey,
  useCreateWorkspace,
  useMembers,
  useRemoveMember,
  useRevokeApiKey,
  useSetMemberRole,
} from '../lib/queries';
import { formatDateTime, formatShortDateTime, shortId } from '../lib/format';
import type { Role } from '../lib/types';

type Pestana = 'miembros' | 'claves' | 'auditoria';

const PESTANAS: Array<{ valor: Pestana; etiqueta: string }> = [
  { valor: 'miembros', etiqueta: 'Miembros' },
  { valor: 'claves', etiqueta: 'Claves de API' },
  { valor: 'auditoria', etiqueta: 'Auditoría' },
];

const ROL_ETIQUETA: Record<Role, string> = {
  admin: 'Administración',
  editor: 'Edición',
  viewer: 'Lectura',
};

function avisoDeError(cause: unknown, porDefecto: string): string {
  return cause instanceof ApiError ? cause.message : porDefecto;
}

/** Alta del primer espacio cuando la cuenta todavía no pertenece a ninguno. */
function CrearEspacio() {
  const { reloadMe, setWorkspaceId } = useAuth();
  const crear = useCreateWorkspace();
  const [nombre, setNombre] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function enviar(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    try {
      const espacio = await crear.mutateAsync(nombre.trim());
      await reloadMe();
      setWorkspaceId(espacio.id);
    } catch (cause) {
      setError(avisoDeError(cause, 'no se pudo crear el espacio'));
    }
  }

  return (
    <form onSubmit={enviar} className="max-w-md space-y-4 border border-line p-5" noValidate>
      <p className="font-data text-[13px] text-ink-dim">
        Sin espacio de trabajo no hay dónde vigilar. Crea el primero: podrás invitar a más gente
        después.
      </p>
      {error ? <Aviso tono="error">{error}</Aviso> : null}
      <CampoTexto
        etiqueta="Nombre del espacio"
        required
        maxLength={80}
        value={nombre}
        onChange={(event) => setNombre(event.target.value)}
      />
      <Boton type="submit" variant="primario" disabled={crear.isPending || nombre.trim() === ''}>
        {crear.isPending ? 'Creando…' : 'Crear espacio'}
      </Boton>
    </form>
  );
}

function Miembros({ workspaceId }: { workspaceId: string }) {
  const { workspace, user, reloadMe } = useAuth();
  const miembros = useMembers(workspaceId);
  const agregar = useAddMember(workspaceId);
  const cambiarRol = useSetMemberRole(workspaceId);
  const quitar = useRemoveMember(workspaceId);

  const [email, setEmail] = useState('');
  const [rol, setRol] = useState<Role>('viewer');
  const [aviso, setAviso] = useState<{ tono: 'ok' | 'error'; texto: string } | null>(null);

  const esAdmin = workspace?.role === 'admin';

  async function invitar(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAviso(null);

    try {
      await agregar.mutateAsync({ email: email.trim(), role: rol });
      setAviso({ tono: 'ok', texto: `${email.trim()} ya forma parte del espacio.` });
      setEmail('');
    } catch (cause) {
      setAviso({ tono: 'error', texto: avisoDeError(cause, 'no se pudo añadir al miembro') });
    }
  }

  return (
    <>
      {esAdmin ? (
        <form
          onSubmit={invitar}
          className="mb-6 grid max-w-2xl gap-4 sm:grid-cols-[1fr_auto_auto] sm:items-end"
          noValidate
        >
          <CampoTexto
            etiqueta="Correo"
            type="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            ayuda="La persona debe tener ya una cuenta en Centinela."
          />
          <CampoSelect
            etiqueta="Rol"
            value={rol}
            onChange={(event) => setRol(event.target.value as Role)}
          >
            <option value="viewer">Lectura</option>
            <option value="editor">Edición</option>
            <option value="admin">Administración</option>
          </CampoSelect>
          <Boton
            type="submit"
            variant="primario"
            disabled={agregar.isPending || email.trim() === ''}
          >
            {agregar.isPending ? 'Añadiendo…' : 'Añadir'}
          </Boton>
        </form>
      ) : null}

      {aviso ? (
        <Aviso tono={aviso.tono} className="mb-4">
          {aviso.texto}
        </Aviso>
      ) : null}

      {miembros.isPending ? <Cargando>Cargando miembros…</Cargando> : null}
      {miembros.isError ? <ErrorPanel error={miembros.error} /> : null}

      {miembros.data ? (
        <table className="w-full border-collapse">
          <caption className="sr-only">Miembros del espacio activo</caption>
          <thead>
            <tr>
              <th scope="col" className={TH_CLASS}>
                Persona
              </th>
              <th scope="col" className={TH_CLASS}>
                Rol
              </th>
              <th scope="col" className={`${TH_CLASS} hidden md:table-cell`}>
                Desde
              </th>
              {esAdmin ? (
                <th scope="col" className={`${TH_CLASS} text-right`}>
                  Acciones
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {miembros.data.map((miembro) => (
              <tr key={miembro.userId}>
                <td className={TD_CLASS}>
                  {miembro.name}
                  <span className="block text-[12px] text-ink-dim">{miembro.email}</span>
                </td>
                <td className={TD_CLASS}>
                  {esAdmin ? (
                    <select
                      value={miembro.role}
                      aria-label={`Rol de ${miembro.name}`}
                      className="border border-line bg-ground px-2 py-1 font-data text-[13px] text-ink outline-none focus:border-ink"
                      disabled={cambiarRol.isPending}
                      onChange={(event) =>
                        cambiarRol.mutate(
                          { userId: miembro.userId, role: event.target.value as Role },
                          {
                            onSuccess: () => {
                              setAviso({
                                tono: 'ok',
                                texto: `Rol de ${miembro.name} actualizado.`,
                              });
                              if (miembro.userId === user?.id) void reloadMe();
                            },
                            onError: (error) =>
                              setAviso({
                                tono: 'error',
                                texto: avisoDeError(error, 'no se pudo cambiar el rol'),
                              }),
                          },
                        )
                      }
                    >
                      <option value="viewer">Lectura</option>
                      <option value="editor">Edición</option>
                      <option value="admin">Administración</option>
                    </select>
                  ) : (
                    <span className="text-ink-dim">{ROL_ETIQUETA[miembro.role]}</span>
                  )}
                </td>
                <td className={`${TD_CLASS} hidden text-ink-dim md:table-cell`}>
                  {miembro.createdAt ? formatShortDateTime(miembro.createdAt) : '—'}
                </td>
                {esAdmin ? (
                  <td className={`${TD_CLASS} text-right`}>
                    <ConfirmBoton
                      etiqueta="Quitar"
                      pregunta="Confirmar"
                      pendiente={quitar.isPending}
                      onConfirm={() =>
                        quitar.mutate(miembro.userId, {
                          onSuccess: () =>
                            setAviso({
                              tono: 'ok',
                              texto: `${miembro.name} ya no está en el espacio.`,
                            }),
                          onError: (error) =>
                            setAviso({
                              tono: 'error',
                              texto: avisoDeError(error, 'no se pudo quitar al miembro'),
                            }),
                        })
                      }
                    />
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </>
  );
}

function Claves() {
  const claves = useApiKeys();
  const crear = useCreateApiKey();
  const revocar = useRevokeApiKey();

  const [nombre, setNombre] = useState('');
  const [caducidad, setCaducidad] = useState('');
  const [nueva, setNueva] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function generar(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setNueva(null);

    try {
      const resultado = await crear.mutateAsync({
        name: nombre.trim(),
        ...(caducidad === '' ? {} : { expiresInDays: Number(caducidad) }),
      });
      setNueva(resultado.key);
      setNombre('');
    } catch (cause) {
      setError(avisoDeError(cause, 'no se pudo crear la clave'));
    }
  }

  return (
    <>
      <p className="mb-6 max-w-2xl font-data text-[13px] text-ink-dim">
        Claves personales para llamar a la API sin navegador. Se muestran una sola vez; de ahí en
        adelante solo queda su prefijo.
      </p>

      <form
        onSubmit={generar}
        className="mb-6 grid max-w-2xl gap-4 sm:grid-cols-[1fr_auto_auto] sm:items-end"
        noValidate
      >
        <CampoTexto
          etiqueta="Nombre"
          required
          maxLength={80}
          placeholder="despliegue-render"
          value={nombre}
          onChange={(event) => setNombre(event.target.value)}
        />
        <CampoSelect
          etiqueta="Caducidad"
          value={caducidad}
          onChange={(event) => setCaducidad(event.target.value)}
        >
          <option value="">Sin caducidad</option>
          <option value="30">30 días</option>
          <option value="90">90 días</option>
          <option value="365">1 año</option>
        </CampoSelect>
        <Boton type="submit" variant="primario" disabled={crear.isPending || nombre.trim() === ''}>
          {crear.isPending ? 'Generando…' : 'Generar clave'}
        </Boton>
      </form>

      {error ? (
        <Aviso tono="error" className="mb-4">
          {error}
        </Aviso>
      ) : null}

      {nueva !== null ? (
        <div className="mb-6">
          <Aviso tono="ok">Clave creada. Cópiala ahora: no volverá a mostrarse.</Aviso>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <code className="border border-line px-2 py-1 font-data text-[12px] break-all">
              {nueva}
            </code>
            <BotonCopiar texto={nueva} />
          </div>
        </div>
      ) : null}

      {claves.isPending ? <Cargando>Cargando claves…</Cargando> : null}
      {claves.isError ? <ErrorPanel error={claves.error} /> : null}

      {claves.data && claves.data.length === 0 ? <Vacio>No tienes claves todavía.</Vacio> : null}

      {claves.data && claves.data.length > 0 ? (
        <table className="w-full border-collapse">
          <caption className="sr-only">Claves de API personales</caption>
          <thead>
            <tr>
              <th scope="col" className={TH_CLASS}>
                Clave
              </th>
              <th scope="col" className={`${TH_CLASS} hidden md:table-cell`}>
                Creada
              </th>
              <th scope="col" className={`${TH_CLASS} hidden lg:table-cell`}>
                Último uso
              </th>
              <th scope="col" className={`${TH_CLASS} hidden md:table-cell`}>
                Caduca
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
            {claves.data.map((clave) => {
              const revocada = clave.revokedAt !== null;
              return (
                <tr key={clave.id}>
                  <td className={TD_CLASS}>
                    {clave.name}
                    <span className="block text-[12px] text-ink-dim">{clave.prefix}…</span>
                  </td>
                  <td className={`${TD_CLASS} hidden text-ink-dim md:table-cell`}>
                    {formatShortDateTime(clave.createdAt)}
                  </td>
                  <td className={`${TD_CLASS} hidden text-ink-dim lg:table-cell`}>
                    {clave.lastUsedAt ? formatDateTime(clave.lastUsedAt) : 'nunca'}
                  </td>
                  <td className={`${TD_CLASS} hidden text-ink-dim md:table-cell`}>
                    {clave.expiresAt ? formatShortDateTime(clave.expiresAt) : 'sin caducidad'}
                  </td>
                  <td className={`${TD_CLASS} text-[12px] tracking-[0.08em] uppercase`}>
                    <span className={revocada ? 'text-hazard-ink' : 'text-lamp-up'}>
                      {revocada ? 'REVOCADA' : 'ACTIVA'}
                    </span>
                  </td>
                  <td className={`${TD_CLASS} text-right`}>
                    {revocada ? (
                      <span className="text-ink-dim">—</span>
                    ) : (
                      <ConfirmBoton
                        etiqueta="Revocar"
                        pregunta="Confirmar"
                        pendiente={revocar.isPending}
                        onConfirm={() => revocar.mutate(clave.id)}
                      />
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

function Auditoria({ workspaceId }: { workspaceId: string }) {
  const { workspace } = useAuth();
  const esAdmin = workspace?.role === 'admin';
  const entradas = useAudit(esAdmin ? workspaceId : null);

  return (
    <>
      <p className="mb-6 max-w-2xl font-data text-[13px] text-ink-dim">
        {esAdmin
          ? 'Todo lo que pasa en el espacio, en orden inverso.'
          : 'Tus acciones en el espacio. La vista completa es cosa de la administración.'}
      </p>

      {entradas.isPending ? <Cargando>Cargando auditoría…</Cargando> : null}
      {entradas.isError ? <ErrorPanel error={entradas.error} /> : null}

      {entradas.data && entradas.data.length === 0 ? (
        <Vacio>Sin movimientos registrados.</Vacio>
      ) : null}

      {entradas.data && entradas.data.length > 0 ? (
        <table className="w-full border-collapse">
          <caption className="sr-only">Registro de auditoría</caption>
          <thead>
            <tr>
              <th scope="col" className={TH_CLASS}>
                Cuándo
              </th>
              <th scope="col" className={TH_CLASS}>
                Acción
              </th>
              <th scope="col" className={`${TH_CLASS} hidden md:table-cell`}>
                Objetivo
              </th>
              <th scope="col" className={`${TH_CLASS} hidden lg:table-cell`}>
                IP
              </th>
              <th scope="col" className={`${TH_CLASS} hidden xl:table-cell`}>
                Detalle
              </th>
            </tr>
          </thead>
          <tbody>
            {entradas.data.map((entrada) => (
              <tr key={entrada.id}>
                <td className={TD_CLASS}>{formatShortDateTime(entrada.createdAt)}</td>
                <td className={TD_CLASS}>
                  <code className="text-[12px]">{entrada.action}</code>
                </td>
                <td className={`${TD_CLASS} hidden text-ink-dim md:table-cell`}>
                  {entrada.targetType ?? '—'}
                  {entrada.targetId !== null ? ` ${shortId(entrada.targetId)}` : ''}
                </td>
                <td className={`${TD_CLASS} hidden text-ink-dim lg:table-cell`}>
                  {entrada.ip ?? '—'}
                </td>
                <td
                  className={`${TD_CLASS} hidden max-w-[280px] truncate text-ink-dim xl:table-cell`}
                  title={entrada.detail ? JSON.stringify(entrada.detail) : undefined}
                >
                  {entrada.detail ? JSON.stringify(entrada.detail) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </>
  );
}

export function EspacioPage() {
  const { workspaces, workspaceId } = useAuth();
  const [params, setParams] = useSearchParams();

  if (workspaces.length === 0) {
    return (
      <>
        <Cabecera titulo="Espacio" />
        <CrearEspacio />
      </>
    );
  }

  const cruda = params.get('pestana');
  const activa: Pestana = cruda === 'claves' || cruda === 'auditoria' ? cruda : 'miembros';

  return (
    <>
      <Cabecera titulo="Espacio" />

      <nav aria-label="Secciones del espacio" className="mb-6 flex flex-wrap gap-1">
        {PESTANAS.map((pestana) => (
          <button
            key={pestana.valor}
            type="button"
            aria-current={activa === pestana.valor ? 'page' : undefined}
            onClick={() => setParams({ pestana: pestana.valor })}
            className={`border px-3 py-1.5 font-data text-[13px] tracking-[0.08em] uppercase transition-colors ${
              activa === pestana.valor
                ? 'border-ink bg-ink text-ground'
                : 'border-line text-ink-dim hover:border-ink hover:text-ink'
            }`}
          >
            {pestana.etiqueta}
          </button>
        ))}
      </nav>

      {workspaceId === null ? (
        <Seccion titulo="Sin espacio">
          <Vacio>No hay espacio activo.</Vacio>
        </Seccion>
      ) : activa === 'miembros' ? (
        <Miembros workspaceId={workspaceId} />
      ) : activa === 'claves' ? (
        <Claves />
      ) : (
        <Auditoria workspaceId={workspaceId} />
      )}
    </>
  );
}
