import { createHash, randomBytes } from 'node:crypto';

/** Token opaco aleatorio en base64url (sin relleno). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Huella con la que se guardan los tokens en la base de datos (nunca el token). */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Prefijo de las claves de API: `cnt_…`. */
export const API_KEY_PREFIX = 'cnt_';

/** Genera una clave de API: el token, su prefijo visible y su huella. */
export function generateApiKey(): { key: string; prefix: string; keyHash: string } {
  const key = `${API_KEY_PREFIX}${randomToken(24)}`;
  return { key, prefix: key.slice(0, 12), keyHash: hashToken(key) };
}

/** Prefijo de los tokens de latido de los monitores heartbeat: `hb_…`. */
export const HEARTBEAT_TOKEN_PREFIX = 'hb_';

/** Genera el token de un monitor heartbeat. */
export function generateHeartbeatToken(): string {
  return `${HEARTBEAT_TOKEN_PREFIX}${randomToken(18)}`;
}
