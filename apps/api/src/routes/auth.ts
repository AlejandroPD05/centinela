import { and, asc, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { recordAudit } from '../audit/record.js';
import { signAccessToken } from '../auth/jwt.js';
import { FixedWindowLimiter } from '../auth/limiter.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { authUser, type Authenticator } from '../auth/plugin.js';
import { hashToken, randomToken } from '../auth/tokens.js';
import type { Env } from '../config/env.js';
import type { Database } from '../db/client.js';
import { memberships, sessions, users, workspaces } from '../db/schema.js';

const loginSchema = z.object({
  email: z.email(),
  password: z.string().min(1).max(200),
});
const refreshSchema = z.object({ refreshToken: z.string().min(20).max(200) });

/** Proyección pública de un usuario (nunca sale el hash de su contraseña). */
function userView(user: { id: string; email: string; name: string }) {
  return { id: user.id, email: user.email, name: user.name };
}

/**
 * Accesos: inicio y cierre de sesión, rotación del token de refresco y
 * `me` (quién soy y qué espacios tengo). Los tokens de acceso son JWT cortos;
 * los de refresco, opacos y guardados por huella en `sessions`.
 */
export function authRoutes(
  app: FastifyInstance,
  database: Database,
  env: Env,
  authenticate: Authenticator,
): void {
  const limiter = new FixedWindowLimiter(env.LOGIN_ATTEMPTS_PER_MINUTE);

  // Hash señuelo: verificar contra él cuando el usuario no existe iguala los
  // tiempos de respuesta y evita enumerar correos por cronómetro.
  let dummyHash: Promise<string> | null = null;
  const dummyPasswordHash = () => (dummyHash ??= hashPassword(randomToken(24)));

  const refreshExpiry = () => new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86_400_000);

  app.post('/auth/login', async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'petición inválida', issues: parsed.error.issues });
    }

    const email = parsed.data.email.trim().toLowerCase();
    const limiterKey = `${request.ip}:${email}`;
    const verdict = limiter.hit(limiterKey);
    if (!verdict.allowed) {
      return reply
        .code(429)
        .header('retry-after', String(verdict.retryAfterSeconds))
        .send({ error: `demasiados intentos; prueba de nuevo en ${verdict.retryAfterSeconds} s` });
    }

    const [user] = await database.select().from(users).where(eq(users.email, email));
    const valid = await verifyPassword(
      parsed.data.password,
      user?.passwordHash ?? (await dummyPasswordHash()),
    );

    if (!user || !valid) {
      await recordAudit(database, {
        userId: user?.id ?? null,
        action: 'auth.login_failed',
        detail: { email },
        ip: request.ip,
      });
      return reply.code(401).send({ error: 'credenciales incorrectas' });
    }

    limiter.reset(limiterKey);

    const refreshToken = randomToken(32);
    await database.insert(sessions).values({
      userId: user.id,
      tokenHash: hashToken(refreshToken),
      userAgent: request.headers['user-agent'] ?? null,
      ip: request.ip,
      expiresAt: refreshExpiry(),
    });

    await recordAudit(database, { userId: user.id, action: 'auth.login', ip: request.ip });

    return reply.send({
      accessToken: signAccessToken(
        { sub: user.id, email: user.email, name: user.name },
        env.JWT_SECRET,
        env.ACCESS_TOKEN_TTL_SECONDS,
      ),
      expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
      refreshToken,
      user: userView(user),
    });
  });

  app.post('/auth/refresh', async (request, reply) => {
    const parsed = refreshSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'falta el token de refresco' });
    }

    const [session] = await database
      .select()
      .from(sessions)
      .where(eq(sessions.tokenHash, hashToken(parsed.data.refreshToken)));

    if (!session || session.revokedAt !== null || session.expiresAt.getTime() <= Date.now()) {
      return reply.code(401).send({ error: 'sesión caducada; vuelve a iniciar sesión' });
    }

    const [user] = await database.select().from(users).where(eq(users.id, session.userId));
    if (!user) {
      return reply.code(401).send({ error: 'sesión caducada; vuelve a iniciar sesión' });
    }

    // Rotación: la sesión usada se revoca y nace otra con un token nuevo.
    const refreshToken = randomToken(32);
    await database.transaction(async (tx) => {
      await tx.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, session.id));
      await tx.insert(sessions).values({
        userId: user.id,
        tokenHash: hashToken(refreshToken),
        userAgent: request.headers['user-agent'] ?? null,
        ip: request.ip,
        expiresAt: refreshExpiry(),
      });
    });

    return reply.send({
      accessToken: signAccessToken(
        { sub: user.id, email: user.email, name: user.name },
        env.JWT_SECRET,
        env.ACCESS_TOKEN_TTL_SECONDS,
      ),
      expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
      refreshToken,
      user: userView(user),
    });
  });

  app.post('/auth/logout', async (request, reply) => {
    const parsed = refreshSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'falta el token de refresco' });
    }

    const [session] = await database
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.tokenHash, hashToken(parsed.data.refreshToken)),
          isNull(sessions.revokedAt),
        ),
      );

    if (session) {
      await database
        .update(sessions)
        .set({ revokedAt: new Date() })
        .where(eq(sessions.id, session.id));
      await recordAudit(database, {
        userId: session.userId,
        action: 'auth.logout',
        ip: request.ip,
      });
    }

    // Idempotente: cerrar una sesión ya cerrada también es un 204.
    return reply.code(204).send();
  });

  app.get('/auth/me', { preHandler: authenticate }, async (request) => {
    const user = authUser(request);

    const spaces = await database
      .select({
        id: workspaces.id,
        name: workspaces.name,
        slug: workspaces.slug,
        role: memberships.role,
      })
      .from(memberships)
      .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
      .where(eq(memberships.userId, user.id))
      .orderBy(asc(workspaces.name));

    return { user, workspaces: spaces };
  });
}
