import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';
import type { ApiClient } from './api.js';
import { registerTools } from './tools.js';
import type { IncidentSummary, MonitorView, UptimeSummary, WorkspaceSummary } from './types.js';

const ESPACIO: WorkspaceSummary = { id: 'w1', name: 'Centinela Demo', slug: 'demo', role: 'admin' };

const MONITOR_UP: MonitorView = {
  id: 'm1',
  workspaceId: 'w1',
  name: 'Portfolio y proyectos',
  slug: 'portfolio',
  type: 'http',
  url: 'https://example.com',
  host: null,
  port: null,
  state: 'up',
  isPublic: true,
  paused: false,
  intervalSeconds: 300,
  timeoutMs: 10_000,
  lastCheckAt: '2026-10-18T15:00:00.000Z',
  nextCheckAt: '2026-10-18T15:05:00.000Z',
  ssl: null,
  stats: {
    day: { total: 288, available: 288, ratio: 1 },
    week: { total: 2016, available: 2014, ratio: 0.999 },
    openIncidents: 0,
  },
};

const MONITOR_DOWN: MonitorView = {
  ...MONITOR_UP,
  id: 'm2',
  name: 'Panel de automatización',
  slug: 'n8n',
  url: 'https://api.invalid',
  state: 'down',
  ssl: {
    expiresAt: '2027-01-06T00:00:00.000Z',
    checkedAt: '2026-10-18T15:00:00.000Z',
    issuer: 'R11',
    error: null,
  },
  stats: {
    day: { total: 288, available: 0, ratio: 0 },
    week: { total: 2016, available: 100, ratio: 0.0496 },
    openIncidents: 1,
  },
};

const UPTIME: UptimeSummary = {
  window: '90d',
  since: '2026-07-20T00:00:00.000Z',
  checks: { total: 25_921, available: 25_921, failed: 0 },
  availability: 0.9986,
  latencyMs: { p50: 180, p95: 420, p99: 810 },
};

const ABIERTA: IncidentSummary = {
  id: 'i1',
  monitorId: 'm2',
  monitorName: 'Panel de automatización',
  monitorSlug: 'n8n',
  workspaceId: 'w1',
  startedAt: '2026-10-12T09:00:00.000Z',
  resolvedAt: null,
  durationSeconds: 547_200,
  cause: 'el dominio no resuelve (DNS)',
  open: true,
};

const CERRADA: IncidentSummary = {
  ...ABIERTA,
  id: 'i2',
  startedAt: '2026-10-06T11:00:00.000Z',
  resolvedAt: '2026-10-06T11:22:00.000Z',
  durationSeconds: 1320,
  open: false,
};

function apiFalsa(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    listWorkspaces: async () => [ESPACIO],
    listMonitors: async () => [MONITOR_UP, MONITOR_DOWN],
    getMonitor: async () => MONITOR_DOWN,
    getUptime: async () => UPTIME,
    listIncidents: async () => [ABIERTA, CERRADA],
    ...overrides,
  };
}

async function conectar(api: ApiClient) {
  const server = new McpServer({ name: 'centinela', version: '0.0.0' });
  registerTools(server, { api, config: {} });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'prueba', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    async cerrar() {
      await client.close();
      await server.close();
    },
  };
}

type Resultado = Awaited<ReturnType<Client['callTool']>>;

function textoDe(resultado: Resultado): string {
  return resultado.content.map((parte) => ('text' in parte ? (parte.text ?? '') : '')).join('\n');
}

describe('herramientas MCP de Centinela', () => {
  it('expone las tres herramientas de lectura', async () => {
    const { client, cerrar } = await conectar(apiFalsa());
    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual([
        'detalle_de_monitor',
        'estado_de_servicios',
        'listar_incidencias',
      ]);
    } finally {
      await cerrar();
    }
  });

  it('resume el estado de los servicios con titulares y semáforos', async () => {
    const { client, cerrar } = await conectar(apiFalsa());
    try {
      const resultado = await client.callTool({ name: 'estado_de_servicios', arguments: {} });
      const texto = textoDe(resultado);

      expect(resultado.isError).toBeFalsy();
      expect(texto).toContain('Centinela Demo (demo)');
      expect(texto).toContain('2 servicios en vigilancia');
      expect(texto).toContain('1 caído');
      expect(texto).toContain('🟢 Portfolio y proyectos (portfolio)');
      expect(texto).toContain('🔴 Panel de automatización (n8n)');
      expect(texto).toContain('24 h 100 %');
    } finally {
      await cerrar();
    }
  });

  it('detalla un monitor por su slug, con percentiles y certificado', async () => {
    const { client, cerrar } = await conectar(apiFalsa());
    try {
      const resultado = await client.callTool({
        name: 'detalle_de_monitor',
        arguments: { monitor: 'n8n' },
      });
      const texto = textoDe(resultado);

      expect(resultado.isError).toBeFalsy();
      expect(texto).toContain('# Panel de automatización (n8n)');
      expect(texto).toContain('🔴 down');
      expect(texto).toContain('90 d 99,9 %');
      expect(texto).toContain('p50 180 ms · p95 420 ms · p99 810 ms');
      expect(texto).toContain('Certificado: caduca');
    } finally {
      await cerrar();
    }
  });

  it('filtra las incidencias abiertas y ordena por recencia', async () => {
    const { client, cerrar } = await conectar(apiFalsa());
    try {
      const abiertas = await client.callTool({
        name: 'listar_incidencias',
        arguments: { abiertas_solo: true },
      });
      const texto = textoDe(abiertas);

      expect(texto).toContain('1 incidencia abierta');
      expect(texto).toContain('🔴 Panel de automatización (n8n)');
      expect(texto).not.toContain('✅');

      const todas = textoDe(await client.callTool({ name: 'listar_incidencias', arguments: {} }));
      expect(todas).toContain('2 incidencias');
      expect(todas).toContain('✅');
      expect(todas).toContain('duró 22 min');
    } finally {
      await cerrar();
    }
  });

  it('traduce los fallos de la API en un resultado de error', async () => {
    const { client, cerrar } = await conectar(
      apiFalsa({
        listWorkspaces: async () => {
          throw new Error('Centinela respondió 500 en /api/workspaces');
        },
      }),
    );
    try {
      const resultado = await client.callTool({ name: 'estado_de_servicios', arguments: {} });

      expect(resultado.isError).toBe(true);
      expect(textoDe(resultado)).toContain('No pude consultar Centinela');
      expect(textoDe(resultado)).toContain('500');
    } finally {
      await cerrar();
    }
  });

  it('avisa cuando el espacio pedido no existe', async () => {
    const { client, cerrar } = await conectar(apiFalsa());
    try {
      const resultado = await client.callTool({
        name: 'estado_de_servicios',
        arguments: { espacio: 'no-existe' },
      });

      expect(resultado.isError).toBe(true);
      expect(textoDe(resultado)).toContain('no encuentro el espacio');
      expect(textoDe(resultado)).toContain('demo');
    } finally {
      await cerrar();
    }
  });
});
