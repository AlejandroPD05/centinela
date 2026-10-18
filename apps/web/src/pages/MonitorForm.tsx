import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { CampoCheck, CampoSelect, CampoTexto } from '../components/form';
import { Aviso, Cabecera, Cargando, ErrorPanel, Seccion, claseBoton } from '../components/ui';
import { ApiError, mensajeDeIssue } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useCreateMonitor, useMonitor, useUpdateMonitor } from '../lib/queries';
import type { MonitorCreateInput, MonitorPatchInput, MonitorType } from '../lib/types';

const TIPOS: Array<{ valor: MonitorType; titulo: string; detalle: string }> = [
  { valor: 'http', titulo: 'HTTP(S)', detalle: 'Una URL responde con el código esperado' },
  { valor: 'tcp', titulo: 'TCP', detalle: 'Un puerto acepta conexiones' },
  { valor: 'heartbeat', titulo: 'Latido', detalle: 'Tu tarea avisa; si calla, salta la alerta' },
];

interface Formulario {
  type: MonitorType;
  name: string;
  slug: string;
  url: string;
  method: 'GET' | 'HEAD';
  expectedStatus: string;
  keyword: string;
  degradedLatencyMs: string;
  host: string;
  port: string;
  heartbeatPeriodSeconds: string;
  heartbeatGraceSeconds: string;
  intervalSeconds: string;
  timeoutMs: string;
  confirmFailures: string;
  confirmRecoveries: string;
  isPublic: boolean;
  paused: boolean;
}

const INICIAL: Formulario = {
  type: 'http',
  name: '',
  slug: '',
  url: '',
  method: 'GET',
  expectedStatus: '200',
  keyword: '',
  degradedLatencyMs: '',
  host: '',
  port: '443',
  heartbeatPeriodSeconds: '300',
  heartbeatGraceSeconds: '60',
  intervalSeconds: '300',
  timeoutMs: '10000',
  confirmFailures: '2',
  confirmRecoveries: '1',
  isPublic: false,
  paused: false,
};

function aNumero(valor: string): number {
  return Number.parseInt(valor, 10);
}

function aNumeroONull(valor: string): number | null {
  return valor.trim() === '' ? null : aNumero(valor);
}

