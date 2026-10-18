import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signAccessToken, verifyAccessToken } from './jwt.js';
import { FixedWindowLimiter } from './limiter.js';
import { hashPassword, verifyPassword } from './password.js';
import { API_KEY_PREFIX, generateApiKey, hashToken, randomToken } from './tokens.js';

const SECRET = 'secreto-de-pruebas-con-mas-de-32-caracteres-1234';
const claims = { sub: 'usuario-1', email: 'ana@example.com', name: 'Ana' };

describe('tokens de acceso (JWT HS256)', () => {
  it('van y vuelven con sus reclamos', () => {
    const token = signAccessToken(claims, SECRET, 3_600, 1_000_000);
    const checked = verifyAccessToken(token, SECRET, 1_000_100);

    expect(checked).toEqual({ ok: true, claims: { ...claims, iat: 1_000_000, exp: 1_003_600 } });
  });

  it('caducan justo al llegar la expiración', () => {
    const token = signAccessToken(claims, SECRET, 60, 1_000_000);

    expect(verifyAccessToken(token, SECRET, 1_000_059).ok).toBe(true);
    expect(verifyAccessToken(token, SECRET, 1_000_060)).toEqual({ ok: false, reason: 'expired' });
  });

  it('rechazan firmas y cargas manipuladas', () => {
    const token = signAccessToken(claims, SECRET, 3_600, 1_000);
    const [header, payload, signature] = token.split('.') as [string, string, string];

    expect(verifyAccessToken(`${header}.${payload}.firmafalsa`, SECRET, 1_001)).toEqual({
      ok: false,
      reason: 'bad-signature',
    });

    // Firma válida pero carga cambiada (otro `sub`): la firma ya no cuadra.
    const forged = Buffer.from(
      JSON.stringify({ ...claims, sub: 'otro-usuario', iat: 1_000, exp: 9_999_999 }),
    ).toString('base64url');
    expect(verifyAccessToken(`${header}.${forged}.${signature}`, SECRET, 1_001)).toEqual({
      ok: false,
      reason: 'bad-signature',
    });
  });

  it('rechazan otro secreto', () => {
    const token = signAccessToken(claims, SECRET, 3_600, 1_000);

    expect(verifyAccessToken(token, `${SECRET}-distinto`, 1_001)).toEqual({
      ok: false,
      reason: 'bad-signature',
    });
  });

  it('rechazan malformados y el truco de alg:none', () => {
    expect(verifyAccessToken('no-es-un-jwt', SECRET).ok).toBe(false);
    expect(verifyAccessToken('a.b', SECRET)).toEqual({ ok: false, reason: 'malformed' });

    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ ...claims, iat: 0, exp: 9_999_999_999 })).toString(
      'base64url',
    );

    expect(verifyAccessToken(`${header}.${payload}.`, SECRET)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('rechazan cargas con firma válida pero campos ausentes', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: 'solo-sub' })).toString('base64url');
    const signature = createHmac('sha256', SECRET)
      .update(`${header}.${payload}`)
      .digest('base64url');

    expect(verifyAccessToken(`${header}.${payload}.${signature}`, SECRET)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });
});

describe('hash de contraseñas (scrypt)', () => {
  it('verifica la correcta y rechaza la incorrecta', async () => {
    const stored = await hashPassword('contraseña correcta');

    expect(await verifyPassword('contraseña correcta', stored)).toBe(true);
    expect(await verifyPassword('otra cosa', stored)).toBe(false);
  });

  it('usa sal nueva en cada hash', async () => {
    const a = await hashPassword('misma contraseña');
    const b = await hashPassword('misma contraseña');

    expect(a).not.toBe(b);
    expect(await verifyPassword('misma contraseña', a)).toBe(true);
    expect(await verifyPassword('misma contraseña', b)).toBe(true);
  });

  it('un almacenado corrupto no explota: devuelve false', async () => {
    expect(await verifyPassword('x', 'texto-plano')).toBe(false);
    expect(await verifyPassword('x', 'scrypt$0$8$1$aa$bb')).toBe(false);
    expect(await verifyPassword('x', 'scrypt$16384$8$1$aa$')).toBe(false);
  });
});

describe('claves de API y tokens opacos', () => {
  it('genera la clave con prefijo, huella y prefijo visible', () => {
    const { key, prefix, keyHash } = generateApiKey();

    expect(key.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(key.length).toBeGreaterThan(30);
    expect(prefix).toBe(key.slice(0, 12));
    expect(keyHash).toBe(hashToken(key));
    expect(keyHash).not.toContain(key);
  });

  it('los tokens aleatorios no se repiten y respetan el tamaño', () => {
    const a = randomToken(16);
    const b = randomToken(16);

    expect(a).not.toBe(b);
    expect(Buffer.from(a, 'base64url')).toHaveLength(16);
  });
});

describe('limitador de intentos', () => {
  it('deja pasar hasta el límite y luego bloquea con espera', () => {
    const limiter = new FixedWindowLimiter(3, 60_000);

    expect(limiter.hit('ip:correo', 1_000)).toEqual({ allowed: true, retryAfterSeconds: 0 });
    expect(limiter.hit('ip:correo', 1_001).allowed).toBe(true);
    expect(limiter.hit('ip:correo', 1_002).allowed).toBe(true);
    expect(limiter.hit('ip:correo', 1_003)).toEqual({ allowed: false, retryAfterSeconds: 60 });
  });

  it('reinicia la ventana al vencer', () => {
    const limiter = new FixedWindowLimiter(1, 1_000);

    expect(limiter.hit('k', 0).allowed).toBe(true);
    expect(limiter.hit('k', 500).allowed).toBe(false);
    expect(limiter.hit('k', 1_001).allowed).toBe(true);
  });

  it('`reset` olvida los intentos de una clave', () => {
    const limiter = new FixedWindowLimiter(1, 60_000);

    expect(limiter.hit('k', 0).allowed).toBe(true);
    expect(limiter.hit('k', 1).allowed).toBe(false);
    limiter.reset('k');
    expect(limiter.hit('k', 2).allowed).toBe(true);
  });
});
