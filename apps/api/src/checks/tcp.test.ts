import { createServer, type Server } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkTcp, type TcpCheckOptions } from './tcp.js';

let server: Server;
let openPort: number;
let closedPort: number;

beforeAll(async () => {
  server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  const address = server.address();
  openPort = typeof address === 'object' && address ? address.port : 0;

  // Puerto efímero que se abre y se cierra al momento: nadie escucha en él.
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const probeAddress = probe.address();
  closedPort = typeof probeAddress === 'object' && probeAddress ? probeAddress.port : 0;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const options = (overrides: Partial<TcpCheckOptions> = {}): TcpCheckOptions => ({
  timeoutMs: 1500,
  degradedLatencyMs: null,
  allowPrivateTargets: true,
  ...overrides,
});

describe('checkTcp', () => {
  it('un puerto que acepta conexiones está arriba', async () => {
    const outcome = await checkTcp('127.0.0.1', openPort, options());

    expect(outcome.status).toBe('up');
    expect(outcome.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('un puerto cerrado es una caída: conexión rechazada', async () => {
    const outcome = await checkTcp('127.0.0.1', closedPort, options());

    expect(outcome.status).toBe('down');
    expect(outcome.error).toContain('rechazada');
  });

  it('un umbral de latencia insuperable deja el servicio degradado', async () => {
    const outcome = await checkTcp('127.0.0.1', openPort, options({ degradedLatencyMs: -1 }));

    expect(outcome.status).toBe('degraded');
  });

  it('con la guarda activa, un destino privado no se toca', async () => {
    const outcome = await checkTcp('127.0.0.1', openPort, options({ allowPrivateTargets: false }));

    expect(outcome.status).toBe('error');
    expect(outcome.error).toContain('bloqueado');
  });

  it('un puerto fuera de rango es un error de configuración', async () => {
    const outcome = await checkTcp('127.0.0.1', 0, options());

    expect(outcome.status).toBe('error');
    expect(outcome.error).toContain('puerto');
  });

  it('un destino mudo agota su tiempo y queda caído', async () => {
    // 192.0.2.1 es TEST-NET-1: no hay nada enrutable ahí.
    const outcome = await checkTcp('192.0.2.1', 81, options({ timeoutMs: 400 }));

    expect(outcome.status).toBe('down');
    expect(outcome.error).toBeTruthy();
  }, 10_000);
});