/** Alta y edición de un monitor comparten formulario; el tipo manda los campos. */
export function MonitorFormPage({ modo }: { modo: 'crear' | 'editar' }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const { workspaceId, workspace } = useAuth();
  const esEdicion = modo === 'editar';

  const detalle = useMonitor(esEdicion ? id : undefined);
  const crear = useCreateMonitor();
  const actualizar = useUpdateMonitor(id ?? '');

  const [formulario, setFormulario] = useState<Formulario>(INICIAL);
  const [rellenado, setRellenado] = useState(false);
  const [errores, setErrores] = useState<Record<string, string>>({});
  const [errorGeneral, setErrorGeneral] = useState<string | null>(null);

  useEffect(() => {
    if (!esEdicion || rellenado || !detalle.data) return;

    const m = detalle.data;
    setFormulario({
      type: m.type,
      name: m.name,
      slug: m.slug,
      url: m.url ?? '',
      method: m.method ?? 'GET',
      expectedStatus: m.expectedStatus?.toString() ?? '200',
      keyword: m.keyword ?? '',
      degradedLatencyMs: m.degradedLatencyMs?.toString() ?? '',
      host: m.host ?? '',
      port: m.port?.toString() ?? '443',
      heartbeatPeriodSeconds: m.heartbeat?.periodSeconds?.toString() ?? '300',
      heartbeatGraceSeconds: m.heartbeat?.graceSeconds?.toString() ?? '60',
      intervalSeconds: m.intervalSeconds.toString(),
      timeoutMs: m.timeoutMs.toString(),
      confirmFailures: m.confirmFailures.toString(),
      confirmRecoveries: m.confirmRecoveries.toString(),
      isPublic: m.isPublic,
      paused: m.paused,
    });
    setRellenado(true);
  }, [esEdicion, rellenado, detalle.data]);

  function campo<K extends keyof Formulario>(clave: K, valor: Formulario[K]) {
    setFormulario((prev) => ({ ...prev, [clave]: valor }));
  }

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

    setErrorGeneral('no se pudo guardar el monitor');
  }

  async function enviar(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrores({});
    setErrorGeneral(null);

    if (esEdicion) {
      const payload: MonitorPatchInput = {
        name: formulario.name.trim(),
        slug: formulario.slug.trim(),
        isPublic: formulario.isPublic,
        paused: formulario.paused,
        ...(formulario.type === 'heartbeat'
          ? {
              heartbeatPeriodSeconds: aNumero(formulario.heartbeatPeriodSeconds),
              heartbeatGraceSeconds: aNumero(formulario.heartbeatGraceSeconds),
            }
          : {
              intervalSeconds: aNumero(formulario.intervalSeconds),
              timeoutMs: aNumero(formulario.timeoutMs),
              confirmFailures: aNumero(formulario.confirmFailures),
              confirmRecoveries: aNumero(formulario.confirmRecoveries),
            }),
        ...(formulario.type === 'http'
          ? {
              url: formulario.url.trim(),
              method: formulario.method,
              expectedStatus: aNumero(formulario.expectedStatus),
              keyword: formulario.keyword.trim() === '' ? null : formulario.keyword.trim(),
              degradedLatencyMs: aNumeroONull(formulario.degradedLatencyMs),
            }
          : {}),
        ...(formulario.type === 'tcp'
          ? {
              host: formulario.host.trim(),
              port: aNumero(formulario.port),
              degradedLatencyMs: aNumeroONull(formulario.degradedLatencyMs),
            }
          : {}),
      };

      try {
        await actualizar.mutateAsync(payload);
        void navigate(`/monitores/${id}`, { replace: true });
      } catch (cause) {
        manejarError(cause);
      }
      return;
    }

    if (!workspaceId) {
      setErrorGeneral('no hay un espacio activo donde crear el monitor');
      return;
    }

    const payload: MonitorCreateInput = {
      workspaceId,
      type: formulario.type,
      name: formulario.name.trim(),
      ...(formulario.slug.trim() === '' ? {} : { slug: formulario.slug.trim() }),
      intervalSeconds: aNumero(formulario.intervalSeconds),
      timeoutMs: aNumero(formulario.timeoutMs),
      confirmFailures: aNumero(formulario.confirmFailures),
      confirmRecoveries: aNumero(formulario.confirmRecoveries),
      isPublic: formulario.isPublic,
      paused: formulario.paused,
      ...(formulario.type === 'http'
        ? {
            url: formulario.url.trim(),
            method: formulario.method,
            expectedStatus: aNumero(formulario.expectedStatus),
            ...(formulario.keyword.trim() === '' ? {} : { keyword: formulario.keyword.trim() }),
            ...(formulario.degradedLatencyMs.trim() === ''
              ? {}
              : { degradedLatencyMs: aNumero(formulario.degradedLatencyMs) }),
          }
        : {}),
      ...(formulario.type === 'tcp'
        ? {
            host: formulario.host.trim(),
            port: aNumero(formulario.port),
            ...(formulario.degradedLatencyMs.trim() === ''
              ? {}
              : { degradedLatencyMs: aNumero(formulario.degradedLatencyMs) }),
          }
        : {}),
      ...(formulario.type === 'heartbeat'
        ? {
            heartbeatPeriodSeconds: aNumero(formulario.heartbeatPeriodSeconds),
            heartbeatGraceSeconds: aNumero(formulario.heartbeatGraceSeconds),
          }
        : {}),
    };

    try {
      const monitor = await crear.mutateAsync(payload);
      void navigate(`/monitores/${monitor.id}`, { replace: true });
    } catch (cause) {
      manejarError(cause);
    }
  }

  if (esEdicion && detalle.isPending) return <Cargando>Cargando el monitor…</Cargando>;
  if (esEdicion && detalle.isError) return <ErrorPanel error={detalle.error} />;

  if (workspace?.role === 'viewer') {
    return (
      <>
        <Cabecera titulo={esEdicion ? 'Editar monitor' : 'Nuevo monitor'} />
        <Aviso tono="aviso">
          Tu rol en este espacio es de lectura: no puedes crear ni editar monitores.{' '}
          <Link to="/" className="underline underline-offset-2">
            Volver al panel
          </Link>
          .
        </Aviso>
      </>
    );
  }

  const guardando = crear.isPending || actualizar.isPending;

  return (
    <form onSubmit={enviar} noValidate>
      <Cabecera
        titulo={esEdicion ? 'Editar monitor' : 'Nuevo monitor'}
        acciones={
          <>
            <Link to={esEdicion && id ? `/monitores/${id}` : '/'} className={claseBoton('normal')}>
              Cancelar
            </Link>
            <button type="submit" className={claseBoton('primario')} disabled={guardando}>
              {guardando ? 'Guardando…' : 'Guardar'}
            </button>
          </>
        }
      />

      {errorGeneral ? <Aviso tono="error">{errorGeneral}</Aviso> : null}

      {!esEdicion ? (
        <Seccion titulo="Tipo de vigilancia">
          <fieldset>
            <legend className="sr-only">Tipo de vigilancia</legend>
            <div className="grid gap-2 sm:grid-cols-3">
              {TIPOS.map((tipo) => (
                <label key={tipo.valor} className="relative block">
                  <input
                    type="radio"
                    name="tipo"
                    value={tipo.valor}
                    checked={formulario.type === tipo.valor}
                    onChange={() => campo('type', tipo.valor)}
                    className="peer sr-only"
                  />
                  <span className="block cursor-pointer border border-line px-3 py-2 transition-colors hover:border-ink peer-checked:border-ink peer-checked:bg-ink peer-checked:text-ground peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-hazard">
                    <span className="block font-data text-[13px] tracking-[0.08em] uppercase">
                      {tipo.titulo}
                    </span>
                    <span className="mt-0.5 block font-data text-[12px] opacity-70">
                      {tipo.detalle}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        </Seccion>
      ) : null}

      <Seccion titulo="Identidad">
        <div className="grid gap-4 sm:grid-cols-2">
          <CampoTexto
            etiqueta="Nombre"
            required
            maxLength={120}
            value={formulario.name}
            error={errores.name}
            onChange={(event) => campo('name', event.target.value)}
          />
          <CampoTexto
            etiqueta="Slug"
            maxLength={80}
            value={formulario.slug}
            error={errores.slug}
            ayuda="Se usa en la URL pública y el distintivo. Vacío: se genera del nombre."
            onChange={(event) => campo('slug', event.target.value)}
          />
        </div>
        {esEdicion ? (
          <p className="mt-3 font-data text-[12px] text-ink-dim uppercase">
            Tipo:{' '}
            {formulario.type === 'http' ? 'HTTP(S)' : formulario.type === 'tcp' ? 'TCP' : 'Latido'}
          </p>
        ) : null}
      </Seccion>

      {formulario.type === 'http' ? (
        <Seccion titulo="Objetivo">
          <div className="grid gap-4">
            <CampoTexto
              etiqueta="URL"
              type="url"
              required
              placeholder="https://ejemplo.com/salud"
              value={formulario.url}
              error={errores.url}
              onChange={(event) => campo('url', event.target.value)}
            />
            <div className="grid gap-4 sm:grid-cols-3">
              <CampoSelect
                etiqueta="Método"
                value={formulario.method}
                error={errores.method}
                onChange={(event) => campo('method', event.target.value as 'GET' | 'HEAD')}
              >
                <option value="GET">GET</option>
                <option value="HEAD">HEAD</option>
              </CampoSelect>
              <CampoTexto
                etiqueta="Código esperado"
                type="number"
                min={100}
                max={599}
                required
                value={formulario.expectedStatus}
                error={errores.expectedStatus}
                onChange={(event) => campo('expectedStatus', event.target.value)}
              />
              <CampoTexto
                etiqueta="Palabra clave"
                maxLength={200}
                value={formulario.keyword}
                error={errores.keyword}
                ayuda="Debe aparecer en el cuerpo (opcional)."
                onChange={(event) => campo('keyword', event.target.value)}
              />
            </div>
          </div>
        </Seccion>
      ) : null}

      {formulario.type === 'tcp' ? (
        <Seccion titulo="Objetivo">
          <div className="grid gap-4 sm:grid-cols-2">
            <CampoTexto
              etiqueta="Host"
              required
              maxLength={253}
              placeholder="db.ejemplo.com"
              value={formulario.host}
              error={errores.host}
              onChange={(event) => campo('host', event.target.value)}
            />
            <CampoTexto
              etiqueta="Puerto"
              type="number"
              min={1}
              max={65535}
              required
              value={formulario.port}
              error={errores.port}
              onChange={(event) => campo('port', event.target.value)}
            />
          </div>
        </Seccion>
      ) : null}

      {formulario.type === 'heartbeat' ? (
        <Seccion titulo="Latido">
          <div className="grid gap-4 sm:grid-cols-2">
            <CampoTexto
              etiqueta="Periodo (segundos)"
              type="number"
              min={10}
              max={86400}
              required
              value={formulario.heartbeatPeriodSeconds}
              error={errores.heartbeatPeriodSeconds}
              ayuda="Cada cuánto debe llegar un latido."
              onChange={(event) => campo('heartbeatPeriodSeconds', event.target.value)}
            />
            <CampoTexto
              etiqueta="Gracia (segundos)"
              type="number"
              min={0}
              max={86400}
              required
              value={formulario.heartbeatGraceSeconds}
              error={errores.heartbeatGraceSeconds}
              ayuda="Margen extra antes de dar la tarea por caída."
              onChange={(event) => campo('heartbeatGraceSeconds', event.target.value)}
            />
          </div>
        </Seccion>
      ) : null}

      {formulario.type !== 'heartbeat' ? (
        <Seccion titulo="Cadencia">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <CampoTexto
              etiqueta="Cada (segundos)"
              type="number"
              min={30}
              max={86400}
              required
              value={formulario.intervalSeconds}
              error={errores.intervalSeconds}
              onChange={(event) => campo('intervalSeconds', event.target.value)}
            />
            <CampoTexto
              etiqueta="Tiempo límite (ms)"
              type="number"
              min={1000}
              max={60000}
              required
              value={formulario.timeoutMs}
              error={errores.timeoutMs}
              onChange={(event) => campo('timeoutMs', event.target.value)}
            />
            <CampoTexto
              etiqueta="Fallos para caída"
              type="number"
              min={1}
              max={10}
              required
              value={formulario.confirmFailures}
              error={errores.confirmFailures}
              onChange={(event) => campo('confirmFailures', event.target.value)}
            />
            <CampoTexto
              etiqueta="Aciertos para volver"
              type="number"
              min={1}
              max={10}
              required
              value={formulario.confirmRecoveries}
              error={errores.confirmRecoveries}
              onChange={(event) => campo('confirmRecoveries', event.target.value)}
            />
          </div>
        </Seccion>
      ) : (
        <Seccion titulo="Confirmación">
          <div className="grid gap-4 sm:grid-cols-2">
            <CampoTexto
              etiqueta="Latidos perdidos para caída"
              type="number"
              min={1}
              max={10}
              required
              value={formulario.confirmFailures}
              error={errores.confirmFailures}
              onChange={(event) => campo('confirmFailures', event.target.value)}
            />
            <CampoTexto
              etiqueta="Aciertos para volver"
              type="number"
              min={1}
              max={10}
              required
              value={formulario.confirmRecoveries}
              error={errores.confirmRecoveries}
              onChange={(event) => campo('confirmRecoveries', event.target.value)}
            />
          </div>
        </Seccion>
      )}

      {formulario.type !== 'heartbeat' ? (
        <Seccion titulo="Umbral de degradado">
          <CampoTexto
            etiqueta="Latencia a partir de la cual degrada (ms)"
            type="number"
            min={1}
            max={60000}
            value={formulario.degradedLatencyMs}
            error={errores.degradedLatencyMs}
            ayuda="Vacío: solo se degrada si el objetivo lo decide (o nunca)."
            onChange={(event) => campo('degradedLatencyMs', event.target.value)}
          />
        </Seccion>
      ) : null}

      <Seccion titulo="Publicación">
        <div className="space-y-3">
          <CampoCheck
            etiqueta="Publicar en la status page"
            ayuda="Aparecerá en la página pública del espacio y su distintivo será visible."
            checked={formulario.isPublic}
            onChange={(event) => campo('isPublic', event.target.checked)}
          />
          <CampoCheck
            etiqueta={esEdicion ? 'En pausa (no comprobar)' : 'Crear en pausa'}
            ayuda="Un monitor en pausa no lanza checks ni avisos."
            checked={formulario.paused}
            onChange={(event) => campo('paused', event.target.checked)}
          />
        </div>
      </Seccion>

      <div className="mt-8 flex flex-wrap items-center gap-2 border-t border-line pt-4">
        <button type="submit" className={claseBoton('primario')} disabled={guardando}>
          {guardando ? 'Guardando…' : esEdicion ? 'Guardar cambios' : 'Crear monitor'}
        </button>
        <Link to={esEdicion && id ? `/monitores/${id}` : '/'} className={claseBoton('normal')}>
          Cancelar
        </Link>
      </div>
    </form>
  );
}
