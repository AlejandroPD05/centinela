import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiClient } from './api.js';
import {
  emojiEstado,
  etiquetaEstado,
  formatearDuracion,
  formatearFechaHora,
  formatearHace,
  formatearRatio,
} from './format.js';
import type { IncidentSummary, MonitorView, UptimeSummary, WorkspaceSummary } from './types.js';

export interface ToolDeps {
  api: ApiClient;
  config: { workspace?: string };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function mensajeError(error: unknown): string {
  return `No pude consultar Centinela: ${error instanceof Error ? error.message : String(error)}`;
}

function plural(cantidad: number, singular: string, pluralForma: string): string {
  return cantidad === 1 ? `${cantidad} ${singular}` : `${cantidad} ${pluralForma}`;
}

/** Resuelve un espacio por id, slug o nombre; sin referencia devuelve todos. */
async function resolverEspacios(
  api: ApiClient,
  config: ToolDeps['config'],
  referencia?: string,
): Promise<WorkspaceSummary[]> {
  const todos = await api.listWorkspaces();
  const buscado = (referencia ?? config.workspace ?? '').trim().toLowerCase();

  if (buscado === '') {
    if (todos.length === 0) throw new Error('esta cuenta no pertenece a ningún espacio de trabajo');
    return todos;
  }

  const encontrado = todos.find(
    (espacio) =>
      espacio.id.toLowerCase() === buscado ||
      espacio.slug.toLowerCase() === buscado ||
      espacio.name.toLowerCase() === buscado,
  );

  if (!encontrado) {
    const disponibles = todos.map((espacio) => espacio.slug).join(', ') || 'ninguno';
    throw new Error(
      `no encuentro el espacio «${referencia ?? config.workspace}»; hay: ${disponibles}`,
    );
  }

  return [encontrado];
}

function lineaMonitor(monitor: MonitorView): string {
  const partes = [`${emojiEstado(monitor)} ${monitor.name} (${monitor.slug})`];

  if (monitor.paused) {
    partes.push('en pausa');
    return `- ${partes.join(' · ')}`;
  }

  partes.push(`24 h ${formatearRatio(monitor.stats?.day.ratio ?? null)}`);
  partes.push(`7 d ${formatearRatio(monitor.stats?.week.ratio ?? null)}`);

  const abiertas = monitor.stats?.openIncidents ?? 0;
  partes.push(
    abiertas === 0
      ? 'sin incidencias'
      : `${plural(abiertas, 'incidencia abierta', 'incidencias abiertas')}`,
  );

  return `- ${partes.join(' · ')}`;
}

function resumenEspacio(espacio: WorkspaceSummary, monitores: MonitorView[]): string {
  const lineas = [`## ${espacio.name} (${espacio.slug})`];

  if (monitores.length === 0) {
    lineas.push('- Sin monitores.');
    return lineas.join('\n');
  }

  const activos = monitores.filter((monitor) => !monitor.paused);
  const caidos = activos.filter((monitor) => monitor.state === 'down').length;
  const degradados = activos.filter((monitor) => monitor.state === 'degraded').length;
  const abiertas = activos.reduce(
    (total, monitor) => total + (monitor.stats?.openIncidents ?? 0),
    0,
  );

  const titulares = [
    `${plural(activos.length, 'servicio en vigilancia', 'servicios en vigilancia')}`,
    caidos > 0 ? plural(caidos, 'caído', 'caídos') : null,
    degradados > 0 ? plural(degradados, 'degradado', 'degradados') : null,
    abiertas > 0 ? plural(abiertas, 'incidencia abierta', 'incidencias abiertas') : null,
  ].filter((parte): parte is string => parte !== null);

  lineas.push(`_${titulares.join(' · ')}_`, '');
  for (const monitor of monitores) lineas.push(lineaMonitor(monitor));

  return lineas.join('\n');
}

/** Encuentra un monitor por id o por slug/nombre (resolviendo colisiones). */
async function buscarMonitor(
  api: ApiClient,
  config: ToolDeps['config'],
  referencia: string,
  espacio?: string,
): Promise<MonitorView> {
  if (UUID.test(referencia)) return api.getMonitor(referencia);

  const espacios = await resolverEspacios(api, config, espacio);
  const buscado = referencia.trim().toLowerCase();
  const encontrados: Array<{ espacio: WorkspaceSummary; monitor: MonitorView }> = [];

  for (const actual of espacios) {
    for (const monitor of await api.listMonitors(actual.id)) {
      if (monitor.slug.toLowerCase() === buscado || monitor.name.toLowerCase() === buscado) {
        encontrados.push({ espacio: actual, monitor });
      }
    }
  }

  const primero = encontrados[0];
  if (!primero) {
    throw new Error(
      `no encuentro el monitor «${referencia}»; usa estado_de_servicios para ver los disponibles`,
    );
  }

  if (encontrados.length > 1) {
    const opciones = encontrados
      .map((encontrado) => `«${encontrado.monitor.slug}» en «${encontrado.espacio.slug}»`)
      .join(', ');
    throw new Error(
      `«${referencia}» existe en varios espacios (${opciones}); repite con «espacio»`,
    );
  }

  return api.getMonitor(primero.monitor.id);
}

const ms = (valor: number | null) => (valor === null ? '—' : `${valor} ms`);

function detalleMonitor(
  monitor: MonitorView,
  uptime: UptimeSummary,
  nombreEspacio?: string,
): string {
  const objetivo =
    monitor.type === 'http' ? monitor.url : `${monitor.host ?? '?'}:${monitor.port ?? '?'}`;

  const lineas = [
    `# ${monitor.name} (${monitor.slug})`,
    '',
    `- Estado: ${emojiEstado(monitor)} ${etiquetaEstado(monitor)} · ${monitor.type} · ${objetivo ?? '—'}`,
    `- Último check: ${formatearHace(monitor.lastCheckAt)} · próximo: ${formatearFechaHora(monitor.nextCheckAt)} (UTC) · cada ${monitor.intervalSeconds} s`,
    `- Disponibilidad: 24 h ${formatearRatio(monitor.stats?.day.ratio ?? null)} · 7 d ${formatearRatio(monitor.stats?.week.ratio ?? null)} · 90 d ${formatearRatio(uptime.availability)} (${uptime.checks.total.toLocaleString('es-ES')} checks)`,
  ];

  const { p50, p95, p99 } = uptime.latencyMs;
  if (p50 !== null || p95 !== null || p99 !== null) {
    lineas.push(`- Latencia (90 d): p50 ${ms(p50)} · p95 ${ms(p95)} · p99 ${ms(p99)}`);
  }

  if (monitor.ssl) {
    lineas.push(
      monitor.ssl.error
        ? `- Certificado: ⚠️ ${monitor.ssl.error}`
        : `- Certificado: caduca ${monitor.ssl.expiresAt ? formatearFechaHora(monitor.ssl.expiresAt) : '—'}${monitor.ssl.issuer ? ` (${monitor.ssl.issuer})` : ''}`,
    );
  }

  lineas.push(
    `- Visibilidad: ${monitor.isPublic ? 'público' : 'privado'}${nombreEspacio ? ` · espacio «${nombreEspacio}»` : ''}`,
  );

  const abiertas = monitor.stats?.openIncidents ?? 0;
  if (abiertas > 0) {
    lineas.push(
      `- Incidencias abiertas: ${abiertas} (míralas con listar_incidencias con abiertas_solo)`,
    );
  }

  return lineas.join('\n');
}

function lineaIncidente(incidente: IncidentSummary): string {
  const duracion = incidente.open
    ? `abierta desde hace ${formatearDuracion(incidente.durationSeconds)}`
    : `duró ${formatearDuracion(incidente.durationSeconds)}`;

  return `- ${incidente.open ? '🔴' : '✅'} ${incidente.monitorName} (${incidente.monitorSlug}) — ${formatearFechaHora(incidente.startedAt)} (UTC), ${duracion} · ${incidente.cause}`;
}

/** Registra las herramientas de solo lectura del servidor MCP. */
export function registerTools(server: McpServer, deps: ToolDeps): void {
  const { api, config } = deps;

  server.registerTool(
    'estado_de_servicios',
    {
      title: 'Estado de los servicios',
      description:
        'Resumen en vivo de Centinela: cada servicio vigilado con su estado, disponibilidad de 24 h y 7 días, e incidencias abiertas. Sin argumentos cubre todos los espacios accesibles.',
      inputSchema: {
        espacio: z
          .string()
          .optional()
          .describe('Espacio de trabajo por id, slug o nombre; por defecto, todos los accesibles'),
      },
    },
    async ({ espacio }) => {
      try {
        const espacios = await resolverEspacios(api, config, espacio);
        const bloques: string[] = [];
        for (const actual of espacios) {
          bloques.push(resumenEspacio(actual, await api.listMonitors(actual.id)));
        }
        return { content: [{ type: 'text', text: bloques.join('\n\n') }] };
      } catch (error) {
        return { content: [{ type: 'text', text: mensajeError(error) }], isError: true };
      }
    },
  );

  server.registerTool(
    'detalle_de_monitor',
    {
      title: 'Detalle de un monitor',
      description:
        'Ficha completa de un servicio vigilado: estado, disponibilidad de 24 h, 7 y 90 días, percentiles de latencia, certificado e incidencias abiertas. Acepta id o slug.',
      inputSchema: {
        monitor: z.string().min(1).describe('Id o slug del monitor (p. ej. «portfolio»)'),
        espacio: z
          .string()
          .optional()
          .describe('Espacio donde buscarlo (id, slug o nombre); opcional si el slug es único'),
      },
    },
    async ({ monitor, espacio }) => {
      try {
        const encontrado = await buscarMonitor(api, config, monitor, espacio);
        const uptime = await api.getUptime(encontrado.id, '90d');
        return { content: [{ type: 'text', text: detalleMonitor(encontrado, uptime) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: mensajeError(error) }], isError: true };
      }
    },
  );

  server.registerTool(
    'listar_incidencias',
    {
      title: 'Incidencias',
      description:
        'Incidencias de los espacios accesibles, de la más reciente a la más antigua, con causa y duración. Por defecto incluye también las resueltas.',
      inputSchema: {
        espacio: z
          .string()
          .optional()
          .describe('Espacio de trabajo por id, slug o nombre; por defecto, todos los accesibles'),
        abiertas_solo: z
          .boolean()
          .optional()
          .describe('true para ver solo las incidencias sin resolver'),
        limite: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Máximo de incidencias a devolver (10 por defecto)'),
      },
    },
    async ({ espacio, abiertas_solo, limite }) => {
      try {
        const espacios = await resolverEspacios(api, config, espacio);
        const maximo = limite ?? 10;

        const todas: IncidentSummary[] = [];
        for (const actual of espacios) {
          todas.push(...(await api.listIncidents({ workspaceId: actual.id, limit: maximo })));
        }

        const filtradas = (abiertas_solo ? todas.filter((incidente) => incidente.open) : todas)
          .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
          .slice(0, maximo);

        if (filtradas.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: abiertas_solo
                  ? 'No hay incidencias abiertas.'
                  : 'No hay incidencias registradas.',
              },
            ],
          };
        }

        const titulo = abiertas_solo
          ? `# ${plural(filtradas.length, 'incidencia abierta', 'incidencias abiertas')}`
          : `# ${plural(filtradas.length, 'incidencia', 'incidencias')}`;
        const cuerpo = filtradas.map((incidente) => lineaIncidente(incidente)).join('\n');
        return { content: [{ type: 'text', text: `${titulo}\n\n${cuerpo}` }] };
      } catch (error) {
        return { content: [{ type: 'text', text: mensajeError(error) }], isError: true };
      }
    },
  );
}
