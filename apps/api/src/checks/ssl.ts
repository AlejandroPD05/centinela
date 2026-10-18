import { isIP } from 'node:net';
import { connect as tlsConnect, type PeerCertificate } from 'node:tls';
import { CheckTimeoutError, describeCheckError } from './errors.js';
import { assertHostAllowed } from './ssrf.js';

export type SslCheckResult =
  { ok: true; expiresAt: Date; issuer: string | null } | { ok: false; error: string };

export interface SslCheckOptions {
  timeoutMs: number;
  allowPrivateTargets: boolean;
}

/**
 * Lee el certificado TLS del destino sin validarlo: un certificado caducado o
 * autofirmado también es información útil (y es justo lo que hay que avisar).
 * Devuelve la fecha de caducidad y el emisor, o el motivo por el que no se pudo
 * leer. Se conecta a la IP ya validada por la guarda, con SNI del host real.
 */
export async function checkSsl(
  rawHost: string,
  port: number,
  options: SslCheckOptions,
): Promise<SslCheckResult> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, error: `puerto inválido: ${port}` };
  }

  try {
    const addresses = await assertHostAllowed(rawHost, {
      allowPrivateTargets: options.allowPrivateTargets,
    });
    const target = addresses.find((address) => isIP(address) === 4) ?? addresses[0] ?? rawHost;
    const servername = isIP(rawHost) === 0 ? rawHost : undefined;

    const peer = await readPeerCertificate(target, port, servername, options.timeoutMs);
    const expiresAt = new Date(peer.valid_to);

    if (Number.isNaN(expiresAt.getTime())) {
      return { ok: false, error: 'el certificado no expone fecha de caducidad' };
    }

    return { ok: true, expiresAt, issuer: formatIssuer(peer) };
  } catch (error) {
    return { ok: false, error: describeCheckError(error, options.timeoutMs) };
  }
}

function readPeerCertificate(
  host: string,
  port: number,
  servername: string | undefined,
  timeoutMs: number,
): Promise<PeerCertificate> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({
      host,
      port,
      servername,
      rejectUnauthorized: false,
      timeout: timeoutMs,
    });

    socket.once('secureConnect', () => {
      const peer = socket.getPeerCertificate();
      socket.destroy();

      if (!peer || !peer.valid_to) {
        reject(new Error('el destino no presentó un certificado'));
        return;
      }
      resolve(peer);
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

function formatIssuer(peer: PeerCertificate): string | null {
  const issuer = peer.issuer;
  if (!issuer) return null;

  const preferred = issuer.CN ?? issuer.O;
  if (preferred === undefined) return null;
  return Array.isArray(preferred) ? (preferred[0] ?? null) : preferred;
}
