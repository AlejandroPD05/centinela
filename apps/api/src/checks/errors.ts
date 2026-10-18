import { SsrfBlockedError } from './ssrf.js';

/** Marca un check que agotó su tiempo máximo. */
export class CheckTimeoutError extends Error {
  override readonly name = 'CheckTimeoutError';
}

interface ErrnoLike {
  code?: unknown;
  message?: unknown;
  cause?: unknown;
  errors?: unknown[];
}

/** Busca un código errno (ECONNREFUSED…) por la cadena de causas del error. */
function asErrno(error: unknown): { code: string; message: string } | null {
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current !== null && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const candidate = current as ErrnoLike;

    if (typeof candidate.code === 'string') {
      return {
        code: candidate.code,
        message: typeof candidate.message === 'string' ? candidate.message : candidate.code,
      };
    }
    if (Array.isArray(candidate.errors) && candidate.errors.length > 0) {
      current = candidate.errors[0];
      continue;
    }
    current = candidate.cause;
  }

  return null;
}

/** Traduce un fallo del check a un mensaje legible para el operador. */
export function describeCheckError(error: unknown, timeoutMs?: number): string {
  if (error instanceof CheckTimeoutError) {
    return timeoutMs === undefined ? 'tiempo agotado' : `tiempo agotado tras ${timeoutMs} ms`;
  }
  if (error instanceof SsrfBlockedError) return error.message;

  const errno = asErrno(error);
  if (errno) {
    switch (errno.code) {
      case 'ECONNREFUSED':
        return 'conexión rechazada';
      case 'ENOTFOUND':
      case 'EAI_AGAIN':
        return 'el dominio no resuelve (DNS)';
      case 'ECONNRESET':
        return 'conexión cortada por el servidor';
      case 'EHOSTUNREACH':
      case 'ENETUNREACH':
        return 'destino inalcanzable';
      case 'ETIMEDOUT':
        return 'tiempo agotado esperando al destino';
      case 'CERT_HAS_EXPIRED':
        return 'certificado TLS caducado';
      case 'DEPTH_ZERO_SELF_SIGNED_CERT':
      case 'SELF_SIGNED_CERT_IN_CHAIN':
      case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
        return 'certificado TLS no verificable';
      default:
        return `${errno.code}: ${errno.message}`;
    }
  }

  if (error instanceof Error) return error.message;
  return String(error);
}
