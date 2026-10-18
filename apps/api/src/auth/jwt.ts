import { createHmac, timingSafeEqual } from 'node:crypto';

/** Contenido del token de acceso (JWT HS256) que viaja en cada petición. */
export interface AccessTokenClaims {
  /** Identificador del usuario. */
  sub: string;
  email: string;
  name: string;
  /** Emitido en (segundos UNIX). */
  iat: number;
  /** Caduca en (segundos UNIX). */
  exp: number;
}

export type AccessTokenCheck =
  | { ok: true; claims: AccessTokenClaims }
  | { ok: false; reason: 'malformed' | 'bad-signature' | 'expired' };

const base64url = (value: string | Buffer): string => Buffer.from(value).toString('base64url');

/** Firma HS256 sobre `cabecera.carga`. */
function sign(data: string, secret: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

/**
 * Firma un token de acceso. Es un JWT HS256 de manual en lugar de una
 * dependencia: aquí solo se emiten y verifican tokens propios, con un único
 * algoritmo y sin claves intercambiables.
 */
export function signAccessToken(
  claims: Pick<AccessTokenClaims, 'sub' | 'email' | 'name'>,
  secret: string,
  ttlSeconds: number,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(
    JSON.stringify({ ...claims, iat: nowSeconds, exp: nowSeconds + ttlSeconds }),
  );
  const data = `${header}.${payload}`;

  return `${data}.${sign(data, secret)}`;
}

/** Verifica firma y caducidad. Nunca lanza: devuelve el motivo del fallo. */
export function verifyAccessToken(
  token: string,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): AccessTokenCheck {
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };

  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];

  let header: unknown;
  let payload: unknown;
  try {
    header = JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  // Solo HS256: cualquier otro `alg` (p. ej. `none`) es un intento de confusión.
  if (
    typeof header !== 'object' ||
    header === null ||
    (header as { alg?: unknown }).alg !== 'HS256'
  ) {
    return { ok: false, reason: 'malformed' };
  }

  const expected = Buffer.from(sign(`${headerPart}.${payloadPart}`, secret));
  const provided = Buffer.from(signaturePart);
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    return { ok: false, reason: 'bad-signature' };
  }

  const candidate = payload as Partial<AccessTokenClaims>;
  if (
    typeof candidate.sub !== 'string' ||
    candidate.sub === '' ||
    typeof candidate.email !== 'string' ||
    typeof candidate.name !== 'string' ||
    typeof candidate.iat !== 'number' ||
    typeof candidate.exp !== 'number'
  ) {
    return { ok: false, reason: 'malformed' };
  }

  if (candidate.exp <= nowSeconds) return { ok: false, reason: 'expired' };

  return {
    ok: true,
    claims: {
      sub: candidate.sub,
      email: candidate.email,
      name: candidate.name,
      iat: candidate.iat,
      exp: candidate.exp,
    },
  };
}
