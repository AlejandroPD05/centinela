import { connect, isIP } from 'node:net';
import { CheckTimeoutError, describeCheckError } from './errors.js';
import { assertHostAllowed, SsrfBlockedError } from './ssrf.js';
import type { CheckOutcome } from './types.js';

export interface TcpCheckOptions {
  timeoutMs: number;
  degradedLatencyMs: number | null;
  allowPrivateTargets: boolean;
}

/**
 * Ejecuta un check TCP: resuelve y valida el host con la guarda SSRF y mide
 * el tiempo hasta establecer la conexión. Se conecta a la IP ya validada para
 * que la resolución no pueda cambiar entre la comprobación y el uso.
 */
export async function checkTcp(
  rawHost: string,
  port: number,
  options: TcpCheckOptions,
): Promise<CheckOutcome> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { status: 'error', latencyMs: 0, error: `puerto inválido: ${port}` };
  }

  const startedAt = performance.now();

  try {
    const addresses = await assertHostAllowed(rawHost, {
      allowPrivateTargets: options.allowPrivateTargets,
    });
    const target = pickTarget(rawHost, addresses);

    await connectOnce(target, port, options.timeoutMs);

    const latencyMs = Math.round(performance.now() - startedAt);
    const degraded = options.degradedLatencyMs !== null && latencyMs > options.degradedLatencyMs;

    return { status: degraded ? 'degraded' : 'up', latencyMs };
  } catch (error) {
    const latencyMs = Math.round(performance.now() - startedAt);

    if (error instanceof SsrfBlockedError) {
      return { status: 'error', latencyMs, error: describeCheckError(error) };
    }
    return { status: 'down', latencyMs, error: describeCheckError(error, options.timeoutMs) };
  }
}

/** Prefiere IPv4 para conectarse; si no hay direcciones resueltas, usa el host. */
function pickTarget(host: string, addresses: string[]): string {
  const ipv4 = addresses.find((address) => isIP(address) === 4);
  return ipv4 ?? addresses[0] ?? host;
}

function connectOnce(host: string, port: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    socket.setTimeout(timeoutMs);

    socket.once('connect', () => {
      socket.destroy();
      resolve();
    });
    socket.once('timeout', () => {
      socket.destroy();
      reject(new CheckTimeoutError());
    });
    socket.once('error', (error) => {
      socket.destroy();
      reject(error);
    });
  });
}
