import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:tls';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkSsl } from './ssl.js';

const key = readFileSync(new URL('./__fixtures__/tls-key.pem', import.meta.url));
const cert = readFileSync(new URL('./__fixtures__/tls-cert.pem', import.meta.url));

/** Puerto cerrado de verdad: en él no escucha nadie. */
const CLOSED_PORT = 1;

describe('checkSsl', () => {
  let server: Server;
  let tlsPort = 0;

  beforeAll(async () => {
    server = createServer({ key, cert }, (socket) => socket.end());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    tlsPort = typeof address === 'object' && address !== null ? address.port : 0;
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('lee la caducidad y el emisor del certificado', async () => {
    const result = await checkSsl('127.0.0.1', tlsPort, {
      timeoutMs: 2000,
      allowPrivateTargets: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const daysToExpiry = (result.expiresAt.getTime() - Date.now()) / 86_400_000;
    expect(daysToExpiry).toBeGreaterThan(3600);
    expect(result.issuer).toContain('centinela-test');
  });

  it('con la guarda activa no toca destinos privados', async () => {
    const result = await checkSsl('127.0.0.1', tlsPort, {
      timeoutMs: 2000,
      allowPrivateTargets: false,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('bloqueado');
  });

  it('un puerto cerrado devuelve un motivo legible', async () => {
    const result = await checkSsl('127.0.0.1', CLOSED_PORT, {
      timeoutMs: 1500,
      allowPrivateTargets: true,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('rechazada');
  });

  it('rechaza puertos fuera de rango', async () => {
    const result = await checkSsl('127.0.0.1', 70_000, {
      timeoutMs: 1000,
      allowPrivateTargets: true,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('puerto inválido');
  });
});
