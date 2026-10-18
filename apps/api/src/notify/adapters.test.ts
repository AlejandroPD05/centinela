import { createServer, type Server } from 'node:http';
import type { NotificationPayload } from '@centinela/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sendDelivery, type SendOptions } from './adapters.js';

const payload: NotificationPayload = {
  kind: 'down',
  at: '2026-10-18T10:00:00.000Z',
  monitor: {
    id: 'monitor-1',
    name: 'API de ejemplo',
    slug: 'api-de-ejemplo',
    type: 'http',
    target: 'https://api.ejemplo.test/',
  },
  incident: {
    id: 'incident-1',
    startedAt: '2026-10-18T09:00:00.000Z',
    cause: 'conexión rechazada',
    durationSeconds: null,
  },
  ssl: null,
};

type ServerMode = 'ok-json' | 'ok-discord' | 'fail-500' | 'hang';

describe('sendDelivery', () => {
  let server: Server;
  let baseUrl = '';
  let mode: ServerMode = 'ok-json';
  let received: Array<{
    url: string;
    body: string;
    headers: Record<string, string | string[] | undefined>;
  }> = [];

  beforeAll(async () => {
    server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        received.push({ url: request.url ?? '', body, headers: request.headers });

        if (mode === 'hang') return; // nunca responde: el cliente debe abortar
        if (mode === 'fail-500') {
          response.writeHead(500, { 'content-type': 'text/plain' });
          response.end('boom');
          return;
        }
        if (mode === 'ok-discord') {
          response.writeHead(204);
          response.end();
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"ok":true}');
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const options = (overrides: Partial<SendOptions> = {}): SendOptions => ({
    timeoutMs: 2000,
    allowPrivateTargets: true, // los tests hablan con servidores locales
    ...overrides,
  });

  it('entrega en Discord con el embed del estado', async () => {
    mode = 'ok-discord';
    received = [];

    const result = await sendDelivery(
      { type: 'discord', name: 'equipo', config: { webhookUrl: `${baseUrl}/discord` } },
      payload,
      options(),
    );

    expect(result.ok).toBe(true);

    const body = JSON.parse(received[0]?.body ?? '{}') as {
      content: string;
      embeds: Array<{ color: number; fields: Array<{ name: string }> }>;
    };
    expect(body.content).toContain('CAÍDA');
    expect(body.embeds[0]?.color).toBe(0xe5484d);
    expect(body.embeds[0]?.fields.map((field) => field.name)).toContain('motivo');
  });

  it('entrega en un webhook genérico con resumen legible', async () => {
    mode = 'ok-json';
    received = [];

    const result = await sendDelivery(
      { type: 'webhook', name: 'bandeja', config: { url: `${baseUrl}/hook` } },
      payload,
      options(),
    );

    expect(result.ok).toBe(true);

    const body = JSON.parse(received[0]?.body ?? '{}') as { kind: string; summary: string };
    expect(body.kind).toBe('down');
    expect(body.summary).toContain('API de ejemplo');
  });

  it('traduce un código de error del canal', async () => {
    mode = 'fail-500';

    const result = await sendDelivery(
      { type: 'webhook', name: 'bandeja', config: { url: `${baseUrl}/hook` } },
      payload,
      options(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('500');
  });

  it('el email sin claves de Resend falla con motivo claro', async () => {
    const result = await sendDelivery(
      { type: 'email', name: 'avisos', config: { to: 'ops@ejemplo.test' } },
      payload,
      options(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('RESEND_API_KEY');
  });

  it('el email usa la API de Resend cuando hay claves', async () => {
    mode = 'ok-json';
    received = [];

    const result = await sendDelivery(
      { type: 'email', name: 'avisos', config: { to: 'ops@ejemplo.test' } },
      payload,
      options({
        resendApiKey: 're_test',
        emailFrom: 'Centinela <avisos@ejemplo.test>',
        resendBaseUrl: baseUrl,
      }),
    );

    expect(result.ok).toBe(true);

    const request = received[0];
    expect(request?.url).toBe('/emails');
    expect(request?.headers.authorization).toBe('Bearer re_test');

    const body = JSON.parse(request?.body ?? '{}') as { to: string[]; subject: string };
    expect(body.to).toEqual(['ops@ejemplo.test']);
    expect(body.subject).toContain('CAÍDA');
  });

  it('un canal que no responde agota el tiempo', async () => {
    mode = 'hang';

    const result = await sendDelivery(
      { type: 'webhook', name: 'colgado', config: { url: `${baseUrl}/nunca` } },
      payload,
      options({ timeoutMs: 150 }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('tiempo agotado');
  });
});
