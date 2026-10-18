import type { IncidentSummary, MonitorView, UptimeSummary, WorkspaceSummary } from './types.js';

/** Error de la API de Centinela con su código y el detalle que devolvió. */
export class CentinelaApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    detail: string,
  ) {
    super(`Centinela respondió ${status} en ${path}${detail ? `: ${detail}` : ''}`);
    this.name = 'CentinelaApiError';
  }
}

export interface ApiClient {
  listWorkspaces(): Promise<WorkspaceSummary[]>;
  listMonitors(workspaceId: string): Promise<MonitorView[]>;
  getMonitor(id: string): Promise<MonitorView>;
  getUptime(id: string, window: '24h' | '7d' | '30d' | '90d'): Promise<UptimeSummary>;
  listIncidents(options?: { workspaceId?: string; limit?: number }): Promise<IncidentSummary[]>;
}

export interface ApiClientOptions {
  baseUrl: string;
  apiKey: string;
  /** Inyectable en pruebas. */
  fetchImpl?: typeof fetch;
}

/** Cliente mínimo de la API de Centinela: autentica con clave y lee JSON. */
export function createApiClient(options: ApiClientOptions): ApiClient {
  const doFetch = options.fetchImpl ?? fetch;
  const base = options.baseUrl.replace(/\/+$/, '');

  async function pedir<T>(path: string): Promise<T> {
    let response: Response;
    try {
      response = await doFetch(`${base}${path}`, {
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          accept: 'application/json',
        },
      });
    } catch (cause) {
      throw new Error(
        `no se pudo hablar con Centinela en ${base}: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      );
    }

    if (!response.ok) {
      const detalle = (await response.text().catch(() => '')).slice(0, 200).trim();
      throw new CentinelaApiError(response.status, path, detalle);
    }

    return (await response.json()) as T;
  }

  return {
    async listWorkspaces() {
      const { workspaces } = await pedir<{ workspaces: WorkspaceSummary[] }>('/api/workspaces');
      return workspaces;
    },

    async listMonitors(workspaceId) {
      const { monitors } = await pedir<{ monitors: MonitorView[] }>(
        `/api/monitors?workspaceId=${encodeURIComponent(workspaceId)}`,
      );
      return monitors;
    },

    getMonitor(id) {
      return pedir<MonitorView>(`/api/monitors/${encodeURIComponent(id)}`);
    },

    getUptime(id, window) {
      return pedir<UptimeSummary>(
        `/api/monitors/${encodeURIComponent(id)}/uptime?window=${encodeURIComponent(window)}`,
      );
    },

    async listIncidents(query = {}) {
      const params = new URLSearchParams();
      if (query.workspaceId) params.set('workspaceId', query.workspaceId);
      if (query.limit !== undefined) params.set('limit', String(query.limit));

      const sufijo = params.size > 0 ? `?${params.toString()}` : '';
      const { incidents } = await pedir<{ incidents: IncidentSummary[] }>(
        `/api/incidents${sufijo}`,
      );
      return incidents;
    },
  };
}
