import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * Hash de contraseñas con scrypt (recomendado por la propia documentación de
 * Node, sin dependencias nativas). El formato guardado es
 * `scrypt$N$r$p$sal$derivado`, todo en base64.
 */
const PARAMS = { N: 16_384, r: 8, p: 1 } as const;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

function derive(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, options, (error, derived) => {
      if (error) reject(error);
      else resolve(derived);
    });
  });
}

/** Deriva el hash de una contraseña con sal nueva. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await derive(password, salt, KEY_LENGTH, PARAMS);

  return [
    'scrypt',
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

/** Compara una contraseña con el hash guardado, en tiempo constante. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const [, nRaw, rRaw, pRaw, saltRaw, hashRaw] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isInteger(N) || N <= 0 || !Number.isInteger(r) || r <= 0) return false;
  if (!Number.isInteger(p) || p <= 0) return false;

  const salt = Buffer.from(saltRaw, 'base64');
  const expected = Buffer.from(hashRaw, 'base64');
  if (expected.length === 0) return false;

  let derived: Buffer;
  try {
    derived = await derive(password, salt, expected.length, { N, r, p });
  } catch {
    // Parámetros imposibles (N desmedido, sal corrupta): el hash no vale.
    return false;
  }

  return expected.length === derived.length && timingSafeEqual(expected, derived);
}
