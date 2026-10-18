import { describe, expect, it, vi } from 'vitest';
import { CentinelaApiError, createApiClient } from './api.js';

function respuestaJson(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

type FetchFalso = ReturnType<
  typeof vi.fn<(url: RequestInfo | URL, init?: RequestInit) => Promise<Response>>
>;

function cliente(fetchImpl: FetchFalso) {
  return createApiClient({
    baseUrl: 'https://centinela.test/',
    apiKey: 'cnt_prueba',
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
}

describe('cliente de la API de Centinela', () => {
  it('lista monitores con clave de API y filtro de espacio', async () => {
    const fetchImpl: FetchFalso = vi.fn(async () => respuestaJson({ monitors: [{ id: 'm1' }] }));
    const api = cliente(fetchImpl);

    const monitores = await api.listMonitors('espacio 1');

    expect(monitores).toHaveLength(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://centinela.test/api/monitors?workspaceId=espacio%201');
    expect(init?.headers).toMatchObject({ authorization: 'Bearer cnt_prueba' });
  });

  it('compone la consulta de uptime con su ventana', async () => {
    const fetchImpl: FetchFalso = vi.fn(async () => respuestaJson({ window: '90d' }));
    const api = cliente(fetchImpl);

    await api.getUptime('m1', '90d');

    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      'https://centinela.test/api/monitors/m1/uptime?window=90d',
    );
  });

  it('compone los filtros de incidencias', async () => {
    const fetchImpl: FetchFalso = vi.fn(async () => respuestaJson({ incidents: [] }));
    const api = cliente(fetchImpl);

    await api.listIncidents({ workspaceId: 'w1', limit: 5 });

    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      'https://centinela.test/api/incidents?workspaceId=w1&limit=5',
    );
  });

  it('convierte los errores de la API en excepciones con contexto', async () => {
    const fetchImpl: FetchFalso = vi.fn(
      async () => new Response('{"error":"no perteneces"}', { status: 403 }),
    );
    const api = cliente(fetchImpl);

    const llamada = api.listWorkspaces();

    await expect(llamada).rejects.toBeInstanceOf(CentinelaApiError);
    await expect(llamada).rejects.toMatchObject({ status: 403, path: '/api/workspaces' });
  });

  it('explica los fallos de red', async () => {
    const fetchImpl: FetchFalso = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED');
    });
    const api = cliente(fetchImpl);

    await expect(api.listWorkspaces()).rejects.toThrow(/no se pudo hablar con Centinela/);
  });
});
