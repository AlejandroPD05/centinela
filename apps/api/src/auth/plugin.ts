import { hasRole, type Role } from '@centinela/shared';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Env } from '../config/env.js';
import type { Database } from '../db/client.js';
import { apiKeys, memberships, users } from '../db/schema.js';
import { verifyAccessToken } from './jwt.js';
import { API_KEY_PREFIX, hashToken } from './tokens.js';

/** Quién llama y cómo se ha identificado. */
export interface AuthContext {
  user: { id: string; email: string; name: string };
  via: 'jwt' | 'api-key';
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

/** PreHandler que exige identificación (token de acceso o clave de API). */
export type Authenticator = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

/**
 * Construye el preHandler de autenticación. Acepta dos credenciales por
 * `Authorization: Bearer`:
 * - Clave de API (`cnt_…`): se busca por huella y se marca su último uso.
 * - Token de acceso (JWT HS256): se verifica firma y caducidad.
 * Los latidos y las rutas públicas no pasan por aquí.
 */
export function createAuthenticator(database: Database, env: Env): Authenticator {
  return async function authenticate(request, reply) {
    const header = request.headers.authorization;
    const token =
      typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : '';

    if (token === '') {
      reply.code(401).send({ error: 'falta el token de acceso (Authorization: Bearer …)' });
      return;
    }

    if (token.startsWith(API_KEY_PREFIX)) {
      const [row] = await database
        .select({ key: apiKeys, user: users })
        .from(apiKeys)
        .innerJoin(users, eq(users.id, apiKeys.userId))
        .where(and(eq(apiKeys.keyHash, hashToken(token)), isNull(apiKeys.revokedAt)))
        .limit(1);

      if (!row) {
        reply.code(401).send({ error: 'clave de API inválida o revocada' });
        return;
      }

      if (row.key.expiresAt !== null && row.key.expiresAt.getTime() <= Date.now()) {
        reply.code(401).send({ error: 'la clave de API ha caducado' });
        return;
      }

      request.auth = {
        user: { id: row.user.id, email: row.user.email, name: row.user.name },
        via: 'api-key',
      };
      await database
        .update(apiKeys)
        .set({ lastUsedAt: new Date() })
        .where(eq(apiKeys.id, row.key.id));
      return;
    }

    const checked = verifyAccessToken(token, env.JWT_SECRET);
    if (!checked.ok) {
      reply.code(401).send({
        error:
          checked.reason === 'expired'
            ? 'el token de acceso ha caducado'
            : 'token de acceso inválido',
      });
      return;
    }

    request.auth = {
      user: { id: checked.claims.sub, email: checked.claims.email, name: checked.claims.name },
      via: 'jwt',
    };
  };
}

/** Usuario de una petición ya autenticada (error de programación si no lo está). */
export function authUser(request: FastifyRequest): AuthContext['user'] {
  if (!request.auth) {
    throw new Error('petición sin autenticar: falta el preHandler `authenticate`');
  }

  return request.auth.user;
}

/** Roles del usuario en cada uno de sus espacios de trabajo. */
export async function workspaceRoles(
  database: Database,
  userId: string,
): Promise<Map<string, Role>> {
  const rows = await database
    .select({ workspaceId: memberships.workspaceId, role: memberships.role })
    .from(memberships)
    .where(eq(memberships.userId, userId));

  return new Map(rows.map((row) => [row.workspaceId, row.role]));
}

/**
 * Exige un rol mínimo dentro de un espacio. Si no se cumple, responde (403) y
 * devuelve `false`: las rutas hacen `if (!(await requireRole(…))) return;`.
 */
export async function requireRole(
  database: Database,
  request: FastifyRequest,
  reply: FastifyReply,
  workspaceId: string,
  minimum: Role,
): Promise<boolean> {
  const auth = request.auth;
  if (!auth) {
    reply.code(401).send({ error: 'falta el token de acceso' });
    return false;
  }

  const [membership] = await database
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.userId, auth.user.id), eq(memberships.workspaceId, workspaceId)));

  if (!membership) {
    reply.code(403).send({ error: 'no perteneces a este espacio de trabajo' });
    return false;
  }

  if (!hasRole(membership.role, minimum)) {
    reply.code(403).send({ error: `permisos insuficientes: hace falta rol ${minimum} o superior` });
    return false;
  }

  return true;
}
