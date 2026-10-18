import type { FastifyInstance } from 'fastify';
import { FixedWindowLimiter } from '../auth/limiter.js';

export interface RateLimitOptions {
  /** Peticiones por minuto y por IP; 0 desactiva el límite. */
  perMinute: number;
  /** Nombre de la superficie, solo para legibilidad del código. */
  scope: string;
  /** Permite desactivarlo en los tests (las suites disparan sin frenos). */
  enabled?: boolean;
}

/**
 * Límite de ventana fija por IP para una superficie. La clave es la IP real
 * (con `trustProxy`, la que deja el proxy de delante) y una conexión SSE
 * cuenta una sola vez: la petición, no cada evento.
 */
export function rateLimit(app: FastifyInstance, options: RateLimitOptions): void {
  if ((options.enabled ?? true) === false || options.perMinute <= 0) return;

  const limiter = new FixedWindowLimiter(options.perMinute);

  app.addHook('onRequest', async (request, reply) => {
    const verdict = limiter.hit(request.ip);
    if (verdict.allowed) return;

    request.log.warn({ ip: request.ip, scope: options.scope }, 'límite de peticiones por IP');
    return reply
      .code(429)
      .header('retry-after', String(verdict.retryAfterSeconds))
      .send({ error: 'demasiadas peticiones; baja el ritmo y vuelve a intentarlo' });
  });
}
